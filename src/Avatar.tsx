import { useEffect } from "react";
import "./Avatar.css";

export default function Avatar() {
  useEffect(() => {
    document.body.classList.add("avatar-mode");

    return () => {
      document.body.classList.remove("avatar-mode");
    };
  }, []);

  function openChat() {
    window.sakuraDesktop?.openChat();
  }

  return (
    <main className="sakura-stage">
      <div className="sakura-orb" title="Sakura is here">
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

      <div className="sakura-name">Sakura 🌸</div>

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
