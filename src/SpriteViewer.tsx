
import { useEffect, useRef, useState } from "react";
import type { CharacterScreenGeometry } from "./desktopStage";

type SpriteViewerProps = {
  characterScale?: number;
  onPetClick?: (geometry: CharacterScreenGeometry) => void;
  onPointerInteractive?: (interactive: boolean) => void;
  onCharacterGeometryChange?: (
    geometry: CharacterScreenGeometry | null,
  ) => void;
};

const SPRITE_URL = "/sprites/Lumi_Standing.png";
const IDLE_FOLDER = "/sprites/Lumi/idle";
const FRAME_DIGITS = 4;
const MAX_FRAMES = 300;
const DEFAULT_FPS = 24;

function getFrameUrl(index: number): string {
  const filename = String(index).padStart(FRAME_DIGITS, "0");
  return `${IDLE_FOLDER}/${filename}.png`;
}

export default function SpriteViewer({
  characterScale = 1,
  onPetClick,
  onPointerInteractive,
  onCharacterGeometryChange,
}: SpriteViewerProps) {
  const [frames, setFrames] = useState<string[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [status, setStatus] = useState("Loading Lumi's idle animation...");

  const imageRef = useRef<HTMLImageElement>(null);
  const frameCountRef = useRef(0);

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

  // Discover consecutive PNG frames: 0001.png, 0002.png, ...
  useEffect(() => {
    let cancelled = false;
    let nextFrame = 1;
    const discoveredFrames: string[] = [];

    setFrames([]);
    setFrameIndex(0);
    frameCountRef.current = 0;
    setStatus("Loading Lumi's idle animation...");

    const loadNextFrame = () => {
      if (cancelled) return;

      if (nextFrame > MAX_FRAMES) {
        finishDiscovery();
        return;
      }

      const url = getFrameUrl(nextFrame);
      const image = new Image();

      image.onload = () => {
        if (cancelled) return;

        discoveredFrames.push(url);
        frameCountRef.current = discoveredFrames.length;
        setFrames([...discoveredFrames]);

        if (discoveredFrames.length === 1) {
          setStatus("");
          console.info("[Lumi PNG] Idle animation started.", url);
        }

        nextFrame += 1;
        loadNextFrame();
      };

      image.onerror = () => {
        if (cancelled) return;

        finishDiscovery();
      };

      image.src = url;
    };

    const finishDiscovery = () => {
      if (cancelled) return;

      if (discoveredFrames.length === 0) {
        setStatus(
          "Idle frames not found. Using Lumi_Standing.png instead.",
        );
        console.warn(
          `[Lumi PNG] No idle frames found at ${IDLE_FOLDER}/0001.png. Using the fallback sprite.`,
        );
      } else {
        setStatus("");
        console.info(
          `[Lumi PNG] Found ${discoveredFrames.length} idle frames.`,
        );
      }
    };

    loadNextFrame();

    return () => {
      cancelled = true;
    };
  }, []);

  // Advance through the discovered frames at the configured FPS.
  useEffect(() => {
    if (frames.length <= 1) {
      setFrameIndex(0);
      return;
    }

    const interval = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 1000 / DEFAULT_FPS);

    return () => window.clearInterval(interval);
  }, [frames.length]);

  const currentSprite =
    frames.length > 0
      ? frames[frameIndex % frames.length]
      : SPRITE_URL;

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
        ref={imageRef}
        src={currentSprite}
        alt="Lumi desktop companion"
        draggable={false}
        onLoad={(event) => {
          reportGeometry(event.currentTarget);
        }}
        onError={() => {
          if (currentSprite === SPRITE_URL) {
            setStatus("Missing fallback sprite: public/sprites/Lumi_Standing.png");
            console.error(
              `[Lumi PNG] Could not load fallback sprite: ${SPRITE_URL}`,
            );
          }
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
