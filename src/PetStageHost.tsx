
import { useCallback, useEffect, useState } from "react";
import Live2DViewer from "./Live2DViewer";
import VRMViewer from "./VRMViewer";
import type { CharacterScreenGeometry } from "./desktopStage";
import type { PersonalityMode } from "./fufuuPersonality";
import "./PetStageHost.css";

type StageSettings = {
  displayMode: "2d" | "3d";
  characterScale: number;
  characterX: number;
  characterY: number;
  facingDegrees: number;
  walkingSpeed: number;
  roamingEnabled: boolean;
};

const defaults: StageSettings = {
  displayMode: "2d",
  characterScale: 1,
  characterX: 0,
  characterY: 0,
  facingDegrees: 0,
  walkingSpeed: 0.16,
  roamingEnabled: false,
};

type FufuuEmotion =
  | "neutral"
  | "happy"
  | "pout"
  | "shy"
  | "smug"
  | "surprised"
  | "sparkle";

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

function isFufuuEmotion(value: unknown): value is FufuuEmotion {
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
): FufuuEmotion {
  const explicitEmotion = message.emotion;

  if (isFufuuEmotion(explicitEmotion)) {
    return explicitEmotion.toLowerCase() as FufuuEmotion;
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

  const [status, setStatus] = useState("Loading Fufuu…");
  const [speechText, setSpeechText] = useState<string | null>(null);
  const [personalityMode] =
    useState<PersonalityMode>("balanced");

  const toggleToolbar = useCallback(() => {
    post("open-control-menu");
  }, []);

  // Receive WPF/WebView2 messages.
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
        const incoming = data.settings as Partial<StageSettings>;

        setSettings({
          ...defaults,
          ...incoming,
          displayMode: incoming.displayMode === "3d" ? "3d" : "2d",
        });
      }

      if (data.type === "behavior") {
        setStatus(`Fufuu · ${String(data.behavior)}`);
      }

      if (
        data.type === "play-motion" &&
        typeof data.motionId === "string"
      ) {
        window.dispatchEvent(
          new CustomEvent("fufuu:play-motion", {
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
          new CustomEvent("fufuu:set-expression", {
            detail: mood,
          }),
        );

        console.info("[Fufuu] Speech mood:", mood);
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

  // Single-click only sends the pet reaction message.
  const clicked = (_geometry: CharacterScreenGeometry) => {
    post("pet-click");
    // Do NOT call toggleToolbar() or open any menu here!
  };

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

  return (
    <main
      className="pet-stage"
      aria-label="Fufuu desktop pet"
      style={{
        pointerEvents: "none",
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
          style={{ pointerEvents: "auto" }}
        >
          <div className="speech-bubble">{speechText}</div>
        </div>
      )}

      {settings.displayMode === "3d" ? (
        <VRMViewer
          roamingEnabled={settings.roamingEnabled}
          autonomousBehaviorEnabled={false}
          personalityMode={personalityMode}
          onPetClick={clicked}
          onPointerInteractive={pointerInteractive}
          onCharacterGeometryChange={geometryChanged}
          characterSettings={characterSettings}
        />
      ) : (
        <Live2DViewer
          characterScale={settings.characterScale}
          onPetClick={clicked}
          onPointerInteractive={pointerInteractive}
          onCharacterGeometryChange={geometryChanged}
        />
      )}
    </main>
  );
}
