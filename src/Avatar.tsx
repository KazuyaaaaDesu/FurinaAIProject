import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  isMotionManifest,
  type MotionDefinition,
} from "./petBehavior";
import {
  DEFAULT_DESKTOP_STAGE_SETTINGS,
  validateDesktopStageSettings,
  type DesktopStageSettings,
  type DesktopStageState,
} from "./desktopStage";
import "./Avatar.css";
import Live2DViewer from "./Live2DViewer";
import VRMViewer from "./VRMViewer";

type DisplayMode = "2d" | "3d";
type ToolbarPanel = "interact" | "memories" | "motions" | "settings";

type RoamingState = {
  enabled: boolean;
  moving: boolean;
};

const INITIAL_ROAMING_STATE: RoamingState = {
  enabled: false,
  moving: false,
};

const MEMORY_COMMAND_KEY = "fufuu-avatar-command";
const AVATAR_COMMAND_CHANNEL = "fufuu-avatar-command";
const isElectronAvatar = window.sakuraDesktop !== undefined;
const forceThreeDimensional =
  new URLSearchParams(window.location.search).get("debugMotions") === "1";

export default function Avatar() {
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() =>
    forceThreeDimensional ||
    window.localStorage.getItem("fufuu-display-mode") === "3d"
      ? "3d"
      : "2d",
  );
  const [roaming, setRoaming] = useState<RoamingState>(INITIAL_ROAMING_STATE);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [toolbarPanel, setToolbarPanel] = useState<ToolbarPanel | null>(null);
  const [motions, setMotions] = useState<MotionDefinition[]>([]);
  const [motionLoadError, setMotionLoadError] = useState("");
  const [pendingMotionId, setPendingMotionId] = useState<string | null>(null);
  const [speechBubbleEnabled, setSpeechBubbleEnabled] = useState(false);
  const [toolbarActionError, setToolbarActionError] = useState("");
  const [stageState, setStageState] = useState<DesktopStageState>(() => {
    const settings = window.localStorage.getItem("fufuu-desktop-stage-settings");
    if (!settings) {
      return {
        settings: DEFAULT_DESKTOP_STAGE_SETTINGS,
        displays: [],
        allBounds: { x: 0, y: 0, width: 0, height: 0 },
      };
    }
    try {
      const value: unknown = JSON.parse(settings);
      if (validateDesktopStageSettings(value)) {
        return {
          settings: value,
          displays: [],
          allBounds: { x: 0, y: 0, width: 0, height: 0 },
        };
      }
    } catch (error) {
      console.warn("Could not load saved desktop stage preferences:", error);
    }
    return {
      settings: DEFAULT_DESKTOP_STAGE_SETTINGS,
      displays: [],
      allBounds: { x: 0, y: 0, width: 0, height: 0 },
    };
  });
  const toolbarRef = useRef<HTMLElement>(null);
  const toolbarOpenRef = useRef(toolbarOpen);
  toolbarOpenRef.current = toolbarOpen;
  const pointerExitTimerRef = useRef<number | null>(null);
  const stageDragPointerRef = useRef<number | null>(null);
  const resizePointerRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    initialWidth: number;
    initialHeight: number;
    width: number;
    height: number;
  } | null>(null);
  const lastPointerInteractiveRef = useRef<boolean | null>(null);

  useEffect(() => {
    document.body.classList.add("avatar-mode");

    const syncMode = (mode: DisplayMode) => {
      const nextMode = forceThreeDimensional ? "3d" : mode;
      setDisplayMode(nextMode);

      if (!forceThreeDimensional) {
        window.localStorage.setItem("fufuu-display-mode", nextMode);
      }
    };

    const unsubscribeMode = window.sakuraDesktop?.onDisplayMode?.(syncMode);
    const unsubscribeRoaming =
      window.sakuraDesktop?.onRoamingState?.(setRoaming);

    const roamingStateRequest =
      window.sakuraDesktop?.getRoamingState?.();
    if (roamingStateRequest) {
      void roamingStateRequest
        .then(setRoaming)
        .catch((error: unknown) => {
          console.warn("Could not read desktop roaming state:", error);
        });
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "fufuu-display-mode") return;

      if (event.newValue === "2d" || event.newValue === "3d") {
        syncMode(event.newValue);
      }
    };

    const channel = new BroadcastChannel("fufuu-display-mode");
    const handleBroadcast = (event: MessageEvent) => {
      if (event.data === "2d" || event.data === "3d") {
        syncMode(event.data);
      }
    };

    const unsubscribeBubble =
      window.sakuraDesktop?.onSpeechBubbleEnabled?.(setSpeechBubbleEnabled);
    const speechBubbleStateRequest =
      window.sakuraDesktop?.getSpeechBubbleState?.();
    if (speechBubbleStateRequest) {
      void speechBubbleStateRequest
        .then((state) => setSpeechBubbleEnabled(state.enabled))
        .catch((error: unknown) => {
          console.warn("Could not read speech-bubble state:", error);
        });
    }

    channel.addEventListener("message", handleBroadcast);
    window.addEventListener("storage", handleStorage);

    return () => {
      document.body.classList.remove("avatar-mode");
      if (pointerExitTimerRef.current !== null) {
        window.clearTimeout(pointerExitTimerRef.current);
        pointerExitTimerRef.current = null;
      }
      window.removeEventListener("storage", handleStorage);
      channel.removeEventListener("message", handleBroadcast);
      channel.close();
      unsubscribeMode?.();
      unsubscribeRoaming?.();
      unsubscribeBubble?.();
    };
  }, []);

  useEffect(() => {
    const bridge = window.sakuraDesktop;
    if (!bridge) return;

    let disposed = false;
    const acceptStageState = (state: DesktopStageState) => {
      if (disposed) return;
      setStageState(state);
      setRoaming((current) => ({
        enabled: state.settings.roamingEnabled,
        moving: current.moving,
      }));
    };
    const unsubscribe = bridge.onDesktopStageState(acceptStageState);
    void bridge
      .getDesktopStageState()
      .then(acceptStageState)
      .catch((error: unknown) => {
        console.error("Could not retrieve Electron desktop stage settings:", error);
        setToolbarActionError(
          `Couldn't load desktop settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isElectronAvatar) return;

    const handlePointerMove = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("canvas")) return;

      const interactive =
        target.closest(
          "[data-fufuu-interactive], button, input, select, textarea, a",
        ) !== null;
      reportPointerInteractivity(interactive);
    };

    document.addEventListener("mousemove", handlePointerMove, true);
    return () => {
      document.removeEventListener("mousemove", handlePointerMove, true);
    };
  }, []);

  useEffect(() => {
    window.sakuraDesktop?.setDisplayMode?.(displayMode);
  }, [displayMode]);

  useEffect(() => {
    if (
      toolbarPanel !== "motions" &&
      toolbarPanel !== "interact"
    ) {
      return;
    }

    let cancelled = false;

    async function loadMotionDefinitions() {
      try {
        const response = await fetch("/motions/manifest.json");
        if (!response.ok) {
          throw new Error(`Motion manifest request failed: HTTP ${response.status}.`);
        }

        const value: unknown = await response.json();
        if (!isMotionManifest(value)) {
          throw new Error("Motion manifest contains invalid or incomplete motion metadata.");
        }

        if (!cancelled) {
          setMotions(value);
          setMotionLoadError("");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("Could not load the pet motion menu:", error);
        setMotionLoadError(message);
      }
    }

    void loadMotionDefinitions();
    return () => {
      cancelled = true;
    };
  }, [toolbarPanel]);

  useEffect(() => {
    if (displayMode !== "3d" || pendingMotionId === null) return;

    const motionId = pendingMotionId;
    const timeout = window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("fufuu:play-motion", { detail: motionId }),
      );
      setPendingMotionId(null);
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [displayMode, pendingMotionId]);

  useEffect(() => {
    if (!toolbarOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolbarOpen(false);
        setToolbarPanel(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !toolbarRef.current?.contains(event.target)
      ) {
        setToolbarOpen(false);
        setToolbarPanel(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [toolbarOpen]);

  async function openChat() {
    try {
      await window.sakuraDesktop?.openChat?.();
      setToolbarActionError("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error("[Fufuu] Could not open the chat window:", error);
      setToolbarActionError(`Couldn't open Chat: ${message}`);
      return;
    }
  }

  function reportPointerInteractivity(interactive: boolean) {
    if (pointerExitTimerRef.current !== null) {
      window.clearTimeout(pointerExitTimerRef.current);
      pointerExitTimerRef.current = null;
    }
    if (toolbarOpenRef.current && !interactive) {
      pointerExitTimerRef.current = window.setTimeout(() => {
        pointerExitTimerRef.current = null;
        if (toolbarOpenRef.current) {
          setToolbarOpen(false);
          setToolbarPanel(null);
        }
      }, 350);
    }

    if (
      !isElectronAvatar ||
      lastPointerInteractiveRef.current === interactive
    ) {
      return;
    }
    lastPointerInteractiveRef.current = interactive;
    window.sakuraDesktop?.setPointerInteractive(interactive);
  }

  async function updateStageSettings(
    update: Partial<DesktopStageSettings>,
  ) {
    const bridge = window.sakuraDesktop;
    if (bridge) {
      try {
        const next = await bridge.updateDesktopStageSettings(update);
        setStageState(next);
        setRoaming((current) => ({
          enabled: next.settings.roamingEnabled,
          moving: current.moving,
        }));
        setToolbarActionError("");
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error("[Fufuu] Could not apply desktop stage settings:", error);
        setToolbarActionError(`Couldn't apply setting: ${message}`);
        return;
      }
    }

    const settings = { ...stageState.settings, ...update };
    if (!validateDesktopStageSettings(settings)) {
      setToolbarActionError("This setting value is invalid.");
      return;
    }
    setStageState((current) => ({ ...current, settings }));
    window.localStorage.setItem(
      "fufuu-desktop-stage-settings",
      JSON.stringify(settings),
    );
    if (update.roamingEnabled !== undefined) {
      setRoaming((current) => ({ ...current, enabled: settings.roamingEnabled }));
    }
  }

  async function resetStageSettings() {
    const bridge = window.sakuraDesktop;
    if (bridge) {
      try {
        const next = await bridge.resetDesktopStageSettings();
        setStageState(next);
        setRoaming((current) => ({
          enabled: next.settings.roamingEnabled,
          moving: current.moving,
        }));
        setToolbarActionError("");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error("[Fufuu] Could not restore default stage placement:", error);
        setToolbarActionError(`Couldn't restore placement: ${message}`);
      }
      return;
    }

    await updateStageSettings({
      coverage: "display",
      displayId: null,
      width: DEFAULT_DESKTOP_STAGE_SETTINGS.width,
      height: DEFAULT_DESKTOP_STAGE_SETTINGS.height,
      characterScale: DEFAULT_DESKTOP_STAGE_SETTINGS.characterScale,
      characterX: DEFAULT_DESKTOP_STAGE_SETTINGS.characterX,
      characterY: DEFAULT_DESKTOP_STAGE_SETTINGS.characterY,
      facingDegrees: DEFAULT_DESKTOP_STAGE_SETTINGS.facingDegrees,
      walkingSpeed: DEFAULT_DESKTOP_STAGE_SETTINGS.walkingSpeed,
    });
  }

  function startStageDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (
      event.button !== 0 ||
      stageState.settings.coverage !== "display" ||
      !window.sakuraDesktop
    ) {
      return;
    }

    event.preventDefault();
    stageDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    reportPointerInteractivity(true);
    window.sakuraDesktop.beginDesktopStageDrag(event.screenX, event.screenY);
  }

  function finishStageDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (stageDragPointerRef.current !== event.pointerId) return;

    stageDragPointerRef.current = null;
    window.sakuraDesktop?.endDesktopStageDrag();
    reportPointerInteractivity(false);
  }

  function startStageResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (
      stageState.settings.coverage !== "display" ||
      !window.sakuraDesktop
    ) {
      return;
    }
    event.preventDefault();
    reportPointerInteractivity(true);
    resizePointerRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      initialWidth: stageState.settings.width,
      initialHeight: stageState.settings.height,
      width: stageState.settings.width,
      height: stageState.settings.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveStageResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = resizePointerRef.current;
    if (!start || start.pointerId !== event.pointerId) return;

    const display =
      stageState.displays.find(
        (candidate) => candidate.id === stageState.settings.displayId,
      ) ?? stageState.displays.find((candidate) => candidate.isPrimary);
    const maxWidth = display?.workArea.width ?? start.width + 1000;
    const maxHeight = display?.workArea.height ?? start.height + 1000;
    const width = Math.round(
      Math.max(
        240,
        Math.min(start.initialWidth + event.clientX - start.x, maxWidth),
      ),
    );
    const height = Math.round(
      Math.max(
        320,
        Math.min(start.initialHeight + event.clientY - start.y, maxHeight),
      ),
    );
    start.width = width;
    start.height = height;
    setStageState((current) => ({
      ...current,
      settings: { ...current.settings, width, height },
    }));
    void window.sakuraDesktop
      ?.setDesktopStageSize(width, height)
      .then(setStageState)
      .catch((error: unknown) => {
        console.error("[Fufuu] Could not resize the Electron stage:", error);
      });
  }

  function finishStageResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (resizePointerRef.current?.pointerId !== event.pointerId) return;
    const finalSize = resizePointerRef.current;
    resizePointerRef.current = null;
    void updateStageSettings({
      width: finalSize.width,
      height: finalSize.height,
    });
  }

  function changeDisplayMode(mode: DisplayMode) {
    setDisplayMode(mode);
    if (!forceThreeDimensional) {
      window.localStorage.setItem("fufuu-display-mode", mode);
      const channel = new BroadcastChannel("fufuu-display-mode");
      channel.postMessage(mode);
      channel.close();
    }
  }

  async function openMemories() {
    if (window.sakuraDesktop?.openMemories) {
      try {
        await window.sakuraDesktop.openMemories();
        setToolbarActionError("");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error("[Fufuu] Could not open the Memories panel:", error);
        setToolbarActionError(`Couldn't open Memories: ${message}`);
        return;
      }
    } else {
      const command = { id: crypto.randomUUID(), action: "memories" as const };
      window.localStorage.setItem(MEMORY_COMMAND_KEY, JSON.stringify(command));
      const channel = new BroadcastChannel(AVATAR_COMMAND_CHANNEL);
      channel.postMessage(command);
      channel.close();
      await openChat();
    }
    setToolbarOpen(false);
    setToolbarPanel(null);
  }

  function chooseMotion(motionId: string) {
    if (displayMode !== "3d") changeDisplayMode("3d");
    setPendingMotionId(motionId);
    setToolbarOpen(false);
    setToolbarPanel(null);
  }

  function toggleRoaming() {
    void updateStageSettings({ roamingEnabled: !roaming.enabled });
  }

  function toggleSpeechBubble() {
    const nextEnabled = !speechBubbleEnabled;
    window.sakuraDesktop?.setSpeechBubbleEnabled?.(nextEnabled);
    setSpeechBubbleEnabled(nextEnabled);
  }

  function toggleDisplayMode() {
    changeDisplayMode(displayMode === "2d" ? "3d" : "2d");
  }

  function showToolbar() {
    setToolbarOpen(true);
    setToolbarPanel(null);
  }

  const interactions = motions.filter(
    (motion) =>
      motion.category === "greeting" || motion.category === "interaction",
  );

  return (
    <main className={`sakura-stage mode-${displayMode}`}>
      {isElectronAvatar && stageState.settings.coverage === "display" && (
        <button
          className="fufuu-stage-drag-handle"
          type="button"
          title="Drag to move the stage"
          aria-label="Drag to move the stage"
          data-fufuu-interactive
          onPointerDown={startStageDrag}
          onPointerUp={finishStageDrag}
          onPointerCancel={finishStageDrag}
          onLostPointerCapture={finishStageDrag}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      )}

      {displayMode === "3d" ? (
        <VRMViewer
          roamingEnabled={roaming.enabled}
          onPetClick={showToolbar}
          onPointerInteractive={reportPointerInteractivity}
          characterSettings={stageState.settings}
        />
      ) : (
        <Live2DViewer
          onPetClick={showToolbar}
          onPointerInteractive={reportPointerInteractivity}
        />
      )}

      {isElectronAvatar &&
        stageState.settings.coverage === "display" && (
          <button
            className="fufuu-stage-resize-handle"
            type="button"
            title="Drag to resize the stage"
            aria-label="Drag to resize the stage"
            data-fufuu-interactive
            onPointerDown={startStageResize}
            onPointerMove={moveStageResize}
            onPointerUp={finishStageResize}
            onPointerCancel={finishStageResize}
          >
            <span aria-hidden="true">◢</span>
          </button>
        )}

      {!isElectronAvatar && (
        <div className="fufuu-desktop-controls">
          <button
            className="fufuu-control-button"
            onClick={toggleRoaming}
            type="button"
            aria-label={roaming.enabled ? "Pause roaming" : "Start roaming"}
            title={roaming.enabled ? "Pause roaming" : "Roam around desktop"}
          >
            {roaming.enabled ? "Ⅱ Pause" : "✧ Roam"}
          </button>
          {displayMode === "3d" && (
            <button
              className="fufuu-control-button fufuu-knock-button"
              onClick={() => window.sakuraDesktop?.knock?.()}
              type="button"
              aria-label="Knock on the screen"
              title="Move to a screen edge and knock"
            >
              ♡ Knock
            </button>
          )}
        </div>
      )}

      {!isElectronAvatar && (
        <button
          className="sakura-chat-button"
          onClick={openChat}
          type="button"
        >
          <span className="chat-sparkle">✧</span> Chat with me
        </button>
      )}

      {toolbarOpen && (
        <aside
          className="fufuu-pet-toolbar"
          aria-label="Furina's quick actions"
          data-fufuu-toolbar
          data-fufuu-interactive
          ref={toolbarRef}
        >
          <div className="fufuu-pet-toolbar-heading">
            <strong>Furina</strong>
            <button
              type="button"
              aria-label="Close quick actions"
              title="Close"
              onClick={() => {
                setToolbarOpen(false);
                setToolbarPanel(null);
              }}
            >
              ×
            </button>
          </div>
          <nav className="fufuu-pet-toolbar-actions" aria-label="Pet actions">
            <button type="button" onClick={openChat}>Chat</button>
            <button
              type="button"
              aria-expanded={toolbarPanel === "interact"}
              onClick={() =>
                setToolbarPanel((panel) =>
                  panel === "interact" ? null : "interact",
                )
              }
            >
              Interact
            </button>
            <button type="button" onClick={openMemories}>Memories</button>
            <button
              type="button"
              aria-expanded={toolbarPanel === "motions"}
              onClick={() =>
                setToolbarPanel((panel) =>
                  panel === "motions" ? null : "motions",
                )
              }
            >
              Motions
            </button>
            <button
              type="button"
              aria-expanded={toolbarPanel === "settings"}
              onClick={() =>
                setToolbarPanel((panel) =>
                  panel === "settings" ? null : "settings",
                )
              }
            >
              Settings
            </button>
          </nav>
          {toolbarActionError && (
            <p className="fufuu-pet-toolbar-error" role="alert">
              {toolbarActionError}
            </p>
          )}

          {toolbarPanel === "interact" && (
            <section className="fufuu-pet-toolbar-panel" aria-label="Interactions">
              <strong>Choose an interaction</strong>
              {motionLoadError && <p role="alert">{motionLoadError}</p>}
              {interactions.length === 0 && !motionLoadError && (
                <p>Loading supported interactions…</p>
              )}
              {interactions.map((motion) => (
                <button
                  key={motion.id}
                  type="button"
                  onClick={() => chooseMotion(motion.id)}
                >
                  {motion.label}
                </button>
              ))}
            </section>
          )}

          {toolbarPanel === "motions" && (
            <section className="fufuu-pet-toolbar-panel" aria-label="Available motions">
              <strong>{displayMode === "3d" ? "Play a motion" : "3D motions"}</strong>
              {displayMode !== "3d" && (
                <p>Choosing a motion switches Furina to 3D.</p>
              )}
              {pendingMotionId && <p role="status">Preparing motion…</p>}
              {motionLoadError && <p role="alert">{motionLoadError}</p>}
              {motions.map((motion) => (
                <button
                  key={motion.id}
                  type="button"
                  onClick={() => chooseMotion(motion.id)}
                >
                  {motion.label}
                </button>
              ))}
            </section>
          )}

          {toolbarPanel === "settings" && (
            <section className="fufuu-pet-toolbar-panel fufuu-settings-panel" aria-label="Settings">
              <strong>Stage and character</strong>
              <button type="button" onClick={toggleDisplayMode}>
                Switch to {displayMode === "2d" ? "3D" : "2D"} avatar
              </button>
              <label className="fufuu-stage-setting fufuu-setting-toggle">
                <input
                  type="checkbox"
                  checked={
                    roaming.enabled &&
                    !(displayMode === "2d" &&
                      stageState.settings.coverage === "all")
                  }
                  disabled={
                    displayMode === "2d" &&
                    stageState.settings.coverage === "all"
                  }
                  onChange={toggleRoaming}
                />
                <span>Enable roaming</span>
              </label>
              {displayMode === "2d" &&
                stageState.settings.coverage === "all" && (
                  <p>
                    2D window roaming is paused while one window spans all
                    displays. Switch to a selected display to use it.
                  </p>
                )}
              <label className="fufuu-stage-setting fufuu-setting-toggle">
                <input
                  type="checkbox"
                  checked={speechBubbleEnabled}
                  onChange={toggleSpeechBubble}
                />
                <span>Speech bubble</span>
              </label>
              {isElectronAvatar ? (
                <>
                  <label className="fufuu-stage-setting">
                    <span>Desktop coverage</span>
                    <select
                      value={stageState.settings.coverage}
                      onChange={(event) =>
                        void updateStageSettings({
                          coverage:
                            event.currentTarget.value === "all" ? "all" : "display",
                        })
                      }
                    >
                      <option value="display">Selected display</option>
                      <option value="all">Entire desktop setup</option>
                    </select>
                  </label>
                  {stageState.settings.coverage === "display" && (
                    <>
                      <label className="fufuu-stage-setting">
                        <span>Display</span>
                        <select
                          value={stageState.settings.displayId ?? ""}
                          onChange={(event) =>
                            void updateStageSettings({
                              displayId: Number(event.currentTarget.value),
                            })
                          }
                        >
                          {stageState.displays.map((display) => (
                            <option key={display.id} value={display.id}>
                              {display.label}
                              {display.isPrimary ? " (Primary)" : ""} ·{" "}
                              {display.workArea.width}×{display.workArea.height}
                            </option>
                          ))}
                        </select>
                      </label>
                      {(["width", "height"] as const).map((dimension) => {
                        const selectedDisplay = stageState.displays.find(
                          (display) =>
                            display.id === stageState.settings.displayId,
                        );
                        const maximum =
                          dimension === "width"
                            ? selectedDisplay?.workArea.width ?? 2000
                            : selectedDisplay?.workArea.height ?? 1200;
                        return (
                          <label
                            className="fufuu-stage-setting"
                            key={dimension}
                          >
                            <span>
                              Stage {dimension}: {stageState.settings[dimension]} px
                            </span>
                            <input
                              type="range"
                              min={Math.min(
                                dimension === "width" ? 240 : 320,
                                maximum,
                              )}
                              max={maximum}
                              step="20"
                              value={Math.min(
                                stageState.settings[dimension],
                                maximum,
                              )}
                              onChange={(event) =>
                                void updateStageSettings({
                                  [dimension]: Number(event.currentTarget.value),
                                })
                              }
                            />
                          </label>
                        );
                      })}
                    </>
                  )}
                  {stageState.settings.coverage === "all" && (
                    <p>
                      One transparent stage spans the displays' combined
                      rectangle; gaps remain click-through. Very large
                      display unions may require selecting one display.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  Monitor coverage and stage sizing are available in the
                  Electron desktop app.
                </p>
              )}

              {(
                [
                  ["characterScale", "Character scale", 0.5, 2, 0.05],
                  ["characterX", "Horizontal position", -1, 1, 0.05],
                  ["characterY", "Vertical position", -1, 1, 0.05],
                  ["facingDegrees", "Facing angle", -180, 180, 5],
                  ["walkingSpeed", "Walking speed", 0.05, 0.5, 0.01],
                ] as const
              ).map(([key, label, minimum, maximum, step]) => (
                <label className="fufuu-stage-setting" key={key}>
                  <span>
                    {label}:{" "}
                    {key === "characterScale"
                      ? stageState.settings[key].toFixed(2)
                      : key === "walkingSpeed"
                        ? stageState.settings[key].toFixed(2)
                        : stageState.settings[key]}
                    {key === "facingDegrees" ? "°" : ""}
                  </span>
                  <input
                    type="range"
                    min={minimum}
                    max={maximum}
                    step={step}
                    value={stageState.settings[key]}
                    onChange={(event) =>
                      void updateStageSettings({
                        [key]: Number(event.currentTarget.value),
                      })
                    }
                  />
                </label>
              ))}

              <button type="button" onClick={resetStageSettings}>
                Restore default placement
              </button>
            </section>
          )}
        </aside>
      )}
    </main>
  );
}
