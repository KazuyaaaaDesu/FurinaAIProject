
import { memo, useEffect, useRef, useState } from "react";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { CharacterScreenGeometry } from "./desktopStage";
import "./Live2DViewer.css";

Live2DModel.registerTicker(PIXI.Ticker);

const MODEL_URL = new URL("/models/furina-live2d/Furina.model3.json", window.location.origin).href;
const EMOTION_CHANNEL = "lumi-avatar-emotion";

type LumiEmotion =
  | "neutral"
  | "happy"
  | "pout"
  | "shy"
  | "smug"
  | "surprised"
  | "sparkle";

const EMOTION_INDEX: Record<LumiEmotion, number> = {
  neutral: 0,
  happy: 1,
  pout: 2,
  shy: 3,
  smug: 4,
  surprised: 5,
  sparkle: 6,
};

const INDEX_EMOTION: LumiEmotion[] = [
  "neutral",
  "happy",
  "pout",
  "shy",
  "smug",
  "surprised",
  "sparkle",
];

type Live2DViewerProps = {
  characterScale?: number;
  onPetClick?: (geometry: CharacterScreenGeometry) => void;
  onPointerInteractive?: (interactive: boolean) => void;
  onCharacterGeometryChange?: (
    geometry: CharacterScreenGeometry | null,
  ) => void;
};

type Live2DExpression = {
  Name?: string;
  name?: string;
  File?: string;
  file?: string;
};

function getExpressions(model: Live2DModel): Live2DExpression[] {
  const settings = model.internalModel?.settings as
    | { expressions?: Live2DExpression[] }
    | undefined;

  return Array.isArray(settings?.expressions)
    ? settings.expressions
    : [];
}

function getExpressionName(
  expression: Live2DExpression,
): string | undefined {
  return expression.Name ?? expression.name;
}

function getExpressionFile(
  expression: Live2DExpression,
): string | undefined {
  return expression.File ?? expression.file;
}

function isLumiEmotion(value: unknown): value is LumiEmotion {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      EMOTION_INDEX,
      value.toLowerCase(),
    )
  );
}

function isHostMouseMessage(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }

  const message = data as Record<string, unknown>;

  return (
    message.type === "host-mouse" ||
    message.type === "mouse-position"
  );
}

function setParameter(
  model: Live2DModel,
  parameterId: string,
  value: number,
  weight = 1,
): void {
  try {
    const coreModel = model.internalModel?.coreModel as
      | {
          setParameterValueById?: (
            id: string,
            value: number,
            weight?: number,
          ) => void;
        }
      | undefined;

    coreModel?.setParameterValueById?.(
      parameterId,
      value,
      weight,
    );
  } catch (err) { console.error("[Live2D Error] Failed to load model:", err); }
}

