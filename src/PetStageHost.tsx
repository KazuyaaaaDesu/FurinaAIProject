import { useEffect, useState } from "react";
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

type ToolbarTab = "main" | "motions" | "settings";

function post(type: string, extra: Record<string, unknown> = {}) {
  window.chrome?.webview?.postMessage(JSON.stringify({ type, ...extra }));
}

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: string) => void;
        addEventListener: (
          name: string,
          cb: (event: MessageEvent) => void
        ) => void;
        removeEventListener: (
          name: string,
          cb: (event: MessageEvent) => void
        ) => void;
      };
    }
  }
}

export default function PetStageHost() {
  const [settings, setSettings] = useState<StageSettings>(defaults);
  const [status, setStatus] = useState("Loading Fufuu…");

  // Toolbar visibility: hidden by default.
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ToolbarTab>("main");

  // Speech bubble state.
  const [speechText, setSpeechText] = useState<string | null>(null);

  const [personalityMode, setPersonalityMode] =
    useState<PersonalityMode>("balanced");

  // Keyboard shortcut: Ctrl + Alt + T toggles the toolbar.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.altKey &&
        event.key.toLowerCase() === "t"
      ) {
        event.preventDefault();
        setToolbarOpen((previous) => !previous);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Receive messages from the WPF/WebView2 host.
  useEffect(() => {
    let bubbleTimeout: ReturnType<typeof setTimeout> | undefined;

    const showSpeech = (text: string, durationMs = 4000) => {
      setSpeechText(text);

      if (bubbleTimeout !== undefined) {
        clearTimeout(bubbleTimeout);
      }

      bubbleTimeout = setTimeout(() => {
        setSpeechText(null);
      }, durationMs);
    };

    const receive = (event: MessageEvent) => {
      let message: any = event.data;

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

      if (message.type === "settings" && message.settings) {
        const next = {
          ...defaults,
          ...message.settings,
        } as StageSettings;

        setSettings(next);
      }

      if (message.type === "behavior") {
        setStatus(`Fufuu · ${String(message.behavior)}`);
      }

      if (
        message.type === "play-motion" &&
        typeof message.motionId === "string"
      ) {
        window.dispatchEvent(
          new CustomEvent("fufuu:play-motion", {
            detail: message.motionId,
          })
        );
      }

      if (
        message.type === "speak" &&
        typeof message.text === "string"
      ) {
        showSpeech(message.text, message.duration || 4000);
      }

      
      // Handle global hotkey messages from the WPF host.
      if (message.type === "toggle-toolbar") {
        setToolbarOpen((previous) => !previous);
        setActiveTab("main");
      }

      // Allow the WPF host to explicitly show or hide the toolbar.
      if (message.type === "toolbar") {
        if (typeof message.visible === "boolean") {
          setToolbarOpen(message.visible);
          if (message.visible) {
            setActiveTab("main");
          }
        } else {
          setToolbarOpen((previous) => !previous);
          setActiveTab("main");
        }
      }
    };

    window.chrome?.webview?.addEventListener("message", receive);
    window.addEventListener("message", receive);

    post("ready");

    return () => {
      window.chrome?.webview?.removeEventListener("message", receive);
      window.removeEventListener("message", receive);

      if (bubbleTimeout !== undefined) {
        clearTimeout(bubbleTimeout);
      }
    };
  }, []);

  const geometryChanged = (
    _geometry: CharacterScreenGeometry | null
  ) => {};

  const clicked = (_geometry: CharacterScreenGeometry) => {
    post("pet-click");

    // Single-click opens the toolbar, preserving your existing behavior.
    setToolbarOpen(true);
    setActiveTab("main");
  };

  const pointerInteractive = (_interactive: boolean) => {};

  const toggleToolbar = () => {
    setToolbarOpen((previous) => !previous);
  };

  const characterSettings = {
    characterScale: settings.characterScale,
    characterX: settings.characterX,
    characterY: settings.characterY,
    facingDegrees: settings.facingDegrees,
    walkingSpeed: settings.walkingSpeed,
  };

  const updateSettingField = (
    field: keyof StageSettings,
    value: number | boolean | string
  ) => {
    const updated = {
      ...settings,
      [field]: value,
    } as StageSettings;

    setSettings(updated);
    post("update-settings", { settings: updated });
  };

  return (
    <main
      className="pet-stage"
      aria-label="Fufuu desktop pet"
      style={{ pointerEvents: "none", width: "100%", height: "100%", position: "relative" }}
      onDoubleClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("button, input, select, textarea, .fufuu-toolbar")
        ) {
          return;
        }
        toggleToolbar();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && event.button === 0) {
          post("drag-start");
        }
      }}
    >
      <div className="pet-stage__status" style={{ pointerEvents: "auto" }}>{status}</div>

      {/* Speech bubble overlay */}
      {speechText && (
        <div className="speech-bubble-container" style={{ pointerEvents: "auto" }}>
          <div className="speech-bubble">{speechText}</div>
        </div>
      )}

      {/* Fufuu toolbar: hidden until opened */}
      {toolbarOpen && (
        <div
          className="fufuu-toolbar"
          onDoubleClick={(event) => event.stopPropagation()}
          style={{
            pointerEvents: "auto", // <-- THIS IS WHAT MAKES IT CLICKABLE!
            position: "absolute",
            top: "18%",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 150,
            background: "rgba(23, 18, 32, 0.96)",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            borderRadius: "12px",
            padding: "10px",
            width: "220px",
            backdropFilter: "blur(12px)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "8px",
              borderBottom: "1px solid rgba(255,255,255,0.1)",
              paddingBottom: "6px",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: "#f4e8fa",
                letterSpacing: "0.5px",
              }}
            >
              FUFUU CONTROL
            </span>

            <button
              onClick={() => setToolbarOpen(false)}
              style={{
                background: "transparent",
                border: "none",
                color: "#ff6b6b",
                cursor: "pointer",
                fontSize: "12px",
              }}
              aria-label="Close toolbar"
              title="Close toolbar"
            >
              ✕
            </button>
          </div>

          {activeTab === "main" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <button
                onClick={() =>
                  post("set-mode", {
                    mode: settings.displayMode === "2d" ? "3d" : "2d",
                  })
                }
                style={menuBtnStyle()}
              >
                Switch to{" "}
                {settings.displayMode === "2d"
                  ? "3D (VRM)"
                  : "2D (Live2D)"}
              </button>

              <button
                onClick={() => post("open-chat")}
                style={menuBtnStyle()}
              >
                💬 Open Chat
              </button>

              <button
                onClick={() => setActiveTab("motions")}
                style={menuBtnStyle()}
              >
                ✨ Animations &amp; Motions
              </button>

              <button
                onClick={() => setActiveTab("settings")}
                style={menuBtnStyle()}
              >
                ⚙️ Pet Preferences
              </button>

              <button
                onClick={() => post("toggle-roam")}
                style={menuBtnStyle()}
              >
                {settings.roamingEnabled
                  ? "⏹ Stop Roaming"
                  : "⇄ Start Roaming"}
              </button>

              <button
                onClick={() => post("close")}
                style={{
                  ...menuBtnStyle(),
                  color: "#ff6b6b",
                }}
              >
                ✕ Quit Pet
              </button>
            </div>
          )}

          {activeTab === "motions" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("fufuu:play-motion", {
                      detail: "wave",
                    })
                  )
                }
                style={menuBtnStyle()}
              >
                Wave 👋
              </button>

              <button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("fufuu:play-motion", {
                      detail: "idle",
                    })
                  )
                }
                style={menuBtnStyle()}
              >
                Idle 🧘
              </button>

              <button
                onClick={() => setActiveTab("main")}
                style={{
                  ...menuBtnStyle(),
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                ← Back
              </button>
            </div>
          )}

          {activeTab === "settings" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                fontSize: "11px",
                color: "#d8c4e0",
              }}
            >
              <label
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                Scale: {settings.characterScale.toFixed(2)}x

                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.05"
                  value={settings.characterScale}
                  onChange={(event) =>
                    updateSettingField(
                      "characterScale",
                      parseFloat(event.target.value)
                    )
                  }
                  style={{
                    width: "90px",
                    accentColor: "#8c4a7c",
                  }}
                />
              </label>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>Personality</span>

                <select
                  value={personalityMode}
                  onChange={(event) =>
                    setPersonalityMode(
                      event.target.value as PersonalityMode
                    )
                  }
                  style={{
                    background: "#2a1e36",
                    color: "#fff",
                    border: "1px solid #523861",
                    borderRadius: "4px",
                    padding: "2px 4px",
                    fontSize: "10px",
                  }}
                >
                  <option value="balanced">Balanced</option>
                  <option value="chill">Chill</option>
                  <option value="hyper">Hyper</option>
                </select>
              </div>

              <button
                onClick={() => setActiveTab("main")}
                style={{
                  ...menuBtnStyle(),
                  background: "rgba(255,255,255,0.04)",
                  marginTop: "4px",
                }}
              >
                ← Back
              </button>
            </div>
          )}
        </div>
      )}

      {/* Character renderer */}
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
          onPetClick={clicked}
          onPointerInteractive={pointerInteractive}
          onCharacterGeometryChange={geometryChanged}
        />
      )}
    </main>
  );
}

function menuBtnStyle(): React.CSSProperties {
  return {
    background: "rgba(255, 255, 255, 0.07)",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    borderRadius: "6px",
    color: "#f4e8fa",
    padding: "6px 10px",
    cursor: "pointer",
    font: "11px Segoe UI, sans-serif",
    textAlign: "left",
    width: "100%",
    transition: "background 0.15s",
  };
}