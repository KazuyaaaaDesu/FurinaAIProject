
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Live2DViewer from "./Live2DViewer";
import SpriteViewer from "./SpriteViewer";
import VRMViewer from "./VRMViewer";
import type { CharacterScreenGeometry } from "./desktopStage";
import type { PersonalityMode } from "./LumiPersonality";
import "./PetStageHost.css";

type DisplayMode = "png" | "2d" | "3d";

type StageSettings = {
  displayMode: DisplayMode;
  characterScale: number;
  characterX: number;
  characterY: number;
  facingDegrees: number;
  walkingSpeed: number;
  roamingEnabled: boolean;
};

const defaults: StageSettings = {
  displayMode: "png",
  characterScale: 1,
  characterX: 0,
  characterY: 0,
  facingDegrees: 0,
  walkingSpeed: 0.16,
  roamingEnabled: false,
};

type LumiEmotion =
  | "neutral"
  | "happy"
  | "pout"
  | "shy"
  | "smug"
  | "surprised"
  | "sparkle";

const DRAG_THRESHOLD = 6;

type PendingPointer = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: string) => void;
        addEventListener: (
          name: string,
          cb: (event: MessageEvent) => void,
        ) => void;
        removeEventListener: (
          name: string,
          cb: (event: MessageEvent) => void,
        ) => void;
      };
    };
  }
}

function post(type: string, extra: Record<string, unknown> = {}) {
  window.chrome?.webview?.postMessage(
    JSON.stringify({ type, ...extra }),
  );
}

function readValue<T>(
  source: Record<string, unknown>,
  camelCase: string,
  pascalCase: string,
  fallback: T,
): T {
  const value = source[camelCase] ?? source[pascalCase];

  return value === undefined || value === null
    ? fallback
    : (value as T);
}

function normalizeSettings(value: unknown): StageSettings {
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const raw = value as Record<string, unknown>;

  const mode = readValue<unknown>(
    raw,
    "displayMode",
    "DisplayMode",
    defaults.displayMode,
  );

  const displayMode: DisplayMode =
    mode === "png" || mode === "2d" || mode === "3d"
      ? mode
      : defaults.displayMode;

  const numberValue = (
    camelCase: string,
    pascalCase: string,
    fallback: number,
  ): number => {
    const value = readValue<unknown>(
      raw,
      camelCase,
      pascalCase,
      fallback,
    );

    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fallback;
  };

  const roamingValue = readValue<unknown>(
    raw,
    "roamingEnabled",
    "RoamingEnabled",
    defaults.roamingEnabled,
  );

  return {
    displayMode,
    characterScale: numberValue(
      "characterScale",
      "CharacterScale",
      defaults.characterScale,
    ),
    characterX: numberValue(
      "characterX",
      "CharacterX",
      defaults.characterX,
    ),
    characterY: numberValue(
      "characterY",
      "CharacterY",
      defaults.characterY,
    ),
    facingDegrees: numberValue(
      "facingDegrees",
      "FacingDegrees",
      defaults.facingDegrees,
    ),
    walkingSpeed: numberValue(
      "walkingSpeed",
      "WalkingSpeed",
      defaults.walkingSpeed,
    ),
    roamingEnabled:
      typeof roamingValue === "boolean"
        ? roamingValue
        : defaults.roamingEnabled,
  };
}

function isLumiEmotion(value: unknown): value is LumiEmotion {
  return (
    typeof value === "string" &&
    [
      "neutral",
      "happy",
      "pout",
      "shy",
      "smug",
      "surprised",
      "sparkle",
    ].includes(value.toLowerCase())
  );
}

