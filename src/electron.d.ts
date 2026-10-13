
export {};

declare global {
  interface Window {
    sakuraDesktop?: {
      openChat: () => void;
    };
  }
}
