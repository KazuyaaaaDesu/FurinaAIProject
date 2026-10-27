import { useState } from "react";
import type { CharacterScreenGeometry } from "./desktopStage";

type SpriteViewerProps = {
  characterScale?: number;
  onPetClick?: (geometry: CharacterScreenGeometry) => void;
  onPointerInteractive?: (interactive: boolean) => void;
  onCharacterGeometryChange?: (geometry: CharacterScreenGeometry | null) => void;
};

const SPRITE_URL = "/sprites/Lumi_Standing.png";

export default function SpriteViewer({
  characterScale = 1,
  onPetClick,
  onPointerInteractive,
  onCharacterGeometryChange,
}: SpriteViewerProps) {
  const [status, setStatus] = useState("Loading Lumi's PNG sprite...");

  const reportGeometry = (image: HTMLImageElement) => {
    const rect = image.getBoundingClientRect();
    const geometry: CharacterScreenGeometry = {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      anchorX: rect.left + rect.width / 2,
      anchorY: rect.top + rect.height / 2,
    };
    onCharacterGeometryChange?.(geometry);
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: "transparent",
        pointerEvents: "none",
      }}
    >
      <img
        src={SPRITE_URL}
        alt="Lumi desktop companion"
        draggable={false}
        onLoad={(event) => {
          setStatus("");
          reportGeometry(event.currentTarget);
          console.info("[Lumi PNG] Standing sprite loaded.", SPRITE_URL);
        }}
        onError={() => {
          setStatus("Missing Assets/Pet/Lumi/Lumi_Standing.png");
          console.error(
            `[Lumi PNG] Could not load ${SPRITE_URL}. Add the image at public/sprites/Lumi_Standing.png.`,
          );
        }}
        onClick={(event) => {
          reportGeometry(event.currentTarget);
          const rect = event.currentTarget.getBoundingClientRect();
          onPetClick?.({
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            anchorX: rect.left + rect.width / 2,
            anchorY: rect.top + rect.height / 2,
          });
        }}
        onPointerEnter={() => onPointerInteractive?.(true)}
        onPointerLeave={() => onPointerInteractive?.(false)}
        style={{
          display: "block",
          maxWidth: "88%",
          maxHeight: "88%",
          width: "auto",
          height: "auto",
          objectFit: "contain",
          transform: `scale(${characterScale})`,
          transformOrigin: "center center",
          userSelect: "none",
          pointerEvents: "auto",
        }}
      />
      {status && (
        <div
          role="status"
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: 12,
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(20, 24, 38, 0.78)",
            color: "#fff",
            font: "12px/1.4 Segoe UI, sans-serif",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