function Live2DViewer({
  characterScale = 1,
  onPetClick,
  onPointerInteractive,
  onCharacterGeometryChange,
}: Live2DViewerProps) {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);

  const activateExpressionRef = useRef<
    ((index: number) => void) | null
  >(null);

  const characterScaleRef = useRef(characterScale);
  const fitModelRef = useRef<(() => void) | null>(null);

  // Keep the newest callbacks without restarting the PIXI application.
  const onPetClickRef = useRef(onPetClick);
  const onPointerInteractiveRef = useRef(onPointerInteractive);
  const onGeometryChangeRef = useRef(onCharacterGeometryChange);

  onPetClickRef.current = onPetClick;
  onPointerInteractiveRef.current = onPointerInteractive;
  onGeometryChangeRef.current = onCharacterGeometryChange;

  const [status, setStatus] = useState("Loading Live2D…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    characterScaleRef.current = characterScale;
    fitModelRef.current?.();
  }, [characterScale]);

  // Receive expression requests from PetStageHost.
  useEffect(() => {
    const handleExpression = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      let index: number | null = null;

      if (typeof detail === "number" && Number.isInteger(detail)) {
        index = detail;
      } else if (isLumiEmotion(detail)) {
        index = EMOTION_INDEX[detail.toLowerCase() as LumiEmotion];
      }

      if (
        index === null ||
        index < 0 ||
        index >= INDEX_EMOTION.length
      ) {
        console.warn(
          "[Lumi Live2D] Invalid expression:",
          detail,
        );
        return;
      }

      const activate = activateExpressionRef.current;

      if (activate) {
        activate(index);
      } else {
        console.debug(
          "[Lumi Live2D] Expression requested before model is ready:",
          detail,
        );
      }
    };

    window.addEventListener("Lumi:set-expression", handleExpression);

    return () => {
      window.removeEventListener(
        "Lumi:set-expression",
        handleExpression,
      );
    };
  }, []);

  useEffect(() => {
    const host = canvasHostRef.current;

    if (!host) {
      return;
    }

    let cancelled = false;
    let model: Live2DModel | null = null;
    let app: PIXI.Application | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let emotionChannel: BroadcastChannel | null = null;
    let pendingExpressionIndex: number | null = null;

    let lastPointerX = 0;
    let lastPointerY = 0;
    let pointerInside = false;
    let lastGeometryReport = 0;

    disposedRef.current = false;

    const reportGeometry = () => {
      if (!model || !app || cancelled) {
        return;
      }

      const now = performance.now();

      if (now - lastGeometryReport < 100) {
        return;
      }

      lastGeometryReport = now;

      const bounds = model.getBounds();
      const rect = host.getBoundingClientRect();

      // Preserve the geometry fields used by the existing desktop stage.
      // Additional fields required by CharacterScreenGeometry should be
      // populated here if its interface requires them.
      const geometry = {
        x: rect.left + bounds.x,
        y: rect.top + bounds.y,
        left: rect.left + bounds.x,
        top: rect.top + bounds.y,
        width: bounds.width,
        height: bounds.height,
        centerX: rect.left + bounds.x + bounds.width / 2,
        centerY: rect.top + bounds.y + bounds.height / 2,
      } as unknown as CharacterScreenGeometry;

      onGeometryChangeRef.current?.(geometry);
    };

    const fitModel = () => {
      if (!model || !app || cancelled) {
        return;
      }

      const width = host.clientWidth;
      const height = host.clientHeight;

      if (width <= 0 || height <= 0) {
        return;
      }

      app.renderer.resize(width, height);

      model.scale.set(1);
      model.anchor.set(0.5, 0.5);

      const bounds = model.getLocalBounds();

      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }

      const fitScale = Math.min(
        (width * 0.94) / bounds.width,
        (height * 0.94) / bounds.height,
      );

      const scale =
        fitScale * Math.max(0.1, characterScaleRef.current);

      model.scale.set(scale);
      model.position.set(width / 2, height / 2);

      reportGeometry();
    };

    fitModelRef.current = fitModel;

    const activateExpression = (index: number) => {
      if (!model || cancelled || disposedRef.current) {
        pendingExpressionIndex = index;
        return;
      }

      const expressions = getExpressions(model);

      if (expressions.length === 0) {
        console.warn(
          "[Lumi Live2D] This model has no configured expressions.",
        );
        return;
      }

      const expression = expressions[index];

      if (!expression) {
        console.warn(
          `[Lumi Live2D] Expression index ${index} does not exist. ` +
            `Model contains ${expressions.length} expressions.`,
        );
        return;
      }

      const expressionName = getExpressionName(expression);
      const expressionFile = getExpressionFile(expression);

      try {
        if (expressionName) {
          void model.expression(expressionName);
        } else {
          void model.expression(index);
        }

        console.info(
          "[Lumi Live2D] Expression activated:",
          expressionName ?? expressionFile ?? index,
        );
      } catch (expressionError) {
        console.error(
          "[Lumi Live2D] Failed to activate expression:",
          expressionError,
        );
      }
    };

    activateExpressionRef.current = activateExpression;

    const playMotion = (motionId: string) => {
      if (!model || cancelled || disposedRef.current) {
        return;
      }

      try {
        switch (motionId.toLowerCase()) {
          case "idle":
            void model.motion("Idle");
            break;

          case "wave":
            void model.motion("Tap");
            break;

          default:
            void model.motion(motionId);
            break;
        }
      } catch (motionError) {
        console.warn(
          "[Lumi Live2D] Could not play motion:",
          motionId,
          motionError,
        );
      }
    };

    const handleMotionEvent = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;

      if (typeof detail === "string") {
        playMotion(detail);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          event.target.tagName,
        )
      ) {
        return;
      }

      if (event.key >= "1" && event.key <= "7") {
        activateExpression(Number(event.key) - 1);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      lastPointerX = (event.clientX - rect.left) / rect.width;
      lastPointerY = (event.clientY - rect.top) / rect.height;

      pointerInside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      onPointerInteractiveRef.current?.(pointerInside);
    };

    const handlePointerLeave = () => {
      pointerInside = false;
      onPointerInteractiveRef.current?.(false);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!model || !app || cancelled) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const bounds = model.getBounds();

      const hit =
        localX >= bounds.x &&
        localX <= bounds.x + bounds.width &&
        localY >= bounds.y &&
        localY <= bounds.y + bounds.height;

      if (!hit) {
        return;
      }

      const geometry = {
        x: rect.left + bounds.x,
        y: rect.top + bounds.y,
        left: rect.left + bounds.x,
        top: rect.top + bounds.y,
        width: bounds.width,
        height: bounds.height,
        centerX: rect.left + bounds.x + bounds.width / 2,
        centerY: rect.top + bounds.y + bounds.height / 2,
      } as unknown as CharacterScreenGeometry;

      onPetClickRef.current?.(geometry);
      playMotion("Tap");
    };

    const handleHostMessage = (event: MessageEvent) => {
      let data: unknown = event.data;

      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }

      if (!isHostMouseMessage(data)) {
        return;
      }

      const message = data as Record<string, unknown>;

      if (
        typeof message.x === "number" &&
        typeof message.y === "number"
      ) {
        lastPointerX = message.x;
        lastPointerY = message.y;
        pointerInside = true;
      }
    };

    const handleEmotionBroadcast = (event: MessageEvent) => {
      const data = event.data as
        | string
        | { emotion?: unknown; mood?: unknown }
        | undefined;

      let emotion: unknown = data;

      if (data && typeof data === "object") {
        emotion = data.emotion ?? data.mood;
      }

      if (isLumiEmotion(emotion)) {
        activateExpression(
          EMOTION_INDEX[emotion.toLowerCase() as LumiEmotion],
        );
      }
    };

    const loadModel = async () => {
      try {
        setStatus("Loading Furina model…");
        setError(null);

        app = new PIXI.Application({
          width: Math.max(1, host.clientWidth),
          height: Math.max(1, host.clientHeight),
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.max(1, window.devicePixelRatio || 1),
          autoStart: true,
        });

        // PIXI creates and owns the canvas.
        host.replaceChildren(app.view as HTMLCanvasElement);

        model = await Live2DModel.from(MODEL_URL, {
          autoInteract: false,
        });

        if (cancelled || disposedRef.current) {
          model.destroy();
          model = null;
          return;
        }

        app.stage.addChild(model);

        model.anchor.set(0.5, 0.5);
        model.interactive = true;
        model.cursor = "pointer";

        fitModel();

        app.ticker.add(() => {
          if (!model || cancelled || disposedRef.current) {
            return;
          }

          if (pointerInside) {
            const x = (lastPointerX - 0.5) * 2;
            const y = (lastPointerY - 0.5) * 2;

            setParameter(model, "ParamAngleX", x * 25);
            setParameter(model, "ParamAngleY", y * -15);
            setParameter(model, "ParamBodyAngleX", x * 8);
            setParameter(model, "ParamEyeBallX", x);
            setParameter(model, "ParamEyeBallY", -y);
          } else {
            setParameter(model, "ParamAngleX", 0, 0.05);
            setParameter(model, "ParamAngleY", 0, 0.05);
            setParameter(model, "ParamBodyAngleX", 0, 0.05);
            setParameter(model, "ParamEyeBallX", 0, 0.05);
            setParameter(model, "ParamEyeBallY", 0, 0.05);
          }
        });

        resizeObserver = new ResizeObserver(() => {
          fitModel();
        });

        resizeObserver.observe(host);

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerleave", handlePointerLeave);
        window.addEventListener("pointerdown", handlePointerDown);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("message", handleHostMessage);
        window.addEventListener(
          "Lumi:play-motion",
          handleMotionEvent,
        );

        try {
          emotionChannel = new BroadcastChannel(EMOTION_CHANNEL);
          emotionChannel.addEventListener(
            "message",
            handleEmotionBroadcast,
          );
        } catch {
          emotionChannel = null;
        }

        setStatus("Lumi is ready");
        window.setTimeout(() => {
          if (!cancelled) {
            setStatus("");
          }
        }, 1500);

        if (pendingExpressionIndex !== null) {
          const pending = pendingExpressionIndex;
          pendingExpressionIndex = null;
          activateExpression(pending);
        }

        reportGeometry();
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        console.error(
          "[Lumi Live2D] Model loading failed:",
          loadError,
        );

        setStatus("Live2D failed to load");
        setError(
          loadError instanceof Error
            ? loadError.message
            : String(loadError),
        );
      }
    };

    void loadModel();

    return () => {
      cancelled = true;
      disposedRef.current = true;

      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleHostMessage);
      window.removeEventListener(
        "Lumi:play-motion",
        handleMotionEvent,
      );

      resizeObserver?.disconnect();

      emotionChannel?.removeEventListener(
        "message",
        handleEmotionBroadcast,
      );
      emotionChannel?.close();

      activateExpressionRef.current = null;
      fitModelRef.current = null;

      if (model) {
        try {
          model.destroy();
        } catch (destroyError) {
          console.warn(
            "[Lumi Live2D] Model cleanup warning:",
            destroyError,
          );
        }
      }

      if (app) {
        try {
          app.destroy(true);
        } catch (destroyError) {
          console.warn(
            "[Lumi Live2D] PIXI cleanup warning:",
            destroyError,
          );
        }
      }

      host.replaceChildren();

      onGeometryChangeRef.current?.(null);
      onPointerInteractiveRef.current?.(false);
    };
  }, []);

  return (
    <div className="Lumi-live2d-viewer">
      <div
        ref={canvasHostRef}
        className="Lumi-live2d-canvas-host"
      />

      {status && (
        <div className="Lumi-live2d-status">
          {status}
        </div>
      )}

      {error && (
        <div className="Lumi-live2d-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export default memo(Live2DViewer);





