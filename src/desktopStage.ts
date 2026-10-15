export type DesktopCoverage = "display" | "all";

export type DesktopDisplay = {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
};

export type DesktopStageSettings = {
  coverage: DesktopCoverage;
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

export type DesktopStageState = {
  settings: DesktopStageSettings;
  displays: DesktopDisplay[];
  allBounds: { x: number; y: number; width: number; height: number };
};

export const DEFAULT_DESKTOP_STAGE_SETTINGS: DesktopStageSettings = {
  coverage: "display",
  displayId: null,
  width: 360,
  height: 520,
  characterScale: 1,
  characterX: 0,
  characterY: 0,
  facingDegrees: 0,
  walkingSpeed: 0.16,
  roamingEnabled: false,
};

export function validateDesktopStageSettings(
  value: unknown,
): value is DesktopStageSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const settings = value as Record<string, unknown>;
  return (
    (settings.coverage === "display" || settings.coverage === "all") &&
    (settings.displayId === null ||
      (typeof settings.displayId === "number" &&
        Number.isInteger(settings.displayId))) &&
    typeof settings.width === "number" &&
    Number.isFinite(settings.width) &&
    settings.width >= 240 &&
    settings.width <= 10000 &&
    typeof settings.height === "number" &&
    Number.isFinite(settings.height) &&
    settings.height >= 320 &&
    settings.height <= 10000 &&
    typeof settings.characterScale === "number" &&
    Number.isFinite(settings.characterScale) &&
    settings.characterScale >= 0.5 &&
    settings.characterScale <= 2 &&
    typeof settings.characterX === "number" &&
    Number.isFinite(settings.characterX) &&
    settings.characterX >= -1 &&
    settings.characterX <= 1 &&
    typeof settings.characterY === "number" &&
    Number.isFinite(settings.characterY) &&
    settings.characterY >= -1 &&
    settings.characterY <= 1 &&
    typeof settings.facingDegrees === "number" &&
    Number.isFinite(settings.facingDegrees) &&
    settings.facingDegrees >= -3600 &&
    settings.facingDegrees <= 3600 &&
    typeof settings.walkingSpeed === "number" &&
    Number.isFinite(settings.walkingSpeed) &&
    settings.walkingSpeed >= 0.05 &&
    settings.walkingSpeed <= 0.5 &&
    typeof settings.roamingEnabled === "boolean"
  );
}
