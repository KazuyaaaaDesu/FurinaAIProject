import { useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";

import "./Live2DViewer.css";

Live2DModel.registerTicker(PIXI.Ticker);

const MODEL_URL = "/models/furina-live2d/Furina.model3.json";

const EXPRESSION_KEYS: Record<string, number> = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
};

interface CubismParameterAPI {
  setParameterValueById?: (
    id: string,
    value: number,
    weight?: number,
  ) => void;

  getParameterValueById?: (id: string) => number;

  getParameterIndex?: (id: string) => number;

  setParameterValueByIndex?: (
    index: number,
    value: number,
    weight?: number,
  ) => void;
}

function setParameter(
  core: CubismParameterAPI,
  id: string,
  value: number,
) {
  try {
    if (typeof core.setParameterValueById === "function") {
      core.setParameterValueById(id, value);
      return;
    }

    if (
      typeof core.getParameterIndex === "function" &&
      typeof core.setParameterValueByIndex === "function"
    ) {
      const index = core.getParameterIndex(id);

      if (index >= 0) {
        core.setParameterValueByIndex(index, value);
      }
    }
  } catch {
    // Some model runtimes expose different parameter APIs.
  }
}

export default function Live2DViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading Furina…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let rendererDestroyed = false;
    let model: Live2DModel | null = null;
    let elapsed = 0;
    let blinkTimer = 0;
    let nextBlink = 3.5;
    let mouseX = 0;
    let mouseY = 0;
    let currentExpression = -1;

    const app = new PIXI.Application({
      width: Math.max(container.clientWidth, 1),
      height: Math.max(container.clientHeight, 1),
      backgroundAlpha: 0,
      antialias: true,
      autoStart: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });

    const canvas = app.view as HTMLCanvasElement;

    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.background = "transparent";
    canvas.style.touchAction = "none";

    container.appendChild(canvas);

    console.log("[Fufuu Live2D] Viewer initialized.");

    const fitModel = () => {
      if (!model || disposed || rendererDestroyed) return;

      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);

      app.renderer.resize(width, height);

      const bounds = model.getLocalBounds();

      if (
        !Number.isFinite(bounds.width) ||
        !Number.isFinite(bounds.height) ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        console.warn("[Fufuu Live2D] Invalid model bounds.", bounds);
        return;
      }

      const scale = Math.min(
        (width * 0.94) / bounds.width,
        (height * 0.86) / bounds.height,
      );

      model.scale.set(scale);
      model.position.set(width / 2, height / 2 + height * 0.015);
      model.visible = true;
      model.renderable = true;

      console.log("[Fufuu Live2D] Model fitted.", {
        width,
        height,
        scale,
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      fitModel();
    });

    resizeObserver.observe(container);

    const handlePointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) return;

      mouseX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      mouseY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;

      // Smoothly make Furina look toward the cursor.
      model?.focus(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };

    const handlePointerLeave = () => {
      mouseX = 0;
      mouseY = 0;
    };

    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerleave", handlePointerLeave);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!model || disposed) return;

      const target = event.target;

      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }

      if (event.key === "Escape") {
        currentExpression = -1;
        console.log(`[Fufuu Live2D] Expression reset (active: ${currentExpression})`);
        return;
      }

      const expressionIndex = EXPRESSION_KEYS[event.key];

      if (expressionIndex === undefined) return;

      currentExpression = expressionIndex;

      void model.expression(expressionIndex).then((success) => {
        if (disposed) return;

        if (success) {
          console.log(
            `[Fufuu Live2D] Expression ${expressionIndex + 1} activated. (Current: ${currentExpression})`,
          );
        } else {
          console.warn(
            `[Fufuu Live2D] Expression ${expressionIndex + 1} is unavailable.`,
          );
        }
      }).catch((error: unknown) => {
        console.warn("[Fufuu Live2D] Expression failed.", error);
      });
    };

    window.addEventListener("keydown", handleKeyDown);

    async function loadModel() {
      try {
        console.log("[Fufuu Live2D] Loading:", MODEL_URL);

        const loadedModel = await Live2DModel.from(MODEL_URL, {
          autoInteract: false,
        });

        if (disposed) {
          loadedModel.destroy();
          return;
        }

        model = loadedModel;
        model.anchor.set(0.5, 0.5);
        model.visible = true;
        model.renderable = true;

        app.stage.addChild(model);
        fitModel();

        // Access the Cubism parameter API through a typed compatibility
        // layer because this package declares coreModel as `object`.
        const core = model.internalModel.coreModel as CubismParameterAPI;

        // Smooth idle animation. Pixi's ticker callback receives a
        // numeric delta, so do not type it as PIXI.Ticker.
        app.ticker.add((delta: number) => {
          if (disposed || !model || model.destroyed) return;

          const dt = Math.min(delta / 60, 0.05);
          elapsed += dt;

          // Gentle breathing.
          setParameter(
            core,
            "ParamBreath",
            0.5 + Math.sin(elapsed * 1.25) * 0.12,
          );

          // Small natural head movements.
          setParameter(
            core,
            "ParamAngleX",
            Math.sin(elapsed * 0.48) * 5 + mouseX * 8,
          );

          setParameter(
            core,
            "ParamAngleY",
            Math.sin(elapsed * 0.37) * 3 - mouseY * 5,
          );

          setParameter(
            core,
            "ParamAngleZ",
            Math.sin(elapsed * 0.65) * 2.5,
          );

          setParameter(
            core,
            "ParamBodyAngleZ",
            Math.sin(elapsed * 0.5) * 1.5,
          );

          // Subtle eye movement when the pointer is nearby.
          setParameter(
            core,
            "ParamEyeBallX",
            Math.max(-1, Math.min(1, mouseX * 0.7)),
          );

          setParameter(
            core,
            "ParamEyeBallY",
            Math.max(-1, Math.min(1, -mouseY * 0.5)),
          );

          // Occasional blink. Keep the eye-open parameters untouched
          // between blinks so the model can use its normal eye setup.
          blinkTimer += dt;

          if (blinkTimer >= nextBlink) {
            blinkTimer = 0;
            nextBlink = 2.5 + Math.random() * 3.5;

            setParameter(core, "ParamEyeLOpen", 0);
            setParameter(core, "ParamEyeROpen", 0);

            window.setTimeout(() => {
              if (disposed) return;

              setParameter(core, "ParamEyeLOpen", 1);
              setParameter(core, "ParamEyeROpen", 1);
            }, 120);
          }
        });

        setFailed(false);
        setStatus("");

        console.log("[Fufuu Live2D] Furina is ready.", {
          canvasConnected: canvas.isConnected,
          stageChildren: app.stage.children.length,
          expressionControls: "Keys 1–7",
        });
      } catch (error) {
        console.error("[Fufuu Live2D] Model loading failed.", error);

        if (!disposed) {
          setFailed(true);
          setStatus("Couldn't load Furina. Check the console for errors.");
        }
      }
    }

    void loadModel();

    return () => {
      disposed = true;
      rendererDestroyed = true;

      resizeObserver.disconnect();
      app.ticker.stop();

      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("keydown", handleKeyDown);

      if (model) {
        app.stage.removeChild(model);
        model.destroy();
        model = null;
      }

      app.destroy(true, {
        children: true,
        texture: false,
        baseTexture: false,
      });

      if (canvas.parentElement === container) {
        container.removeChild(canvas);
      }

      console.log("[Fufuu Live2D] Viewer cleaned up.");
    };
  }, []);

  return (
    <div className="fufuu-live2d-viewer">
      <div
        ref={containerRef}
        className="fufuu-live2d-canvas-host"
      />

      {status && (
        <div
          className={`fufuu-live2d-status${failed ? " is-error" : ""}`}
          role={failed ? "alert" : "status"}
        >
          {status}
        </div>
      )}
    </div>
  );
}