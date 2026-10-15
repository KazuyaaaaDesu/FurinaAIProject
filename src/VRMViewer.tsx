import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import {
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
} from "@pixiv/three-vrm";

type Emotion = "neutral" | "happy" | "relaxed" | "surprised" | "sad";

type MotionDefinition = {
  id: string;
  label: string;
  source: string;
  loop?: boolean;
};

type MotionManifest = MotionDefinition[];
type MotionLoadState = "loading" | "ready" | "partial" | "failed";

type MotionDebugItem = MotionDefinition & {
  state: MotionLoadState;
  message: string;
  trackCount: number;
  retargetedTracks: string[];
  remappedTracks: string[];
  skippedTracks: string[];
  missingBones: string[];
  duplicateTracks: string[];
  invalidValues: string[];
};

type LoadedMotion = {
  definition: MotionDefinition;
  clip: THREE.AnimationClip;
  trackLayout: string;
};

type MotionTransition = {
  from: Map<THREE.AnimationAction, number>;
  to: THREE.AnimationAction;
  elapsed: number;
  duration: number;
};

const EMOTION_NAMES = ["happy", "relaxed", "surprised", "sad"] as const;

const EMOTION_WEIGHTS: Record<
  Emotion,
  ReadonlyArray<readonly [string, number]>
> = {
  neutral: [],
  happy: [["happy", 0.85]],
  relaxed: [
    ["relaxed", 0.75],
    ["happy", 0.12],
  ],
  surprised: [["surprised", 0.8]],
  sad: [["sad", 0.75]],
};

function smoothStep(value: number) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function getTrackLayout(clip: THREE.AnimationClip) {
  return clip.tracks
    .map((track) => `${track.name}:${track.ValueTypeName}`)
    .sort()
    .join("|");
}

function isMotionManifest(value: unknown): value is MotionManifest {
  if (!Array.isArray(value)) return false;

  const ids = new Set<string>();

  return value.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }

    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      !/^[a-z0-9-]+$/i.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.label !== "string" ||
      typeof entry.source !== "string" ||
      (entry.loop !== undefined && typeof entry.loop !== "boolean")
    ) {
      return false;
    }

    ids.add(entry.id);
    return true;
  });
}

