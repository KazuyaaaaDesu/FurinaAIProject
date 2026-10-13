export {};

type FufuuDisplayMode = "2d" | "3d";

declare global {
  interface Window {
    sakuraDesktop?: {
      openChat: () => void;
      setDisplayMode: (mode: FufuuDisplayMode) => void;
      onDisplayMode: (callback: (mode: FufuuDisplayMode) => void) => () => void;
    };
  }
}
