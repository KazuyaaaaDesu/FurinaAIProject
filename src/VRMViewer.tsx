import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

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
      if (!host || disposed) return;
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

    loader.load(
      "/models/furina.vrm",
      (gltf) => {
        if (disposed) return;

        const loadedVrm = gltf.userData.vrm as VRM | undefined;
        if (!loadedVrm) {
          setFailed(true);
          setStatus("This file did not contain a readable VRM avatar.");
          return;
        }

        vrm = loadedVrm;
        VRMUtils.rotateVRM0(vrm);
        scene.add(vrm.scene);
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

    let previousTime = 0;

    const animate = (time: number) => {
      if (disposed) return;

      const delta = previousTime === 0 ? 0 : Math.min((time - previousTime) / 1000, 0.05);
      previousTime = time;

      vrm?.update(delta);
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
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