export default function VRMViewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading Furina...");
  const [failed, setFailed] = useState(false);
  const [motionDebugItems, setMotionDebugItems] = useState<MotionDebugItem[]>(
    [],
  );
  const [activeMotionId, setActiveMotionId] = useState<string | null>(null);
  const [transitionDuration, setTransitionDuration] = useState(0.32);
  const [returnTransitionDuration, setReturnTransitionDuration] =
    useState(0.5);
  const transitionDurationRef = useRef(0.32);
  const returnTransitionDurationRef = useRef(0.5);
  const showMotionDebug =
    new URLSearchParams(window.location.search).get("debugMotions") === "1";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frameId = 0;
    let vrm: VRM | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    let activeAction: THREE.AnimationAction | null = null;
    let activeMotion: LoadedMotion | null = null;
    let transition: MotionTransition | null = null;
    let controlledActions = new Map<THREE.AnimationAction, number>();
    let previousTime = 0;
    let modelHeight = 1;
    let originalRootY = 0;
    let fallbackKnockStartedAt = -1;
    let currentEmotion: Emotion = "happy";
    let nextBlinkAt = 3;
    let blinkStartedAt = -1;

    const motionsById = new Map<string, LoadedMotion>();
    const availableExpressions = new Set<string>();
    const targetExpressions: Record<string, number> = {};
    const currentExpressions: Record<string, number> = {};

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.25, 3.2);
    camera.lookAt(0, 1.15, 0);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch (error) {
      console.error("Furina 3D viewer could not initialize WebGL:", error);
      const statusElement = host.querySelector(".fufuu-vrm-status");
      if (statusElement) {
        statusElement.textContent =
          "3D viewer unavailable: WebGL could not be initialized. Enable hardware acceleration or check your graphics drivers.";
        statusElement.classList.add("is-error");
      }
      return;
    }
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

    const setEmotion = (emotion: Emotion) => {
      currentEmotion = emotion;

      for (const name of EMOTION_NAMES) {
        targetExpressions[name] = 0;
      }

      for (const [name, weight] of EMOTION_WEIGHTS[emotion]) {
        if (availableExpressions.has(name)) {
          targetExpressions[name] = weight;
        }
      }
    };

    const updateMotionDebugItem = (
      id: string,
      update: Partial<MotionDebugItem>,
    ) => {
      if (disposed) return;
      setMotionDebugItems((items) =>
        items.map((item) =>
          item.id === id ? { ...item, ...update } : item,
        ),
      );
    };

    const stopControlledActions = () => {
      for (const action of controlledActions.keys()) {
        action.stop();
      }
      controlledActions.clear();
      transition = null;
      activeAction = null;
      activeMotion = null;
    };

    const playMotion = (
      motion: LoadedMotion,
      duration = transitionDurationRef.current,
    ) => {
      if (!mixer || !vrm) return false;

      if (activeMotion?.definition.id === motion.definition.id && activeAction) {
        return true;
      }

      const action = mixer.clipAction(motion.clip, vrm.scene);
      for (const [controlledAction, weight] of controlledActions) {
        if (weight <= 0.0001) {
          controlledAction.stop();
          controlledActions.delete(controlledAction);
        }
      }
      if (controlledActions.has(action)) {
        console.info(
          `Ignoring "${motion.definition.label}" while it is already fading out.`,
        );
        return false;
      }

      const from = new Map(
        [...controlledActions].filter(([, weight]) => weight > 0.0001),
      );
      const incompatibleSource = [...from.keys()].find(
        (source) => getTrackLayout(source.getClip()) !== motion.trackLayout,
      );

      if (incompatibleSource) {
        console.warn(
          `Cannot crossfade "${motion.definition.label}" because its humanoid track layout differs from the active motion. Switching without blending.`,
        );
        stopControlledActions();
      }

      action.reset();
      action.enabled = true;
      action.setEffectiveTimeScale(1);
      action.setLoop(
        motion.definition.loop ? THREE.LoopRepeat : THREE.LoopOnce,
        motion.definition.loop ? Infinity : 1,
      );
      action.clampWhenFinished = !motion.definition.loop;
      action.setEffectiveWeight(0);
      action.play();

      activeAction = action;
      activeMotion = motion;
      fallbackKnockStartedAt = -1;
      if (!disposed) setActiveMotionId(motion.definition.id);

      const transitionDuration = incompatibleSource
        ? 0
        : Math.max(0, duration);
      if (transitionDuration === 0 || from.size === 0) {
        for (const source of from.keys()) {
          source.stop();
        }
        action.setEffectiveWeight(1);
        controlledActions = new Map([[action, 1]]);
        transition = null;
      } else {
        transition = {
          from,
          to: action,
          elapsed: 0,
          duration: transitionDuration,
        };
        controlledActions = new Map(from);
        controlledActions.set(action, 0);
      }

      console.info("Furina motion playing:", motion.definition.label);
      return true;
    };

    const playIdleMotion = (duration = transitionDurationRef.current) => {
      const idle = motionsById.get("idle");
      if (idle) {
        playMotion(idle, duration);
        return;
      }

      stopControlledActions();
      if (!disposed) setActiveMotionId(null);
    };

    const handleMotionFinished = (event: { action: THREE.AnimationAction }) => {
      if (!activeAction || event.action !== activeAction) return;

      const finishedId = activeMotion?.definition.id ?? null;
      if (finishedId !== "idle") {
        playIdleMotion(returnTransitionDurationRef.current);
      }
    };

    const playMotionById = (id: string) => {
      const motion = motionsById.get(id);
      if (!motion) {
        console.warn(`Furina motion "${id}" is not loaded and cannot be played.`);
        return false;
      }

      return playMotion(motion);
    };

    const handleGesture = (gesture: string) => {
      const aliases: Record<string, string> = {
        greeting: "wave",
        hello: "wave",
        bow: "bow",
        talking: "talking",
        pointing: "pointing",
        presenting: "presenting",
        curious: "handbehindhead",
        wave: "wave",
        idle: "idle",
        knock: "knock",
      };

      const id = aliases[gesture] ?? gesture;
      if (id === "idle") {
        playIdleMotion();
      } else {
        playMotionById(id);
      }
    };

    const handleEmotion = (event: Event) => {
      const emotion = (event as CustomEvent<string>).detail;
      if (
        emotion === "neutral" ||
        EMOTION_NAMES.includes(emotion as (typeof EMOTION_NAMES)[number])
      ) {
        setEmotion(emotion as Emotion);
      }
    };

    const handleKnock = () => {
      setEmotion("surprised");

      if (!playMotionById("knock")) {
        fallbackKnockStartedAt = performance.now() / 1000;
      }
    };

    const handleGestureEvent = (event: Event) => {
      const gesture = (event as CustomEvent<string>).detail;
      if (typeof gesture === "string") handleGesture(gesture);
    };

    const handlePlayMotionEvent = (event: Event) => {
      const motionId = (event as CustomEvent<string>).detail;
      if (typeof motionId === "string") playMotionById(motionId);
    };

    const unsubscribeKnock = window.sakuraDesktop?.onKnock(handleKnock);
    window.addEventListener("fufuu:emotion", handleEmotion);
    window.addEventListener("fufuu:gesture", handleGestureEvent);
    window.addEventListener("fufuu:play-motion", handlePlayMotionEvent);

    const loadMotion = async (definition: MotionDefinition) => {
      const url = new URL(definition.source, window.location.origin);
      if (url.origin !== window.location.origin) {
        throw new Error("Motion sources must be local files served by this app.");
      }

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url.href);

      try {
        if (disposed) return;
        const animations = gltf.userData.vrmAnimations as
          | VRMAnimation[]
          | undefined;
        if (!animations?.length) {
          throw new Error(
            "No VRMC_vrm_animation data was recognized by the installed loader.",
          );
        }
        if (animations.length !== 1) {
          throw new Error(
            `Expected one VRMA animation, received ${animations.length}.`,
          );
        }

        const animation = animations[0];
        const sourceTracks = [
          ...Array.from(animation.humanoidTracks.rotation, ([bone, track]) => ({
            bone,
            path: "rotation",
            values: track.values,
            isQuaternion: true,
          })),
          ...Array.from(
            animation.humanoidTracks.translation,
            ([bone, track]) => ({
              bone,
              path: "translation",
              values: track.values,
              isQuaternion: false,
            }),
          ),
        ];
        const expectedTracks = sourceTracks.length;
        if (expectedTracks === 0) {
          throw new Error("The file contains no humanoid bone animation tracks.");
        }

        if (!vrm) throw new Error("The Furina VRM is not ready for retargeting.");

        const retargetedTracks: string[] = [];
        const skippedTracks: string[] = [];
        const missingBones = new Set<string>();
        const invalidValues: string[] = [];

        for (const track of sourceTracks) {
          const trackId = `${track.bone}.${track.path}`;
          if (vrm.humanoid.getNormalizedBoneNode(track.bone) == null) {
            const canSafelyMergeWithChest =
              track.bone === "upperChest" &&
              track.path === "rotation" &&
              vrm.humanoid.getNormalizedBoneNode("chest") !== null &&
              animation.humanoidTracks.rotation.has("chest");
            skippedTracks.push(
              canSafelyMergeWithChest
                ? `${trackId} (not merged into chest.rotation: chest already has its own track, and the source bone-local frames differ)`
                : `${trackId} (no compatible target bone)`,
            );
            missingBones.add(track.bone);
            continue;
          }

          retargetedTracks.push(trackId);
          const values = track.values;
          if (Array.from(values).some((value) => !Number.isFinite(value))) {
            invalidValues.push(`${trackId} contains non-finite values`);
            continue;
          }

          if (track.isQuaternion) {
            for (let index = 0; index < values.length; index += 4) {
              const quaternion = Array.from(values.slice(index, index + 4));
              const magnitude = Math.hypot(...quaternion);
              if (
                quaternion.length !== 4 ||
                !Number.isFinite(magnitude) ||
                magnitude < 1e-8 ||
                Math.abs(magnitude - 1) > 1e-3
              ) {
                invalidValues.push(
                  `${trackId} has an invalid quaternion at key ${index / 4}`,
                );
              }
            }
          }
        }

        if (invalidValues.length > 0) {
          throw new Error(invalidValues.join("; "));
        }

        const clip = createVRMAnimationClip(animation, vrm);
        if (clip.tracks.length === 0 || retargetedTracks.length === 0) {
          throw new Error(
            "The animation has no humanoid tracks that can be retargeted to Furina.",
          );
        }

        const trackNames = clip.tracks.map((track) => track.name);
        const duplicateTracks = trackNames.filter(
          (name, index) => trackNames.indexOf(name) !== index,
        );
        if (duplicateTracks.length > 0) {
          throw new Error(
            `The retargeted clip contains duplicate tracks: ${[...new Set(duplicateTracks)].join(", ")}.`,
          );
        }

        const invalidClipTracks = clip.tracks.filter((track) =>
          Array.from(track.values).some((value) => !Number.isFinite(value)),
        );
        for (const track of invalidClipTracks) {
          invalidValues.push(`${track.name} contains non-finite values`);
        }

        for (const track of clip.tracks) {
          if (track.ValueTypeName !== "quaternion") continue;

          for (let index = 0; index < track.values.length; index += 4) {
            const quaternion = Array.from(track.values.slice(index, index + 4));
            const magnitude = Math.hypot(...quaternion);
            if (
              quaternion.length !== 4 ||
              !Number.isFinite(magnitude) ||
              magnitude < 1e-8 ||
              Math.abs(magnitude - 1) > 1e-3
            ) {
              invalidValues.push(
                `${track.name} has an invalid retargeted quaternion at key ${index / 4}`,
              );
            }
          }
        }

        if (invalidValues.length > 0) {
          throw new Error(invalidValues.join("; "));
        }

        if (clip.tracks.length < retargetedTracks.length) {
          throw new Error(
            `Only ${clip.tracks.length} tracks were generated for ${retargetedTracks.length} mapped humanoid tracks.`,
          );
        }

        const loadedMotion = {
          definition,
          clip,
          trackLayout: getTrackLayout(clip),
        };
        motionsById.set(definition.id, loadedMotion);
        const state: MotionLoadState =
          skippedTracks.length > 0 ? "partial" : "ready";
        const remappedTracks: string[] = [];
        updateMotionDebugItem(definition.id, {
          state,
          message: `Retargeted ${retargetedTracks.length}/${expectedTracks} source humanoid tracks.`,
          trackCount: clip.tracks.length,
          retargetedTracks,
          remappedTracks,
          skippedTracks,
          missingBones: [...missingBones],
          duplicateTracks,
          invalidValues,
        });

        console.info("Furina VRMA ready:", {
          id: definition.id,
          source: definition.source,
          duration: clip.duration,
          sourceHumanoidTrackCount: expectedTracks,
          retargetedHumanoidTracks: retargetedTracks,
          safelyRemappedHumanoidTracks: remappedTracks,
          intentionallySkippedHumanoidTracks: skippedTracks,
          missingHumanoidBones: [...missingBones],
          duplicateTracks,
          invalidValues,
          clipTrackCount: clip.tracks.length,
        });
      } finally {
        VRMUtils.deepDispose(gltf.scene);
      }
    };

    const loadMotionManifest = async () => {
      const response = await fetch("/motions/manifest.json");
      if (!response.ok) {
        throw new Error(
          `Motion manifest request failed with HTTP ${response.status}.`,
        );
      }

      const value: unknown = await response.json();
      if (!isMotionManifest(value)) {
        throw new Error(
          "Motion manifest entries must have unique id, label, local source, and optional loop fields.",
        );
      }

      const definitions = value;
      if (!disposed) {
        setMotionDebugItems(
          definitions.map((definition) => ({
            ...definition,
            state: "loading",
            message: "Loading and retargeting...",
            trackCount: 0,
            retargetedTracks: [],
            remappedTracks: [],
            skippedTracks: [],
            missingBones: [],
            duplicateTracks: [],
            invalidValues: [],
          })),
        );
      }

      await Promise.all(
        definitions.map(async (definition) => {
          try {
            await loadMotion(definition);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `Furina motion "${definition.id}" failed (${definition.source}):`,
              error,
            );
            updateMotionDebugItem(definition.id, {
              state: "failed",
              message,
              invalidValues: [message],
            });
          }
        }),
      );

      if (disposed) return;

      if (motionsById.has("idle")) {
        playIdleMotion();
      } else {
        console.warn(
          "No usable idle VRMA is available. Furina will remain in her imported rest pose until another loaded motion is triggered.",
        );
      }
    };

    const loadModel = async () => {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

      try {
        const gltf = await loader.loadAsync("/models/furina.vrm");
        if (disposed) {
          VRMUtils.deepDispose(gltf.scene);
          return;
        }

        const loadedVrm = gltf.userData.vrm as VRM | undefined;
        if (!loadedVrm) {
          throw new Error("The file did not contain a readable VRM avatar.");
        }

        vrm = loadedVrm;
        if (vrm.meta.metaVersion === "0") {
          VRMUtils.rotateVRM0(vrm);
        }

        scene.add(vrm.scene);
        vrm.scene.updateMatrixWorld(true);

        const bounds = new THREE.Box3().setFromObject(vrm.scene);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        modelHeight = Math.max(size.y, 0.1);
        originalRootY = vrm.scene.position.y;

        camera.fov = 30;
        camera.position.set(
          center.x,
          center.y + modelHeight * 0.04,
          center.z + modelHeight * 1.65,
        );
        camera.lookAt(center.x, center.y + modelHeight * 0.42, center.z);
        camera.updateProjectionMatrix();

        const detectedBones = Object.entries(vrm.humanoid.humanBones)
          .filter((entry) => entry[1] !== undefined)
          .map(([name, bone]) => `${name} (${bone.node.name})`);
        const expressions =
          vrm.expressionManager?.expressions.map(
            (expression) => expression.expressionName,
          ) ?? [];

        for (const name of expressions) {
          availableExpressions.add(name);
          targetExpressions[name] = 0;
          currentExpressions[name] = 0;
        }

        console.info("Furina VRM diagnostics:", {
          version: vrm.meta.metaVersion,
          humanoidBones: detectedBones,
          facialExpressions: expressions,
          embeddedAnimationClipCount: gltf.animations.length,
          embeddedAnimationClipNames: gltf.animations.map(
            (clip, index) => clip.name || `(unnamed ${index + 1})`,
          ),
        });

        if (gltf.animations.length > 0) {
          console.warn(
            "Embedded glTF animation tracks are reported but not played directly. Only clips parsed as VRMA are retargeted automatically.",
          );
        }

        mixer = new THREE.AnimationMixer(vrm.scene);
        mixer.addEventListener("finished", handleMotionFinished);

        const embeddedVrmAnimations = gltf.userData.vrmAnimations as
          | VRMAnimation[]
          | undefined;
        if (embeddedVrmAnimations?.length) {
          const embeddedClip = createVRMAnimationClip(
            embeddedVrmAnimations[0],
            vrm,
          );
          if (embeddedClip.tracks.length > 0) {
            const definition: MotionDefinition = {
              id: "embedded-motion",
              label: gltf.animations[0]?.name || "Embedded motion",
              source: "/models/furina.vrm",
            };
            motionsById.set(definition.id, {
              definition,
              clip: embeddedClip,
              trackLayout: getTrackLayout(embeddedClip),
            });
          }
        }

        setEmotion(currentEmotion);
        setStatus("");

        try {
          await loadMotionManifest();
        } catch (error) {
          console.error("Furina motion manifest failed to load:", error);
          console.warn(
            "No configured VRMA motions are available; Furina will preserve her imported rest pose.",
          );
        }
      } catch (error) {
        if (disposed) return;

        console.error("Furina VRM failed to load:", error);
        setFailed(true);
        setStatus(
          error instanceof Error
            ? `Couldn't load Furina: ${error.message}`
            : "Couldn't load Furina. Check the console for details.",
        );
        setMotionDebugItems((items) =>
          items.map((item) => ({
            ...item,
            state: "failed",
            message: "Cannot retarget until Furina's VRM has loaded.",
            invalidValues: ["Cannot retarget until Furina's VRM has loaded."],
          })),
        );
      }
    };

    void loadModel();

    const animate = (time: number) => {
      if (disposed) return;

      const seconds = time / 1000;
      const delta =
        previousTime === 0 ? 0 : Math.min((time - previousTime) / 1000, 0.05);
      previousTime = time;

      if (vrm) {
        if (transition) {
          transition.elapsed = Math.min(
            transition.elapsed + delta,
            transition.duration,
          );
          const progress = smoothStep(
            transition.elapsed / transition.duration,
          );

          for (const [source, initialWeight] of transition.from) {
            const weight = initialWeight * (1 - progress);
            source.setEffectiveWeight(weight);
            if (weight > 0.0001) controlledActions.set(source, weight);
            else controlledActions.delete(source);
          }

          transition.to.setEffectiveWeight(progress);
          controlledActions.set(transition.to, progress);

          if (progress >= 1) {
            for (const source of transition.from.keys()) {
              source.stop();
              controlledActions.delete(source);
            }
            transition.to.setEffectiveWeight(1);
            controlledActions = new Map([[transition.to, 1]]);
            transition = null;
          }
        }

        mixer?.update(delta);

        if (!activeAction) {
          const idleBob = Math.sin(seconds * 1.35) * modelHeight * 0.003;
          vrm.scene.position.y = originalRootY + idleBob;
        } else {
          vrm.scene.position.y = originalRootY;
        }

        if (fallbackKnockStartedAt >= 0) {
          const elapsed = seconds - fallbackKnockStartedAt;
          if (elapsed < 0.9) {
            const envelope = 1 - smoothStep(elapsed / 0.9);
            vrm.scene.position.y +=
              Math.sin(elapsed * 18) * modelHeight * 0.004 * envelope;
          } else {
            fallbackKnockStartedAt = -1;
          }
        }

        const expressionEase = 1 - Math.exp(-delta * 6);
        for (const name of EMOTION_NAMES) {
          if (!availableExpressions.has(name)) continue;

          const trackName = vrm.expressionManager?.getExpressionTrackName(name);
          const controlledByMotion =
            trackName !== null &&
            trackName !== undefined &&
            activeMotion?.clip.tracks.some(
              (track) =>
                track.name === trackName ||
                track.name.startsWith(`${trackName}.`),
            );

          if (controlledByMotion) continue;

          currentExpressions[name] +=
            ((targetExpressions[name] ?? 0) - currentExpressions[name]) *
            expressionEase;
          vrm.expressionManager?.setValue(name, currentExpressions[name]);
        }

        if (availableExpressions.has("blink")) {
          const blinkTrackName =
            vrm.expressionManager?.getExpressionTrackName("blink");
          const blinkControlledByMotion =
            blinkTrackName !== null &&
            blinkTrackName !== undefined &&
            activeMotion?.clip.tracks.some(
              (track) =>
                track.name === blinkTrackName ||
                track.name.startsWith(`${blinkTrackName}.`),
            );

          if (!blinkControlledByMotion) {
            if (blinkStartedAt < 0 && seconds >= nextBlinkAt) {
              blinkStartedAt = seconds;
            }

            let blink = 0;
            if (blinkStartedAt >= 0) {
              const elapsed = seconds - blinkStartedAt;
              const blinkDuration = 0.14;
              if (elapsed < blinkDuration) {
                blink = Math.sin((elapsed / blinkDuration) * Math.PI);
              } else {
                blinkStartedAt = -1;
                nextBlinkAt = seconds + 3.2 + Math.random() * 2.6;
              }
            }
            vrm.expressionManager?.setValue("blink", blink);
          }
        }

        vrm.update(delta);
      }

      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
      window.removeEventListener("fufuu:emotion", handleEmotion);
      window.removeEventListener("fufuu:gesture", handleGestureEvent);
      window.removeEventListener("fufuu:play-motion", handlePlayMotionEvent);
      unsubscribeKnock?.();
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();

      if (mixer) {
        mixer.removeEventListener("finished", handleMotionFinished);
        mixer.stopAllAction();
        mixer.uncacheRoot(mixer.getRoot());
      }

      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }

      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const stateLabel = (item: MotionDebugItem) => {
    if (item.state === "ready") return `Ready · ${item.trackCount} tracks`;
    if (item.state === "partial") return `Partial · ${item.message}`;
    if (item.state === "failed") return `Failed · ${item.message}`;
    return item.message;
  };

  return (
    <div
      className="fufuu-vrm-viewer"
      ref={hostRef}
      role={showMotionDebug ? undefined : "img"}
      aria-label={showMotionDebug ? undefined : "Furina 3D avatar"}
    >
      <div className={`fufuu-vrm-status${failed ? " is-error" : ""}`}>
        {status}
      </div>
      {showMotionDebug && (
        <section
          aria-label="VRMA motion test panel"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 30,
            width: 230,
            maxHeight: "70%",
            overflowY: "auto",
            padding: 10,
            borderRadius: 10,
            background: "#201827eF",
            color: "#fff4fb",
            font: "12px Segoe UI, sans-serif",
            pointerEvents: "auto",
          }}
        >
          <strong>VRMA motion test</strong>
          <label style={{ display: "block", marginTop: 8 }}>
            Transition: {transitionDuration.toFixed(2)} s
            <input
              aria-label="Ordinary transition duration"
              type="range"
              min="0.25"
              max="0.4"
              step="0.01"
              value={transitionDuration}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                transitionDurationRef.current = value;
                setTransitionDuration(value);
              }}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label style={{ display: "block", marginTop: 6 }}>
            Return to idle: {returnTransitionDuration.toFixed(2)} s
            <input
              aria-label="Gesture return transition duration"
              type="range"
              min="0.4"
              max="0.6"
              step="0.01"
              value={returnTransitionDuration}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                returnTransitionDurationRef.current = value;
                setReturnTransitionDuration(value);
              }}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          {failed && (
            <p role="alert">
              The VRM viewer failed to initialize. See the message above and
              check the console for details.
            </p>
          )}
          <button
            type="button"
            disabled={failed}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("fufuu:play-motion", { detail: "idle" }),
              )
            }
            style={{ display: "block", margin: "6px 0" }}
          >
            Play idle
          </button>
          {motionDebugItems.map((item) => (
            <div key={item.id} style={{ marginTop: 8 }}>
              <button
                type="button"
                disabled={
                  failed ||
                  item.state === "loading" ||
                  item.state === "failed"
                }
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("fufuu:play-motion", {
                      detail: item.id,
                    }),
                  )
                }
              >
                Play {item.label}
                {activeMotionId === item.id ? " (playing)" : ""}
              </button>
              <div
                role="status"
                style={{
                  color:
                    item.state === "failed"
                      ? "#ffaaaa"
                      : item.state === "partial"
                        ? "#ffd37f"
                        : "#e6dbea",
                  overflowWrap: "anywhere",
                }}
              >
                {stateLabel(item)}
              </div>
              <div>Successfully retargeted: {item.retargetedTracks.length}</div>
              <div>Safely remapped: {item.remappedTracks.length}</div>
              <div>
                Intentionally skipped: {item.skippedTracks.length}
                {item.skippedTracks.length > 0 && (
                  <ul>
                    {item.skippedTracks.map((track) => (
                      <li key={track}>{track}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                Missing/incompatible bones:{" "}
                {item.missingBones.length > 0
                  ? item.missingBones.join(", ")
                  : "none"}
              </div>
              <div>
                Duplicate tracks:{" "}
                {item.duplicateTracks.length > 0
                  ? item.duplicateTracks.join(", ")
                  : "none"}
              </div>
              <div>
                Invalid values/quaternions:{" "}
                {item.invalidValues.length > 0
                  ? item.invalidValues.join(", ")
                  : "none"}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
