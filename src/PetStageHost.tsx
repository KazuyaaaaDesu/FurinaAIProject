import { useEffect, useState } from "react";
import Live2DViewer from "./Live2DViewer";
import VRMViewer from "./VRMViewer";
import type { CharacterScreenGeometry } from "./desktopStage";
import type { PersonalityMode } from "./fufuuPersonality";
import "./PetStageHost.css";

type StageSettings = { displayMode: "2d" | "3d"; characterScale: number; characterX: number; characterY: number; facingDegrees: number; walkingSpeed: number; roamingEnabled: boolean };
const defaults: StageSettings = { displayMode: "2d", characterScale: 1, characterX: 0, characterY: 0, facingDegrees: 0, walkingSpeed: 0.16, roamingEnabled: false };

function post(type: string, extra: Record<string, unknown> = {}) {
  window.chrome?.webview?.postMessage(JSON.stringify({ type, ...extra }));
}

declare global {
  interface Window { chrome?: { webview?: { postMessage: (message: string) => void; addEventListener: (name: string, cb: (event: MessageEvent) => void) => void; removeEventListener: (name: string,cb: (event: MessageEvent) => void) => void } } }
}

export default function PetStageHost() {
  const [settings, setSettings] = useState<StageSettings>(defaults);
  const [status, setStatus] = useState("Loading Fufuu…");

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      let message: any = event.data;
      if (typeof message === "string") { try { message = JSON.parse(message); } catch { return; } }
      if (!message || typeof message !== "object") return;
      if (message.type === "settings" && message.settings) {
        const next = { ...defaults, ...message.settings } as StageSettings;
        setSettings(next);
      }
      if (message.type === "behavior") setStatus(`Fufuu · ${String(message.behavior)}`);
      if (message.type === "play-motion" && typeof message.motionId === "string") {
        window.dispatchEvent(new CustomEvent("fufuu:play-motion", { detail: message.motionId }));
      }
    };
    window.chrome?.webview?.addEventListener("message", receive);
    post("ready");
    return () => window.chrome?.webview?.removeEventListener("message", receive);
  }, []);

  const geometryChanged = (_geometry: CharacterScreenGeometry | null) => { /* Window placement is controlled by WPF. */ };
  const clicked = (_geometry: CharacterScreenGeometry) => post("pet-click");
  const pointerInteractive = (_interactive: boolean) => { /* WPF window remains interactive. */ };
  const characterSettings = {
    characterScale: settings.characterScale,
    characterX: settings.characterX,
    characterY: settings.characterY,
    facingDegrees: settings.facingDegrees,
    walkingSpeed: settings.walkingSpeed,
  };

  return <main className="pet-stage" aria-label="Fufuu desktop pet" onPointerDown={(event) => { if (event.target === event.currentTarget && event.button === 0) post("drag-start"); }}>
    <div className="pet-stage__status">{status}</div>
    
    {/* Control Bar inside React so clicks register perfectly */}
    <div style={{ position: "absolute", top: 8, right: 8, zIndex: 100, display: "flex", gap: "3px", background: "rgba(23, 18, 32, 0.9)", borderRadius: "10px", padding: "5px", backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,0.1)" }}>
      <button onClick={() => post("set-mode", { mode: "2d" })} style={{ padding: "4px 9px", background: settings.displayMode === "2d" ? "#5e2a52" : "transparent", color: "#f4e8fa", border: "none", borderRadius: "6px", cursor: "pointer", font: "11px Segoe UI, sans-serif" }} title="Use Live2D">2D</button>
      <button onClick={() => post("set-mode", { mode: "3d" })} style={{ padding: "4px 9px", background: settings.displayMode === "3d" ? "#5e2a52" : "transparent", color: "#f4e8fa", border: "none", borderRadius: "6px", cursor: "pointer", font: "11px Segoe UI, sans-serif" }} title="Use VRM">3D</button>
      <button onClick={() => post("toggle-roam")} style={{ padding: "4px 9px", background: settings.roamingEnabled ? "#5e2a52" : "transparent", color: "#f4e8fa", border: "none", borderRadius: "6px", cursor: "pointer", font: "11px Segoe UI, sans-serif" }} title="Toggle roaming">⇄</button>
      <button onClick={() => post("close")} style={{ padding: "4px 9px", background: "transparent", color: "#ff6b6b", border: "none", borderRadius: "6px", cursor: "pointer", font: "11px Segoe UI, sans-serif" }} title="Close desktop pet (Esc)">✕</button>
    </div>

    {settings.displayMode === "3d" ?
      <VRMViewer roamingEnabled={false} autonomousBehaviorEnabled={false} personalityMode={"balanced" as PersonalityMode}
        onPetClick={clicked} onPointerInteractive={pointerInteractive} onCharacterGeometryChange={geometryChanged} characterSettings={characterSettings} /> :
      <Live2DViewer onPetClick={clicked} onPointerInteractive={pointerInteractive} onCharacterGeometryChange={geometryChanged} />}
  </main>;
}