function detectSpeechEmotion(
  message: Record<string, unknown>,
): LumiEmotion {
  const explicitEmotion = message.emotion;

  if (isLumiEmotion(explicitEmotion)) {
    return explicitEmotion.toLowerCase() as LumiEmotion;
  }

  const text = String(message.text ?? "").toLowerCase();

  if (
    text.includes("✨") ||
    text.includes("wow") ||
    text.includes("amazing") ||
    text.includes("brilliant")
  ) {
    return "sparkle";
  }

  if (
    text.includes("yay") ||
    text.includes("happy") ||
    text.includes("haha") ||
    text.includes("hahaha") ||
    text.includes("!") ||
    text.includes("glad") ||
    text.includes("wonderful")
  ) {
    return "happy";
  }

  if (
    text.includes("hmph") ||
    text.includes("hrph") ||
    text.includes("mph") ||
    text.includes("grr") ||
    text.includes("hm")
  ) {
    return "pout";
  }

  if (
    text.includes("~") ||
    text.includes("fuu") ||
    text.includes("shy") ||
    text.includes("embarrassed") ||
    text.includes("blush")
  ) {
    return "shy";
  }

  if (
    text.includes("?") ||
    text.includes("what") ||
    text.includes("wait") ||
    text.includes("huh") ||
    text.includes("really")
  ) {
    return "surprised";
  }

  if (
    text.includes("of course") ||
    text.includes("obviously") ||
    text.includes("naturally")
  ) {
    return "smug";
  }

  return "neutral";
}

