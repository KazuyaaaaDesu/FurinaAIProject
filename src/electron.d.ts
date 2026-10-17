
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

type FufuuStageSettings = {
  coverage: "display" | "all";
  displayId: number | null;
  width: number;
  height: number;
  characterScale: number;
  characterX: number;
  characterY: number;
  facingDegrees: number;
  walkingSpeed: number;
  roamingEnabled: boolean;
};

type FufuuStageDisplay = {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
};

type FufuuStageState = {
  settings: FufuuStageSettings;
  displays: FufuuStageDisplay[];
  allBounds: { x: number; y: number; width: number; height: number };
};

type FufuuCharacterScreenGeometry = {
  viewportWidth: number;
  viewportHeight: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  anchorX: number;
  anchorY: number;
};

declare global {
  interface Window {
    sakuraDesktop?: {
      openChat: () => Promise<boolean>;
      openMemories: () => Promise<boolean>;
      onOpenMemories: (callback: () => void) => () => void;

      setPointerInteractive: (interactive: boolean) => void;
      openPetToolbar: (
        geometry: FufuuCharacterScreenGeometry | null,
      ) => Promise<boolean>;
      closePetToolbar: () => Promise<boolean>;
      getPetToolbarState: () => Promise<boolean>;
      reportCharacterGeometry: (
        geometry: FufuuCharacterScreenGeometry,
      ) => void;
      onPetToolbarVisibility: (callback: (visible: boolean) => void) => () => void;
      playPetMotion: (motionId: string) => Promise<boolean>;
      onPetMotion: (callback: (motionId: string) => void) => () => void;
      beginDesktopStageDrag: (screenX: number, screenY: number) => void;
      endDesktopStageDrag: () => void;
      getDesktopStageState: () => Promise<FufuuStageState>;
      updateDesktopStageSettings: (
        settings: Partial<FufuuStageSettings>,
      ) => Promise<FufuuStageState>;
      setDesktopStageSize: (
        width: number,
        height: number,
      ) => Promise<FufuuStageState>;
      resetDesktopStageSettings: () => Promise<FufuuStageState>;
      onDesktopStageState: (
        callback: (state: FufuuStageState) => void,
      ) => () => void;

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

      speakText: (text: string, options?: { language?: "auto" | "ja" | "en" | "zh"; rate?: number }) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
      stopSpeech: () => Promise<{ ok: boolean }>;
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
