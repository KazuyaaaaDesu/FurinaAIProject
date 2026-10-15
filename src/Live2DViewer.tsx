
import { useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import "./Live2DViewer.css";

Live2DModel.registerTicker(PIXI.Ticker);

const MODEL_URL = "/models/furina-live2d/Furina.model3.json";
const EMOTION_CHANNEL = "fufuu-avatar-emotion";

const EXPRESSION_KEYS: Record<string, number> = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
};

const EXPRESSION_EMOTIONS = [
  "neutral",
  "happy",
  "pout",
  "shy",
  "smug",
  "surprised",
  "sparkle",
] as const;

type FufuuEmotion = (typeof EXPRESSION_EMOTIONS)[number];

interface ExpressionSetting {
  Name?: string;
  File?: string;
  name?: string;
  file?: string;
}

interface CubismSettings {
  expressions?: ExpressionSetting[];
  Expressions?: ExpressionSetting[];
  FileReferences?: {
    Expressions?: ExpressionSetting[];
  };
}

interface CubismParameterAPI {
  setParameterValueById?: (
    id: string,
    value: number,
    weight?: number,
  ) => void;
  getParameterIndex?: (id: string) => number;
  setParameterValueByIndex?: (
    index: number,
    value: number,
    weight?: number,
  ) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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
  } catch (error) {
    console.debug(`[Fufuu] Could not set parameter ${id}:`, error);
  }
}

function getExpressions(settings: unknown): ExpressionSetting[] {
  if (!settings || typeof settings !== "object") return [];

  const value = settings as CubismSettings;

  if (Array.isArray(value.expressions)) return value.expressions;
  if (Array.isArray(value.Expressions)) return value.Expressions;

  if (Array.isArray(value.FileReferences?.Expressions)) {
    return value.FileReferences.Expressions;
  }

  return [];
}

function getExpressionName(
  expression: ExpressionSetting,
): string | undefined {
  return expression.Name ?? expression.name;
}

function getExpressionFile(
  expression: ExpressionSetting,
): string | undefined {
  return expression.File ?? expression.file;
}

function isFufuuEmotion(value: unknown): value is FufuuEmotion {
  return (
    typeof value === "string" &&
    EXPRESSION_EMOTIONS.includes(value as FufuuEmotion)
  );
}

