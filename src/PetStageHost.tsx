
import { useCallback, useEffect, useRef, useState } from "react";
import Live2DViewer from "./Live2DViewer";
import SpriteViewer from "./SpriteViewer";

// TEMPORARILY DISABLED:
// To restore 3D later:
// 1. Uncomment the VRMViewer import below.
// 2. Restore "3d" in the StageSettings displayMode type.
// 3. Restore "3d" mode validation in the settings receiver.
// 4. Restore the three-mode toggle cycle in the message handler.
// 5. Restore the VRMViewer rendering branch below.
// 6. Re-enable the 3D option in the WPF toolbar.
// import VRMViewer from "./VRMViewer";

import type { CharacterScreenGeometry } from "./desktopStage";
import "./PetStageHost.css";

type StageSettings = {
  displayMode: "png" | "2d";
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

function post(
  type: string,
  extra: Record<string, unknown> = {},
) {
  window.chrome?.webview?.postMessage(
    JSON.stringify({ type, ...extra }),
  );
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

  const displayModeRef =
    useRef<StageSettings["displayMode"]>("png");

  // Force PNG only on the first settings message.
  const initialSettingsReceived = useRef(false);

  const [status, setStatus] = useState("Loading Lumi...");
  const [speechText, setSpeechText] = useState<string | null>(null);

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
        const incoming =
          data.settings as Partial<StageSettings>;

        const requestedMode: StageSettings["displayMode"] =
          incoming.displayMode === "2d" ? "2d" : "png";

        // PNG is the initial mode, regardless of the saved mode.
        // Subsequent settings updates can select PNG or Live2D.
        const displayMode = initialSettingsReceived.current
          ? requestedMode
          : "png";

        initialSettingsReceived.current = true;
        displayModeRef.current = displayMode;

        setSettings((current) => ({
          ...current,
          ...defaults,
          ...incoming,
          displayMode,
        }));

        // Tell WPF that PNG was selected for initial startup.
        if (displayMode !== requestedMode) {
          post("set-mode", { mode: "png" });
        }
      }

      if (data.type === "toggle-display-mode") {
        // TEMPORARY TWO-MODE CYCLE: PNG <-> Live2D.
        const nextMode: StageSettings["displayMode"] =
          displayModeRef.current === "png" ? "2d" : "png";

        displayModeRef.current = nextMode;

        setSettings((current) => ({
          ...current,
          displayMode: nextMode,
        }));

        post("set-mode", { mode: nextMode });
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

  const clicked = (_geometry: CharacterScreenGeometry) => {
    post("pet-click");
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

  return (
    <main
      className="pet-stage"
      aria-label="Lumi desktop pet"
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

      {settings.displayMode === "png" ? (
        <SpriteViewer
          characterScale={settings.characterScale}
          onPetClick={clicked}
          onPointerInteractive={pointerInteractive}
          onCharacterGeometryChange={geometryChanged}
        />
      ) : (
        <Live2DViewer
          characterScale={settings.characterScale}
          onPetClick={clicked}
          onPointerInteractive={pointerInteractive}
          onCharacterGeometryChange={geometryChanged}
        />
      )}

      {/*
        TO RESTORE 3D LATER:
        1. Uncomment the VRMViewer import.
        2. Add "3d" to StageSettings.displayMode.
        3. Restore 3D settings validation.
        4. Restore the three-mode toggle cycle.
        5. Restore the VRMViewer rendering branch.
        6. Re-enable the WPF toolbar's 3D option.
        7. Rebuild the React assets used by WebView2.
      */}
    </main>
  );
}