export default function PetStageHost() {
  const [settings, setSettings] =
    useState<StageSettings>(defaults);

  const displayModeRef = useRef<DisplayMode>("png");
  const pendingPointerRef = useRef<PendingPointer | null>(null);

  const [status, setStatus] = useState("Loading Lumi...");
  const [speechText, setSpeechText] = useState<string | null>(null);
  const [personalityMode] =
    useState<PersonalityMode>("balanced");

  const toggleToolbar = useCallback(() => {
    post("open-control-menu");
  }, []);

  useEffect(() => {
    let bubbleTimeout: ReturnType<typeof setTimeout> | undefined;

    const showSpeech = (text: string, durationMs = 4000) => {
      setSpeechText(text);

      if (bubbleTimeout !== undefined) {
        clearTimeout(bubbleTimeout);
      }

      bubbleTimeout = setTimeout(() => {
        setSpeechText(null);
        bubbleTimeout = undefined;
      }, durationMs);
    };

    const receive = (event: MessageEvent) => {
      let message: unknown = event.data;

      if (typeof message === "string") {
        try {
          message = JSON.parse(message);
        } catch {
          return;
        }
      }

      if (!message || typeof message !== "object") {
        return;
      }

      const data = message as Record<string, unknown>;

      if (data.type === "settings" && data.settings) {
        const next = normalizeSettings(data.settings);

        displayModeRef.current = next.displayMode;
        setSettings(next);

        console.info("[PetStage] Settings received:", next);
      }

      if (data.type === "toggle-display-mode") {
        const modes: DisplayMode[] = ["png", "2d", "3d"];
        const currentIndex = modes.indexOf(
          displayModeRef.current,
        );
        const nextMode =
          modes[(currentIndex + 1) % modes.length];

        displayModeRef.current = nextMode;

        setSettings((current) => ({
          ...current,
          displayMode: nextMode,
        }));

        post("set-mode", { mode: nextMode });
      }

      if (data.type === "set-mode") {
        const mode = data.mode;

        if (mode === "png" || mode === "2d" || mode === "3d") {
          displayModeRef.current = mode;
          setSettings((current) => ({
            ...current,
            displayMode: mode,
          }));
        }
      }

      if (data.type === "behavior") {
        setStatus(`Lumi · ${String(data.behavior)}`);
      }

      if (
        data.type === "play-motion" &&
        typeof data.motionId === "string"
      ) {
        window.dispatchEvent(
          new CustomEvent("lumi:play-motion", {
            detail: data.motionId,
          }),
        );
      }

      if (
        data.type === "speak" &&
        typeof data.text === "string"
      ) {
        const duration =
          typeof data.duration === "number" &&
          Number.isFinite(data.duration) &&
          data.duration > 0
            ? data.duration
            : 4000;

        showSpeech(data.text, duration);

        const mood = detectSpeechEmotion(data);

        window.dispatchEvent(
          new CustomEvent("lumi:set-expression", {
            detail: mood,
          }),
        );

        console.info("[Lumi] Speech mood:", mood);
      }
    };

    window.chrome?.webview?.addEventListener("message", receive);
    window.addEventListener("message", receive);

    post("ready");

    return () => {
      window.chrome?.webview?.removeEventListener(
        "message",
        receive,
      );

      window.removeEventListener("message", receive);

      if (bubbleTimeout !== undefined) {
        clearTimeout(bubbleTimeout);
      }
    };
  }, []);

  const clicked = useCallback(
    (_geometry: CharacterScreenGeometry) => {
      post("pet-click");
    },
    [],
  );

  const cancelPendingDrag = useCallback(() => {
    pendingPointerRef.current = null;
  }, []);

  // Record the initial pointer position. Do not start native dragging yet,
  // because an immediate native drag can prevent double-click recognition.
  const beginCharacterDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary) {
        return;
      }

      const target = event.target;

      if (
        target instanceof Element &&
        target.closest("button, input, select, textarea")
      ) {
        return;
      }

      pendingPointerRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
      };
    },
    [],
  );

  // Start moving the WPF window only when the pointer has actually moved.
  const handleCharacterPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pending = pendingPointerRef.current;

      if (
        !pending ||
        pending.pointerId !== event.pointerId ||
        pending.dragging
      ) {
        return;
      }

      const dx = event.clientX - pending.startX;
      const dy = event.clientY - pending.startY;

      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
      }

      pending.dragging = true;
      pendingPointerRef.current = null;

      post("drag-start");
    },
    [],
  );

  const finishCharacterPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pending = pendingPointerRef.current;

      if (pending?.pointerId === event.pointerId) {
        cancelPendingDrag();
      }
    },
    [cancelPendingDrag],
  );

  const geometryChanged = useCallback(
    (_geometry: CharacterScreenGeometry | null) => {
      // Reserved for character geometry updates.
    },
    [],
  );

  const pointerInteractive = useCallback(
    (_interactive: boolean) => {
      // Reserved for native click-through state updates.
    },
    [],
  );

  const characterSettings = {
    characterScale: settings.characterScale,
    characterX: settings.characterX,
    characterY: settings.characterY,
    facingDegrees: settings.facingDegrees,
    walkingSpeed: settings.walkingSpeed,
  };

  const characterPositionStyle = {
    position: "absolute" as const,
    inset: 0,
    transform: "none",
    transformOrigin: "center center",
    pointerEvents: "none" as const,
  };

  return (
    <main
      className="pet-stage"
      aria-label="Lumi desktop pet"
      style={{
        pointerEvents: "auto",
        width: "100%",
        height: "100%",
        position: "relative",
      }}
      onDoubleClick={(event) => {
        const target = event.target;

        if (
          target instanceof Element &&
          target.closest("button, input, select, textarea")
        ) {
          return;
        }

        toggleToolbar();
      }}
    >
      <div
        className="pet-stage__status"
        style={{ pointerEvents: "auto" }}
      >
        {status}
      </div>

      {speechText && (
        <div
          className="speech-bubble-container"
          style={{ pointerEvents: "none" }}
        >
          <div className="speech-bubble">{speechText}</div>
        </div>
      )}

      <div
        className="pet-stage__character-position"
        style={characterPositionStyle}
        onPointerDownCapture={beginCharacterDrag}
        onPointerMoveCapture={handleCharacterPointerMove}
        onPointerUpCapture={finishCharacterPointer}
        onPointerCancelCapture={finishCharacterPointer}
        onLostPointerCapture={finishCharacterPointer}
      >
        {settings.displayMode === "png" ? (
          <SpriteViewer
            characterScale={1}
            onPetClick={clicked}
            onPointerInteractive={pointerInteractive}
            onCharacterGeometryChange={geometryChanged}
          />
        ) : settings.displayMode === "3d" ? (
          <VRMViewer
            roamingEnabled={settings.roamingEnabled}
            autonomousBehaviorEnabled={settings.roamingEnabled}
            personalityMode={personalityMode}
            onPetClick={clicked}
            onPointerInteractive={pointerInteractive}
            onCharacterGeometryChange={geometryChanged}
            characterSettings={characterSettings}
          />
        ) : (
          <Live2DViewer
            characterScale={1}
            onPetClick={clicked}
            onPointerInteractive={pointerInteractive}
            onCharacterGeometryChange={geometryChanged}
          />
        )}
      </div>
    </main>
  );
}
