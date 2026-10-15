
export {};

type FufuuDisplayMode = "2d" | "3d";

type FufuuRoamingState = {
  enabled: boolean;
  moving: boolean;
};

type FufuuSpeechBubbleState = {
  enabled: boolean;
  text: string;
};

declare global {
  interface Window {
    sakuraDesktop?: {
      openChat: () => Promise<boolean>;
      openMemories: () => Promise<boolean>;
      onOpenMemories: (callback: () => void) => () => void;

      setDisplayMode: (mode: FufuuDisplayMode) => void;
      onDisplayMode: (
        callback: (mode: FufuuDisplayMode) => void
      ) => () => void;

      setRoamingEnabled: (enabled: boolean) => void;
      getRoamingState: () => Promise<FufuuRoamingState>;
      onRoamingState: (
        callback: (state: FufuuRoamingState) => void
      ) => () => void;

      knock: () => void;
      completeKnock: () => void;
      onKnock: (callback: () => void) => () => void;

      setSpeechBubbleEnabled: (enabled: boolean) => void;
      updateSpeechBubble: (text: string) => void;
      hideSpeechBubble: () => void;
      getSpeechBubbleState: () => Promise<FufuuSpeechBubbleState>;

      onSpeechBubbleEnabled: (
        callback: (enabled: boolean) => void
      ) => () => void;
      onSpeechBubbleUpdate: (
        callback: (text: string) => void
      ) => () => void;
    };
  }
}
