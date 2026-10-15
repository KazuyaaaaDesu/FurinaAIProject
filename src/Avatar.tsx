import { useEffect, useRef, useState } from "react";
import {
  isMotionManifest,
  type MotionDefinition,
} from "./petBehavior";
import "./Avatar.css";
import Live2DViewer from "./Live2DViewer";
import VRMViewer from "./VRMViewer";

type DisplayMode = "2d" | "3d";
type ToolbarPanel = "interact" | "memories" | "motions" | "settings";

type RoamingState = {
  enabled: boolean;
  moving: boolean;
};

const INITIAL_ROAMING_STATE: RoamingState = {
  enabled: false,
  moving: false,
};

const MEMORY_COMMAND_KEY = "fufuu-avatar-command";
const AVATAR_COMMAND_CHANNEL = "fufuu-avatar-command";
const forceThreeDimensional =
  new URLSearchParams(window.location.search).get("debugMotions") === "1";

export default function Avatar() {
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() =>
    forceThreeDimensional ||
    window.localStorage.getItem("fufuu-display-mode") === "3d"
      ? "3d"
      : "2d",
  );
  const [roaming, setRoaming] = useState<RoamingState>(INITIAL_ROAMING_STATE);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [toolbarPanel, setToolbarPanel] = useState<ToolbarPanel | null>(null);
  const [motions, setMotions] = useState<MotionDefinition[]>([]);
  const [motionLoadError, setMotionLoadError] = useState("");
  const [pendingMotionId, setPendingMotionId] = useState<string | null>(null);
  const [speechBubbleEnabled, setSpeechBubbleEnabled] = useState(false);
  const [toolbarActionError, setToolbarActionError] = useState("");
  const toolbarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.body.classList.add("avatar-mode");

    const syncMode = (mode: DisplayMode) => {
      const nextMode = forceThreeDimensional ? "3d" : mode;
      setDisplayMode(nextMode);

      if (!forceThreeDimensional) {
        window.localStorage.setItem("fufuu-display-mode", nextMode);
      }
    };

    const unsubscribeMode = window.sakuraDesktop?.onDisplayMode?.(syncMode);
    const unsubscribeRoaming =
      window.sakuraDesktop?.onRoamingState?.(setRoaming);

    const roamingStateRequest =
      window.sakuraDesktop?.getRoamingState?.();
    if (roamingStateRequest) {
      void roamingStateRequest
        .then(setRoaming)
        .catch((error: unknown) => {
          console.warn("Could not read desktop roaming state:", error);
        });
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "fufuu-display-mode") return;

      if (event.newValue === "2d" || event.newValue === "3d") {
        syncMode(event.newValue);
      }
    };

    const channel = new BroadcastChannel("fufuu-display-mode");
    const handleBroadcast = (event: MessageEvent) => {
      if (event.data === "2d" || event.data === "3d") {
        syncMode(event.data);
      }
    };

    const unsubscribeBubble =
      window.sakuraDesktop?.onSpeechBubbleEnabled?.(setSpeechBubbleEnabled);
    const speechBubbleStateRequest =
      window.sakuraDesktop?.getSpeechBubbleState?.();
    if (speechBubbleStateRequest) {
      void speechBubbleStateRequest
        .then((state) => setSpeechBubbleEnabled(state.enabled))
        .catch((error: unknown) => {
          console.warn("Could not read speech-bubble state:", error);
        });
    }

    channel.addEventListener("message", handleBroadcast);
    window.addEventListener("storage", handleStorage);

    return () => {
      document.body.classList.remove("avatar-mode");
      window.removeEventListener("storage", handleStorage);
      channel.removeEventListener("message", handleBroadcast);
      channel.close();
      unsubscribeMode?.();
      unsubscribeRoaming?.();
      unsubscribeBubble?.();
    };
  }, []);

  useEffect(() => {
    window.sakuraDesktop?.setDisplayMode?.(displayMode);
  }, [displayMode]);

  useEffect(() => {
    if (
      toolbarPanel !== "motions" &&
      toolbarPanel !== "interact"
    ) {
      return;
    }

    let cancelled = false;

    async function loadMotionDefinitions() {
      try {
        const response = await fetch("/motions/manifest.json");
        if (!response.ok) {
          throw new Error(`Motion manifest request failed: HTTP ${response.status}.`);
        }

        const value: unknown = await response.json();
        if (!isMotionManifest(value)) {
          throw new Error("Motion manifest contains invalid or incomplete motion metadata.");
        }

        if (!cancelled) {
          setMotions(value);
          setMotionLoadError("");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("Could not load the pet motion menu:", error);
        setMotionLoadError(message);
      }
    }

    void loadMotionDefinitions();
    return () => {
      cancelled = true;
    };
  }, [toolbarPanel]);

  useEffect(() => {
    if (displayMode !== "3d" || pendingMotionId === null) return;

    const motionId = pendingMotionId;
    const timeout = window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("fufuu:play-motion", { detail: motionId }),
      );
      setPendingMotionId(null);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [displayMode, pendingMotionId]);

  useEffect(() => {
    if (!toolbarOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolbarOpen(false);
        setToolbarPanel(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !toolbarRef.current?.contains(event.target)
      ) {
        setToolbarOpen(false);
        setToolbarPanel(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [toolbarOpen]);

  async function openChat() {
    try {
      await window.sakuraDesktop?.openChat?.();
      setToolbarActionError("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error("[Fufuu] Could not open the chat window:", error);
      setToolbarActionError(`Couldn't open Chat: ${message}`);
      return;
    }
    setToolbarOpen(false);
    setToolbarPanel(null);
  }

  function changeDisplayMode(mode: DisplayMode) {
    setDisplayMode(mode);
    if (!forceThreeDimensional) {
      window.localStorage.setItem("fufuu-display-mode", mode);
      const channel = new BroadcastChannel("fufuu-display-mode");
      channel.postMessage(mode);
      channel.close();
    }
  }

  async function openMemories() {
    if (window.sakuraDesktop?.openMemories) {
      try {
        await window.sakuraDesktop.openMemories();
        setToolbarActionError("");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error("[Fufuu] Could not open the Memories panel:", error);
        setToolbarActionError(`Couldn't open Memories: ${message}`);
        return;
      }
    } else {
      const command = { id: crypto.randomUUID(), action: "memories" as const };
      window.localStorage.setItem(MEMORY_COMMAND_KEY, JSON.stringify(command));
      const channel = new BroadcastChannel(AVATAR_COMMAND_CHANNEL);
      channel.postMessage(command);
      channel.close();
      await openChat();
    }
    setToolbarOpen(false);
    setToolbarPanel(null);
  }

  function chooseMotion(motionId: string) {
    if (displayMode !== "3d") changeDisplayMode("3d");
    setPendingMotionId(motionId);
    setToolbarOpen(false);
    setToolbarPanel(null);
  }

  function toggleRoaming() {
    window.sakuraDesktop?.setRoamingEnabled?.(!roaming.enabled);
    setRoaming((state) => ({ ...state, enabled: !state.enabled }));
  }

  function toggleSpeechBubble() {
    const nextEnabled = !speechBubbleEnabled;
    window.sakuraDesktop?.setSpeechBubbleEnabled?.(nextEnabled);
    setSpeechBubbleEnabled(nextEnabled);
  }

  function toggleDisplayMode() {
    changeDisplayMode(displayMode === "2d" ? "3d" : "2d");
  }

  function showToolbar() {
    setToolbarOpen(true);
    setToolbarPanel(null);
  }

  const interactions = motions.filter(
    (motion) =>
      motion.category === "greeting" || motion.category === "interaction",
  );

  return (
    <main className={`sakura-stage mode-${displayMode}`}>
      {displayMode === "3d" ? (
        <VRMViewer
          roamingEnabled={roaming.enabled}
          onPetClick={showToolbar}
        />
      ) : (
        <Live2DViewer onPetClick={showToolbar} />
      )}

      <div className="fufuu-desktop-controls">
        <button
          className="fufuu-control-button"
          onClick={toggleRoaming}
          type="button"
          aria-label={roaming.enabled ? "Pause roaming" : "Start roaming"}
          title={roaming.enabled ? "Pause roaming" : "Roam around desktop"}
        >
          {roaming.enabled ? "Ⅱ Pause" : "✧ Roam"}
        </button>

        {displayMode === "3d" && (
          <button
            className="fufuu-control-button fufuu-knock-button"
            onClick={() => window.sakuraDesktop?.knock?.()}
            type="button"
            aria-label="Knock on the screen"
            title="Move to a screen edge and knock"
          >
            ♡ Knock
          </button>
        )}
      </div>

      <button
        className="sakura-chat-button"
        onClick={openChat}
        type="button"
      >
        <span className="chat-sparkle">✧</span> Chat with me
      </button>

      {toolbarOpen && (
        <aside
          className="fufuu-pet-toolbar"
          aria-label="Furina's quick actions"
          data-fufuu-toolbar
          ref={toolbarRef}
        >
          <div className="fufuu-pet-toolbar-heading">
            <strong>Furina</strong>
            <button
              type="button"
              aria-label="Close quick actions"
              title="Close"
              onClick={() => {
                setToolbarOpen(false);
                setToolbarPanel(null);
              }}
            >
              ×
            </button>
          </div>
          <nav className="fufuu-pet-toolbar-actions" aria-label="Pet actions">
            <button type="button" onClick={openChat}>Chat</button>
            <button
              type="button"
              aria-expanded={toolbarPanel === "interact"}
              onClick={() =>
                setToolbarPanel((panel) =>
                  panel === "interact" ? null : "interact",
                )
              }
            >
              Interact
            </button>
            <button type="button" onClick={openMemories}>Memories</button>
            <button
              type="button"
              aria-expanded={toolbarPanel === "motions"}
              onClick={() =>
                setToolbarPanel((panel) =>
                  panel === "motions" ? null : "motions",
                )
              }
            >
              Motions
            </button>
            <button
              type="button"
              aria-expanded={toolbarPanel === "settings"}
              onClick={() =>
                setToolbarPanel((panel) =>
                  panel === "settings" ? null : "settings",
                )
              }
            >
              Settings
            </button>
          </nav>
          {toolbarActionError && (
            <p className="fufuu-pet-toolbar-error" role="alert">
              {toolbarActionError}
            </p>
          )}

          {toolbarPanel === "interact" && (
            <section className="fufuu-pet-toolbar-panel" aria-label="Interactions">
              <strong>Choose an interaction</strong>
              {motionLoadError && <p role="alert">{motionLoadError}</p>}
              {interactions.length === 0 && !motionLoadError && (
                <p>Loading supported interactions…</p>
              )}
              {interactions.map((motion) => (
                <button
                  key={motion.id}
                  type="button"
                  onClick={() => chooseMotion(motion.id)}
                >
                  {motion.label}
                </button>
              ))}
            </section>
          )}

          {toolbarPanel === "motions" && (
            <section className="fufuu-pet-toolbar-panel" aria-label="Available motions">
              <strong>{displayMode === "3d" ? "Play a motion" : "3D motions"}</strong>
              {displayMode !== "3d" && (
                <p>Choosing a motion switches Furina to 3D.</p>
              )}
              {pendingMotionId && <p role="status">Preparing motion…</p>}
              {motionLoadError && <p role="alert">{motionLoadError}</p>}
              {motions.map((motion) => (
                <button
                  key={motion.id}
                  type="button"
                  onClick={() => chooseMotion(motion.id)}
                >
                  {motion.label}
                </button>
              ))}
            </section>
          )}

          {toolbarPanel === "settings" && (
            <section className="fufuu-pet-toolbar-panel" aria-label="Quick settings">
              <strong>Quick settings</strong>
              <button type="button" onClick={toggleDisplayMode}>
                Switch to {displayMode === "2d" ? "3D" : "2D"} avatar
              </button>
              <button type="button" onClick={toggleRoaming}>
                {roaming.enabled ? "Pause roaming" : "Resume roaming"}
              </button>
              <button
                type="button"
                aria-pressed={speechBubbleEnabled}
                onClick={toggleSpeechBubble}
              >
                Speech bubble: {speechBubbleEnabled ? "On" : "Off"}
              </button>
            </section>
          )}
        </aside>
      )}
    </main>
  );
}