export default function Live2DViewer({
  onPetClick,
}: {
  onPetClick: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onPetClickRef = useRef(onPetClick);
  const [status, setStatus] = useState("Loading Furina…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onPetClickRef.current = onPetClick;
  }, [onPetClick]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let model: Live2DModel | null = null;
    let animationTime = 0;
    let pointerTargetX = 0;
    let pointerTargetY = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerDownAt: { x: number; y: number } | null = null;
    let pendingExpressionIndex: number | null = null;
    let lastExpressionIndex: number | null = null;

    let resizeObserver: ResizeObserver | null = null;
    let tickerCallback: ((delta: number) => void) | null = null;

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

    function fitModel() {
      const host = containerRef.current;

      if (disposed || !host || !model || model.destroyed) return;

      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);

      app.renderer.resize(width, height);
      model.scale.set(1);

      const bounds = model.getLocalBounds();

      if (
        !Number.isFinite(bounds.width) ||
        !Number.isFinite(bounds.height) ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        console.warn("[Fufuu] Model bounds are not ready:", bounds);
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
    }

    function updatePointer(event: PointerEvent) {
      if (!model || model.destroyed) return;

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      pointerTargetX = clamp(
        ((event.clientX - rect.left) / rect.width - 0.5) * 2,
        -1,
        1,
      );

      pointerTargetY = clamp(
        ((event.clientY - rect.top) / rect.height - 0.5) * 2,
        -1,
        1,
      );
    }

    function releasePointer() {
      pointerTargetX = 0;
      pointerTargetY = 0;
    }

    function rememberPointerDown(event: PointerEvent) {
      pointerDownAt = { x: event.clientX, y: event.clientY };
    }

    function handleCanvasClick(event: MouseEvent) {
      if (!model || model.destroyed) return;
      if (pointerDownAt) {
        const distance = Math.hypot(
          event.clientX - pointerDownAt.x,
          event.clientY - pointerDownAt.y,
        );
        pointerDownAt = null;
        if (distance > 8) return;
      }

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const x = ((event.clientX - rect.left) / rect.width) * app.screen.width;
      const y = ((event.clientY - rect.top) / rect.height) * app.screen.height;
      if (model.hitTest(x, y).length > 0 || model.getBounds().contains(x, y)) {
        onPetClickRef.current();
      }
    }

    async function activateExpression(index: number) {
      if (
        !model ||
        disposed ||
        model.destroyed ||
        index < 0 ||
        index >= EXPRESSION_EMOTIONS.length
      ) {
        return;
      }

      const settings = model.internalModel.settings as unknown as CubismSettings;
      const expressions = getExpressions(settings);
      const expression = expressions[index];

      if (!expression) {
        console.warn(`[Fufuu] No expression at index ${index}.`, settings);
        return;
      }

      const name = getExpressionName(expression);

      try {
        let activated = false;

        if (name) {
          const byName = await model.expression(name);

          if (disposed) return;
          activated = Boolean(byName);
        }

        if (!activated) {
          const byIndex = await model.expression(index);

          if (disposed) return;
          activated = Boolean(byIndex);
        }

        if (activated) {
          lastExpressionIndex = index;
          console.info(
            `[Fufuu] Expression activated: ${name ?? index}`,
          );
        } else {
          console.warn(`[Fufuu] Could not activate expression ${index + 1}.`);
        }
      } catch (error) {
        if (!disposed) {
          console.error(
            `[Fufuu] Error activating expression ${index + 1}:`,
            error,
          );
        }
      }
    }

    function handleEmotionMessage(event: MessageEvent<unknown>) {
      if (disposed || !isFufuuEmotion(event.data)) return;

      const index = EXPRESSION_EMOTIONS.indexOf(event.data);

      console.info("[Fufuu] Received AI emotion:", event.data);

      // Avoid repeatedly reloading the expression that's already active.
      if (index === lastExpressionIndex) return;

      // Keep only the latest emotion if the model hasn't loaded yet.
      if (!model || model.destroyed) {
        pendingExpressionIndex = index;
        return;
      }

      void activateExpression(index);
    }

    const emotionChannel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(EMOTION_CHANNEL)
        : null;

    emotionChannel?.addEventListener("message", handleEmotionMessage);

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;

      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }

      const expressionIndex = EXPRESSION_KEYS[event.key];

      if (expressionIndex === undefined) return;

      void activateExpression(expressionIndex);
    }

    canvas.addEventListener("pointermove", updatePointer);
    canvas.addEventListener("pointerdown", rememberPointerDown);
    canvas.addEventListener("pointerleave", releasePointer);
    canvas.addEventListener("click", handleCanvasClick);
    window.addEventListener("keydown", handleKeyDown);

    resizeObserver = new ResizeObserver(() => fitModel());
    resizeObserver.observe(container);

    async function loadModel() {
      try {
        console.info("[Fufuu] Loading model:", MODEL_URL);

        const loadedModel = await Live2DModel.from(MODEL_URL, {
          autoInteract: false,
        });

        if (disposed) {
          loadedModel.destroy();
          return;
        }

        model = loadedModel;
        model.anchor.set(0.5, 0.5);
        app.stage.addChild(model);

        fitModel();

        const settings = model.internalModel.settings as unknown as CubismSettings;
        const expressions = getExpressions(settings);

        console.info("[Fufuu] Model loaded.");
        console.info("[Fufuu] Expressions found:", expressions);

        if (expressions.length === 0) {
          console.error("[Fufuu] No expressions found in model settings.");
        } else {
          expressions.forEach((expression, index) => {
            console.info(
              `[Fufuu] Expression ${index + 1}:`,
              getExpressionName(expression),
              getExpressionFile(expression),
            );
          });
        }

        const core = model.internalModel.coreModel as unknown as CubismParameterAPI;

        tickerCallback = (delta: number) => {
          if (disposed || !model || model.destroyed) return;

          const dt = Math.min(delta / 60, 0.05);
          animationTime += dt;

          const trackingEase = 1 - Math.exp(-dt * 5);
          pointerX += (pointerTargetX - pointerX) * trackingEase;
          pointerY += (pointerTargetY - pointerY) * trackingEase;

          const rect = canvas.getBoundingClientRect();

          if (rect.width > 0 && rect.height > 0) {
            model.focus(
              rect.left + rect.width * (0.5 + pointerX * 0.35),
              rect.top + rect.height * (0.5 + pointerY * 0.25),
            );
          }

          setParameter(
            core,
            "ParamBreath",
            0.5 + Math.sin(animationTime * 1.15) * 0.1,
          );

          setParameter(
            core,
            "ParamBodyAngleZ",
            Math.sin(animationTime * 0.42),
          );
        };

        app.ticker.add(tickerCallback);

        setFailed(false);
        setStatus("");

        console.info("[Fufuu] Furina is ready.", {
          canvasConnected: canvas.isConnected,
          stageChildren: app.stage.children.length,
          expressionShortcuts: "1–7",
        });

        if (pendingExpressionIndex !== null) {
          const pendingIndex = pendingExpressionIndex;
          pendingExpressionIndex = null;
          void activateExpression(pendingIndex);
        }
      } catch (error) {
        console.error("[Fufuu] Model loading failed:", error);

        if (!disposed) {
          setFailed(true);
          setStatus("Couldn't load Furina. Check the console.");
        }
      }
    }

    void loadModel();

    return () => {
      disposed = true;

      resizeObserver?.disconnect();
      resizeObserver = null;

      emotionChannel?.removeEventListener("message", handleEmotionMessage);
      emotionChannel?.close();

      canvas.removeEventListener("pointermove", updatePointer);
      canvas.removeEventListener("pointerdown", rememberPointerDown);
      canvas.removeEventListener("pointerleave", releasePointer);
      canvas.removeEventListener("click", handleCanvasClick);
      window.removeEventListener("keydown", handleKeyDown);

      if (tickerCallback) {
        app.ticker.remove(tickerCallback);
        tickerCallback = null;
      }

      app.ticker.stop();

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

      console.info("[Fufuu] Live2D viewer cleaned up.");
    };
  }, []);

  return (
    <div className="fufuu-live2d-viewer">
      <div ref={containerRef} className="fufuu-live2d-canvas-host" />

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
