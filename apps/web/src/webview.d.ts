export {};

declare global {
  interface Window {
    sakuraDesktop?: {
      onOpenMemories?: (callback: () => void) => (() => void) | void;
      onOpenPreferences?: (callback: () => void) => (() => void) | void;
      setDisplayMode?: (mode: "2d" | "sprite") => void;
      onDisplayMode?: (callback: (mode: "2d" | "sprite") => void) => (() => void) | void;
      speakText?: (
        text: string,
        options?: { language?: string; rate?: number }
      ) => Promise<{ ok?: boolean; error?: string }>;
      stopSpeech: () => void;
      completeKnock?: () => void;
      onKnock?: (callback: () => void) => (() => void) | void;
      [key: string]: unknown;
    };
  }
}