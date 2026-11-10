
import { useEffect, useState } from "react";
import "./SpeechBubble.css";

type BubbleBridge = {
  hideSpeechBubble?: () => void;
  getSpeechBubbleState?: () => Promise<{ enabled: boolean; text: string }>;
  onSpeechBubbleUpdate?: (callback: (text: string) => void) => () => void;
};

function getBridge() {
  return (window as unknown as { sakuraDesktop?: BubbleBridge }).sakuraDesktop;
}

export default function SpeechBubble() {
  const [text, setText] = useState("Oh? You're here. What is it?");

  useEffect(() => {
    const bridge = getBridge();
    const unsubscribe = bridge?.onSpeechBubbleUpdate?.(setText);

    void bridge?.getSpeechBubbleState?.()
      .then((state) => {
        if (state?.text) setText(state.text);
      })
      .catch((error) => {
        console.warn("[Lumi] Couldn't load speech-bubble state:", error);
      });

    return () => unsubscribe?.();
  }, []);

  return (
    <main className="speech-bubble-window">
      <section className="speech-bubble-card">
        <header className="speech-bubble-header">
          <span className="speech-bubble-flower" aria-hidden="true">ðŸŒ¸</span>
          <span className="speech-bubble-name">Lumi</span>
          <span className="speech-bubble-drag-hint">âœ¦</span>
          <button
            type="button"
            className="speech-bubble-hide"
            onClick={() => getBridge()?.hideSpeechBubble?.()}
            aria-label="Hide speech bubble"
            title="Hide speech bubble"
          >
            Ã—
          </button>
        </header>

        <div className="speech-bubble-content" aria-live="polite">
          {text || "â€¦"}
        </div>

        <span className="speech-bubble-tail" aria-hidden="true" />
      </section>
    </main>
  );
}

