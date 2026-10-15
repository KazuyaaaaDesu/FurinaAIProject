
import { useEffect, useState } from "react";
import "./Avatar.css";
import Live2DViewer from "./Live2DViewer";
import VRMViewer from "./VRMViewer";

type DisplayMode = "2d" | "3d";

type RoamingState = {
  enabled: boolean;
  moving: boolean;
};

const INITIAL_ROAMING_STATE: RoamingState = {
  enabled: false,
  moving: false,
};

const forceThreeDimensional =
  new URLSearchParams(window.location.search).get("debugMotions") === "1";

export default function Avatar() {
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() =>
    forceThreeDimensional ||
    window.localStorage.getItem("fufuu-display-mode") === "3d"
      ? "3d"
      : "2d"
  );
  const [roaming, setRoaming] = useState<RoamingState>(INITIAL_ROAMING_STATE);

  useEffect(() => {
    document.body.classList.add("avatar-mode");

    const syncMode = (mode: DisplayMode) => {
      const nextMode = forceThreeDimensional ? "3d" : mode;
      setDisplayMode(nextMode);

      if (!forceThreeDimensional) {
        window.localStorage.setItem("fufuu-display-mode", nextMode);
      }
    };

    const unsubscribeMode = window.sakuraDesktop?.onDisplayMode(syncMode);

    const unsubscribeRoaming = window.sakuraDesktop?.onRoamingState(
      setRoaming
    );

    void window.sakuraDesktop?.getRoamingState()
      .then(setRoaming)
      .catch(() => undefined);

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

    channel.addEventListener("message", handleBroadcast);
    window.addEventListener("storage", handleStorage);

    return () => {
      document.body.classList.remove("avatar-mode");
      window.removeEventListener("storage", handleStorage);
      channel.removeEventListener("message", handleBroadcast);
      channel.close();
      unsubscribeMode?.();
      unsubscribeRoaming?.();
    };
  }, []);

  useEffect(() => {
    window.sakuraDesktop?.setDisplayMode(displayMode);
  }, [displayMode]);

  function openChat() {
    window.sakuraDesktop?.openChat();
  }

  function toggleRoaming() {
    window.sakuraDesktop?.setRoamingEnabled(!roaming.enabled);
  }

  function knock() {
    window.sakuraDesktop?.knock();
  }

  return (
    <main className={`sakura-stage mode-${displayMode}`}>
      {displayMode === "3d" ? (
        <VRMViewer roamingEnabled={roaming.enabled} />
      ) : (
        <Live2DViewer />
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
            onClick={knock}
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
    </main>
  );
}
