
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
} from "@pixiv/three-vrm";

type Emotion = "neutral" | "happy" | "relaxed" | "surprised" | "sad";

type BonePose = {
  node: THREE.Object3D;
  x: number;
  y: number;
  z: number;
};

const EMOTIONS: Emotion[] = [
  "neutral",
  "happy",
  "relaxed",
  "surprised",
  "sad",
];

const EXPRESSION_NAMES = [
  "happy",
  "relaxed",
  "surprised",
  "sad",
  "angry",
] as const;

const EXPRESSION_WEIGHTS: Record<Emotion, Record<string, number>> = {
  neutral: {},
  happy: { happy: 0.9 },
  relaxed: { relaxed: 0.8, happy: 0.15 },
  surprised: { surprised: 0.85 },
  sad: { sad: 0.8 },
};

export default function VRMViewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading Furina...");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frameId = 0;
    let vrm: VRM | null = null;
    let previousTime = 0;
    let lastEmotionChange = 0;
    let currentEmotion: Emotion = "happy";
    let externalEmotionRequested = false;

    // Expressions are eased toward their targets each frame.
    const targetExpressions: Record<string, number> = {};
    const currentExpressions: Record<string, number> = {};

    for (const name of EXPRESSION_NAMES) {
      targetExpressions[name] = 0;
      currentExpressions[name] = 0;
    }

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.25, 3.2);
    camera.lookAt(0, 1.15, 0);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;

    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(1, 2, 3);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x9bdcff, 1.1);
    fillLight.position.set(-2, 1, -1);
    scene.add(fillLight);

    const resize = () => {
      if (disposed) return;

      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);

      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const bonePoses: Partial<Record<string, BonePose>> = {};

    const captureBone = (
      humanoid: VRM["humanoid"],
      name: string,
    ) => {
      const node = humanoid.getNormalizedBoneNode(
        name as Parameters<typeof humanoid.getNormalizedBoneNode>[0],
      );

      if (!node) return;

      bonePoses[name] = {
        node,
        x: node.rotation.x,
        y: node.rotation.y,
        z: node.rotation.z,
      };
    };

    const setEmotion = (emotion: Emotion) => {
      currentEmotion = emotion;

      const weights = EXPRESSION_WEIGHTS[emotion];

      for (const name of EXPRESSION_NAMES) {
        targetExpressions[name] = weights[name] ?? 0;
      }
    };

    const handleEmotion = (event: Event) => {
      const emotion = (event as CustomEvent<string>).detail;

      if (EMOTIONS.includes(emotion as Emotion)) {
        // A real app request takes priority over the demo emotion cycle.
        externalEmotionRequested = true;
        setEmotion(emotion as Emotion);
        lastEmotionChange = performance.now() / 1000;
      }
    };

    window.addEventListener("fufuu:emotion", handleEmotion);

    loader.load(
      "/models/furina.vrm",
      (gltf) => {
        if (disposed) {
          const abandonedVrm = gltf.userData.vrm as VRM | undefined;
          if (abandonedVrm) VRMUtils.deepDispose(abandonedVrm.scene);
          return;
        }

        const loadedVrm = gltf.userData.vrm as VRM | undefined;

        if (!loadedVrm) {
          setFailed(true);
          setStatus("This file did not contain a readable VRM avatar.");
          return;
        }

        vrm = loadedVrm;

        VRMUtils.rotateVRM0(vrm);
        scene.add(vrm.scene);
        vrm.scene.updateMatrixWorld(true);

        // Preserve your existing camera framing.
        const bounds = new THREE.Box3().setFromObject(vrm.scene);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const modelHeight = Math.max(size.y, 0.1);

        camera.fov = 30;
        camera.position.set(
          center.x,
          center.y + modelHeight * 0.04,
          center.z + modelHeight * 1.65,
        );

        camera.lookAt(
          center.x,
          center.y + modelHeight * 0.42,
          center.z,
        );

        camera.updateProjectionMatrix();

        const humanoid = vrm.humanoid;

        // Capture only bones that actually exist on this model.
        const boneNames = [
          "leftShoulder",
          "rightShoulder",
          "leftUpperArm",
          "rightUpperArm",
          "leftLowerArm",
          "rightLowerArm",
          "spine",
          "chest",
          "upperChest",
          "neck",
          "head",
          "leftThumbProximal",
          "leftIndexProximal",
          "leftIndexIntermediate",
          "leftMiddleProximal",
          "leftMiddleIntermediate",
          "leftRingProximal",
          "leftRingIntermediate",
          "leftLittleProximal",
          "leftLittleIntermediate",
          "rightThumbProximal",
          "rightIndexProximal",
          "rightIndexIntermediate",
          "rightMiddleProximal",
          "rightMiddleIntermediate",
          "rightRingProximal",
          "rightRingIntermediate",
          "rightLittleProximal",
          "rightLittleIntermediate",
        ] as const;

        for (const name of boneNames) {
          captureBone(humanoid, name);
        }

        // Retain the working lowered-arm pose.
        const leftArm = bonePoses.leftUpperArm;
        const rightArm = bonePoses.rightUpperArm;
        const leftElbow = bonePoses.leftLowerArm;
        const rightElbow = bonePoses.rightLowerArm;

        if (leftArm) leftArm.node.rotation.z = leftArm.z + 0.85;
        if (rightArm) rightArm.node.rotation.z = rightArm.z - 0.85;

        if (leftElbow) leftElbow.node.rotation.z = leftElbow.z - 0.12;
        if (rightElbow) rightElbow.node.rotation.z = rightElbow.z + 0.12;

        setEmotion("happy");
        lastEmotionChange = performance.now() / 1000;
        setStatus("");
      },
      undefined,
      (error) => {
        if (disposed) return;

        console.error("Furina VRM failed to load:", error);
        setFailed(true);
        setStatus("Couldn't load Furina. Check the console for details.");
      },
    );

    const animate = (time: number) => {
      if (disposed) return;

      const seconds = time / 1000;
      const delta =
        previousTime === 0
          ? 0
          : Math.min((time - previousTime) / 1000, 0.05);

      previousTime = time;

      if (vrm) {
        vrm.update(delta);

        // Smooth expression changes instead of snapping between emotions.
        const expressionEase = 1 - Math.exp(-delta * 6);

        for (const name of EXPRESSION_NAMES) {
          const expression = vrm.expressionManager?.getExpression(name);
          if (!expression) continue;

          currentExpressions[name] +=
            (targetExpressions[name] - currentExpressions[name]) *
            expressionEase;

          vrm.expressionManager?.setValue(
            name,
            currentExpressions[name],
          );
        }

        // Gentle breathing and posture shifts.
        const breathing = Math.sin(seconds * 1.35);
        const slowSway = Math.sin(seconds * 0.55);
        const tinySway = Math.sin(seconds * 0.9 + 0.7);

        const spine = bonePoses.spine;
        const chest = bonePoses.chest;
        const upperChest = bonePoses.upperChest;

        if (spine) {
          spine.node.rotation.x = spine.x + breathing * 0.008;
          spine.node.rotation.z = spine.z + slowSway * 0.009;
        }

        if (chest) {
          chest.node.rotation.x = chest.x + breathing * 0.012;
          chest.node.rotation.z = chest.z + slowSway * 0.012;
        }

        if (upperChest) {
          upperChest.node.rotation.x = upperChest.x + breathing * 0.006;
          upperChest.node.rotation.z =
            upperChest.z + slowSway * 0.008;
        }

        // Shoulders and arms move slightly out of sync for a less robotic pose.
        const leftShoulder = bonePoses.leftShoulder;
        const rightShoulder = bonePoses.rightShoulder;
        const leftArm = bonePoses.leftUpperArm;
        const rightArm = bonePoses.rightUpperArm;
        const leftElbow = bonePoses.leftLowerArm;
        const rightElbow = bonePoses.rightLowerArm;

        if (leftShoulder) {
          leftShoulder.node.rotation.x =
            leftShoulder.x + breathing * 0.018;
          leftShoulder.node.rotation.z =
            leftShoulder.z + tinySway * 0.012;
        }

        if (rightShoulder) {
          rightShoulder.node.rotation.x =
            rightShoulder.x + breathing * 0.018;
          rightShoulder.node.rotation.z =
            rightShoulder.z - tinySway * 0.012;
        }

        if (leftArm) {
          leftArm.node.rotation.x =
            leftArm.x + Math.sin(seconds * 0.8) * 0.018;
          leftArm.node.rotation.y =
            leftArm.y + Math.sin(seconds * 0.55) * 0.025;
          leftArm.node.rotation.z =
            leftArm.z + 0.85 + Math.sin(seconds * 0.75) * 0.018;
        }

        if (rightArm) {
          rightArm.node.rotation.x =
            rightArm.x + Math.sin(seconds * 0.8 + 0.5) * 0.018;
          rightArm.node.rotation.y =
            rightArm.y - Math.sin(seconds * 0.55 + 0.4) * 0.025;
          rightArm.node.rotation.z =
            rightArm.z - 0.85 - Math.sin(seconds * 0.75 + 0.6) * 0.018;
        }

        if (leftElbow) {
          leftElbow.node.rotation.x =
            leftElbow.x + Math.sin(seconds * 0.7 + 0.3) * 0.018;
          leftElbow.node.rotation.z =
            leftElbow.z - 0.12 + Math.sin(seconds * 0.65) * 0.018;
        }

        if (rightElbow) {
          rightElbow.node.rotation.x =
            rightElbow.x + Math.sin(seconds * 0.7 + 0.8) * 0.018;
          rightElbow.node.rotation.z =
            rightElbow.z + 0.12 - Math.sin(seconds * 0.65 + 0.5) * 0.018;
        }

        // Small finger curls. Missing finger bones are safely ignored.
        // Keep the movement subtle because finger axes vary by model.
        const fingerNames = [
          "leftThumbProximal",
          "leftIndexProximal",
          "leftIndexIntermediate",
          "leftMiddleProximal",
          "leftMiddleIntermediate",
          "leftRingProximal",
          "leftRingIntermediate",
          "leftLittleProximal",
          "leftLittleIntermediate",
          "rightThumbProximal",
          "rightIndexProximal",
          "rightIndexIntermediate",
          "rightMiddleProximal",
          "rightMiddleIntermediate",
          "rightRingProximal",
          "rightRingIntermediate",
          "rightLittleProximal",
          "rightLittleIntermediate",
        ];

        for (let i = 0; i < fingerNames.length; i++) {
          const name = fingerNames[i];
          const pose = bonePoses[name];
          if (!pose) continue;

          const sidePhase = name.startsWith("left") ? 0 : 0.8;
          const fingerWave =
            Math.sin(seconds * 0.85 + i * 0.24 + sidePhase) * 0.018;

          pose.node.rotation.x = pose.x + 0.025 + fingerWave;
        }

        // Subtle, overlapping head movement.
        const neck = bonePoses.neck;
        const head = bonePoses.head;

        if (neck) {
          neck.node.rotation.x =
            neck.x + Math.sin(seconds * 0.8) * 0.025;
          neck.node.rotation.y =
            neck.y + Math.sin(seconds * 0.45) * 0.04;
          neck.node.rotation.z =
            neck.z + Math.sin(seconds * 0.6) * 0.012;
        }

        if (head) {
          head.node.rotation.x =
            head.x + Math.sin(seconds * 1.1) * 0.025;
          head.node.rotation.y =
            head.y + Math.sin(seconds * 0.65) * 0.055;
          head.node.rotation.z =
            head.z + Math.sin(seconds * 0.5) * 0.018;
        }

        // Smooth periodic blink, if the VRM provides a blink expression.
        if (vrm.expressionManager?.getExpression("blink")) {
          const cycle = seconds % 4.6;
          let blink = 0;

          if (cycle > 3.75 && cycle < 3.98) {
            const progress = (cycle - 3.75) / 0.23;
            blink = Math.sin(progress * Math.PI);
          } else if (cycle > 4.08 && cycle < 4.2) {
            // A brief second blink now and then.
            const progress = (cycle - 4.08) / 0.12;
            blink = Math.sin(progress * Math.PI) * 0.7;
          }

          vrm.expressionManager.setValue("blink", blink);
        }

        // Keep the existing demo until a real app emotion is requested.
        // After that, don't let the demo overwrite the requested emotion.
        if (
          !externalEmotionRequested &&
          seconds - lastEmotionChange > 12
        ) {
          const choices: Emotion[] = [
            "happy",
            "relaxed",
            "surprised",
            "sad",
          ];

          let nextEmotion = currentEmotion;

          while (nextEmotion === currentEmotion) {
            nextEmotion =
              choices[Math.floor(Math.random() * choices.length)];
          }

          setEmotion(nextEmotion);
          lastEmotionChange = seconds;
        }
      }

      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;

      window.removeEventListener("fufuu:emotion", handleEmotion);
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();

      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }

      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div
      className="fufuu-vrm-viewer"
      ref={hostRef}
      role="img"
      aria-label="Furina 3D avatar"
    >
      <div className={`fufuu-vrm-status${failed ? " is-error" : ""}`}>
        {status}
      </div>
    </div>
  );
}
