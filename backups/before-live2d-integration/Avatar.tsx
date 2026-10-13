import { useEffect, useState } from "react";
import "./Avatar.css";
import VRMViewer from "./VRMViewer";

type DisplayMode = "2d" | "3d";

export default function Avatar() {
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() =>
    window.localStorage.getItem("fufuu-display-mode") === "3d"
      ? "3d"
      : "2d"
  );

  useEffect(() => {
    document.body.classList.add("avatar-mode");

    const syncMode = (mode: DisplayMode) => {
      setDisplayMode(mode);
      window.localStorage.setItem("fufuu-display-mode", mode);
    };

    const unsubscribe = window.sakuraDesktop?.onDisplayMode(syncMode);

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "fufuu-display-mode") return;

      if (event.newValue === "2d" || event.newValue === "3d") {
        syncMode(event.newValue);
      }
    };

    const channel = new BroadcastChannel("fufuu-display-mode");

    const handleBroadcast = (event: MessageEvent) => {
      if (event.data === "2d" || event.data === "3d") {
        setDisplayMode(event.data);
      }
    };

    channel.addEventListener("message", handleBroadcast);
    window.addEventListener("storage", handleStorage);

    return () => {
      document.body.classList.remove("avatar-mode");
      window.removeEventListener("storage", handleStorage);
      channel.removeEventListener("message", handleBroadcast);
      channel.close();
      unsubscribe?.();
    };
  }, []);

  function openChat() {
    window.sakuraDesktop?.openChat();
  }

  return (
    <main className={`sakura-stage mode-${displayMode}`}>
      {displayMode === "3d" ? (
        // Only the VRM viewer exists in 3D mode.
        <VRMViewer />
      ) : (
        // The 2D blob exists only in 2D mode.
        <div className="fufuu-avatar-2d">
          <div className="sakura-orb" title="Fufuu is here">
            <div className="sakura-flower">
              <span>✿</span>
            </div>

            <div className="sakura-face">
              <div className="sakura-eyes">
                <span />
                <span />
              </div>

              <div className="sakura-blush left" />
              <div className="sakura-blush right" />
              <div className="sakura-mouth" />
            </div>

            <div className="sakura-shine" />
          </div>

          <div className="sakura-name">Fufuu 🌸</div>
        </div>
      )}

      <button
        className="sakura-chat-button"
        onClick={openChat}
        type="button"
      >
        <span>✧</span> Chat with me
      </button>
    </main>
  );
}