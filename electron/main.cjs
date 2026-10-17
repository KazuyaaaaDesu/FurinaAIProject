
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const APP_URL = "http://localhost:5173";
const STORAGE_URL = "http://127.0.0.1:4317/api/health";

const SPEECH_BRIDGE_HOST = "127.0.0.1";
const SPEECH_BRIDGE_PORT = 4318;
const STAGE_SETTINGS_FILE = "desktop-stage-settings.json";
const MAX_ALL_DISPLAY_STAGE_DIMENSION = 8192;
const MAX_ALL_DISPLAY_STAGE_PIXELS = 32_000_000;

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

let avatarWindow = null;
let chatWindow = null;
let speechBubbleWindow = null;
let toolbarWindow = null;
let toolbarWindowLoad = null;
let toolbarVisible = false;
let toolbarHideTimer = null;
let lastCharacterGeometry = null;
const loadedChatWebContents = new WeakSet();
let stageSettings = {
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
let stageSettingsSaveTimer = null;
let pointerIgnoreTimer = null;
let pointerProbeInterval = null;
let avatarMouseIgnored = false;
let activeStageDrag = null;
let speechBubbleEnabled = false;
let speechBubbleText = "Oh? You're here. What is it?";

let viteProcess = null;
let storageProcess = null;
let speechBridgeServer = null;
let quitting = false;
let currentDisplayMode = "2d";

let roamingEnabled = false;
let roamingTimer = null;
let movementTimer = null;
let knockInProgress = false;
let knockReturnPosition = null;
let knockReturning = false;
let movementInProgress = false;

const AVATAR_WIDTH = 360;
const AVATAR_HEIGHT = 520;
const TOOLBAR_WIDTH = 320;
const TOOLBAR_HEIGHT = 560;
const ROAM_INTERVAL_MS = 3500;
const ROAM_MARGIN = 12;

async function isAvailable(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForService(url, child, name) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await isAvailable(url)) return;

    if (child && child.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`${name} did not start within 30 seconds.`);
}

async function startVite() {
  if (await isAvailable(APP_URL)) return;

  viteProcess = spawn(
    "npm.cmd",
    ["run", "dev", "--", "--host", "127.0.0.1", "--strictPort"],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: process.env,
    },
  );

  await waitForService(APP_URL, viteProcess, "Vite");
}

async function startStorageServer() {
  if (await isAvailable(STORAGE_URL)) return;

  const serverPath = path.join(ROOT, "server", "server.js");

  if (!fs.existsSync(serverPath)) {
    console.warn("Fufuu storage server file was not found.");
    return;
  }

  storageProcess = spawn("node", [serverPath], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  await waitForService(STORAGE_URL, storageProcess, "Storage server");
}

function broadcastSpeechBubbleEnabled() {
  for (const win of [chatWindow, avatarWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(
        "fufuu:speech-bubble:enabled",
        speechBubbleEnabled,
      );
    }
  }
}

function broadcastRoamingState() {
  const state = {
    enabled: roamingEnabled,
    moving: movementInProgress,
  };

  for (const win of [avatarWindow, chatWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("fufuu:roam:state", state);
    }
  }
}

function getDisplayList() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    label: display.label || `Display ${display.id}`,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    isPrimary: display.id === primaryId,
  }));
}

function getAllDisplayBounds() {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return { x: 0, y: 0, width: AVATAR_WIDTH, height: AVATAR_HEIGHT };
  }

  const left = Math.min(...displays.map(({ bounds }) => bounds.x));
  const top = Math.min(...displays.map(({ bounds }) => bounds.y));
  const right = Math.max(
    ...displays.map(({ bounds }) => bounds.x + bounds.width),
  );
  const bottom = Math.max(
    ...displays.map(({ bounds }) => bounds.y + bounds.height),
  );
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function getStageState() {
  return {
    settings: { ...stageSettings },
    displays: getDisplayList(),
    allBounds: getAllDisplayBounds(),
  };
}

function supportsWholeDesktopStage() {
  const bounds = getAllDisplayBounds();
  return (
    bounds.width <= MAX_ALL_DISPLAY_STAGE_DIMENSION &&
    bounds.height <= MAX_ALL_DISPLAY_STAGE_DIMENSION &&
    bounds.width * bounds.height <= MAX_ALL_DISPLAY_STAGE_PIXELS
  );
}

function broadcastStageState() {
  const state = getStageState();
  for (const win of [avatarWindow, chatWindow, toolbarWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("fufuu:stage:state", state);
    }
  }
}

function isAvatarOrToolbarSender(sender) {
  return (
    sender === avatarWindow?.webContents ||
    sender === toolbarWindow?.webContents
  );
}

function validateCharacterGeometry(value, bounds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = [
    "viewportWidth",
    "viewportHeight",
    "left",
    "top",
    "right",
    "bottom",
    "anchorX",
    "anchorY",
  ];
  if (
    keys.some(
      (key) => typeof value[key] !== "number" || !Number.isFinite(value[key]),
    )
  ) {
    return false;
  }

  return (
    value.viewportWidth > 0 &&
    value.viewportWidth <= 10000 &&
    value.viewportHeight > 0 &&
    value.viewportHeight <= 10000 &&
    value.left >= -64 &&
    value.top >= -64 &&
    value.right <= value.viewportWidth + 64 &&
    value.bottom <= value.viewportHeight + 64 &&
    value.right >= value.left &&
    value.bottom >= value.top &&
    value.anchorX >= 0 &&
    value.anchorX <= value.viewportWidth &&
    value.anchorY >= 0 &&
    value.anchorY <= value.viewportHeight &&
    value.viewportWidth / value.viewportHeight < 20 &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function getCharacterScreenGeometry(geometry = lastCharacterGeometry) {
  if (
    !geometry ||
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    !validateCharacterGeometry(geometry, avatarWindow.getBounds())
  ) {
    return null;
  }

  const bounds = avatarWindow.getBounds();
  const scaleX = bounds.width / geometry.viewportWidth;
  const scaleY = bounds.height / geometry.viewportHeight;
  return {
    left: bounds.x + geometry.left * scaleX,
    top: bounds.y + geometry.top * scaleY,
    right: bounds.x + geometry.right * scaleX,
    bottom: bounds.y + geometry.bottom * scaleY,
    anchorX: bounds.x + geometry.anchorX * scaleX,
    anchorY: bounds.y + geometry.anchorY * scaleY,
  };
}

function positionToolbarWindow() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;

  const character = getCharacterScreenGeometry();
  const anchor = character
    ? { x: character.anchorX, y: character.anchorY }
    : (() => {
        if (!avatarWindow || avatarWindow.isDestroyed()) {
          return screen.getPrimaryDisplay().workArea;
        }
        const bounds = avatarWindow.getBounds();
        return {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        };
      })();
  const display = screen.getDisplayNearestPoint(anchor);
  const area = display.workArea;
  const width = Math.min(TOOLBAR_WIDTH, area.width);
  const height = Math.min(TOOLBAR_HEIGHT, area.height);
  const gap = 14;
  let x = anchor.x + gap;
  if (x + width > area.x + area.width) x = anchor.x - width - gap;
  let y = anchor.y - Math.round(height * 0.58);
  x = Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width)));
  y = Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height)));

  toolbarWindow.setBounds({ x, y, width, height }, false);
}

function broadcastToolbarVisibility() {
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send(
      "fufuu:toolbar:visibility",
      toolbarVisible,
    );
  }
}

function createToolbarWindow() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) return toolbarWindow;
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    throw new Error("The character stage must be available before the toolbar.");
  }

  toolbarWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: TOOLBAR_WIDTH,
    height: TOOLBAR_HEIGHT,
    minWidth: TOOLBAR_WIDTH,
    minHeight: 360,
    maxWidth: TOOLBAR_WIDTH,
    useContentSize: true,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  toolbarWindow.setAlwaysOnTop(true, "screen-saver");
  toolbarWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  toolbarWindow.webContents.on("before-input-event", dismissToolbarOnEscape);
  toolbarWindowLoad = app.isPackaged
    ? toolbarWindow.loadFile(path.join(ROOT, "dist", "index.html"), {
        query: { avatar: "1", toolbar: "1" },
      })
    : toolbarWindow.loadURL(`${APP_URL}/?avatar=1&toolbar=1`);
  toolbarWindowLoad.catch((error) => {
    console.error("[Fufuu] Contextual toolbar failed to load:", error);
  });

  toolbarWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hideToolbarWindow();
  });
  toolbarWindow.on("closed", () => {
    toolbarWindow = null;
    toolbarWindowLoad = null;
    toolbarVisible = false;
    broadcastToolbarVisibility();
  });

  return toolbarWindow;
}

function hideToolbarWindow() {
  if (toolbarHideTimer) {
    clearTimeout(toolbarHideTimer);
    toolbarHideTimer = null;
  }
  toolbarVisible = false;
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.hide();
  }
  broadcastToolbarVisibility();
}

function dismissToolbarOnEscape(event, input) {
  if (input.type === "keyDown" && input.key === "Escape" && toolbarVisible) {
    event.preventDefault();
    hideToolbarWindow();
  }
}

async function showToolbarWindow(geometry) {
  const toolbar = createToolbarWindow();
  if (geometry !== null && geometry !== undefined) {
    if (
      !avatarWindow ||
      !validateCharacterGeometry(geometry, avatarWindow.getBounds())
    ) {
      throw new Error("Invalid Furina screen position for the contextual toolbar.");
    }
    lastCharacterGeometry = geometry;
  }

  if (toolbarWindowLoad) await toolbarWindowLoad;
  if (toolbar.isDestroyed()) {
    throw new Error("The contextual toolbar was closed before it finished loading.");
  }
  positionToolbarWindow();
  toolbarVisible = true;
  broadcastToolbarVisibility();
  toolbar.setAlwaysOnTop(true, "screen-saver");
  toolbar.showInactive();
  toolbar.moveTop();
  return true;
}

function updateToolbarPositionForStage() {
  // Intentionally do nothing. The toolbar is an independent window and keeps
  // its current screen position while Fufuu moves or the stage is resized.
  // positionToolbarWindow() is called when the toolbar opens, so reopening it
  // places it beside Fufuu's current position.
}

function updateToolbarDismissal(cursor) {
  if (!toolbarVisible || !avatarWindow || avatarWindow.isDestroyed()) return;

  const toolbarBounds =
    toolbarWindow && !toolbarWindow.isDestroyed()
      ? toolbarWindow.getBounds()
      : null;
  const character = getCharacterScreenGeometry();
  const margin = 28;
  const insideCharacter =
    character !== null &&
    cursor.x >= character.left - margin &&
    cursor.x <= character.right + margin &&
    cursor.y >= character.top - margin &&
    cursor.y <= character.bottom + margin;
  const insideToolbar =
    toolbarBounds !== null &&
    cursor.x >= toolbarBounds.x &&
    cursor.x < toolbarBounds.x + toolbarBounds.width &&
    cursor.y >= toolbarBounds.y &&
    cursor.y < toolbarBounds.y + toolbarBounds.height;

  if (insideCharacter || insideToolbar) {
    if (toolbarHideTimer) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
    return;
  }

  if (toolbarHideTimer) return;
  toolbarHideTimer = setTimeout(() => {
    toolbarHideTimer = null;
    if (!toolbarVisible) return;
    const currentCursor = screen.getCursorScreenPoint();
    const currentToolbarBounds =
      toolbarWindow && !toolbarWindow.isDestroyed()
        ? toolbarWindow.getBounds()
        : null;
    const currentCharacter = getCharacterScreenGeometry();
    const stillInsideCharacter =
      currentCharacter !== null &&
      currentCursor.x >= currentCharacter.left - margin &&
      currentCursor.x <= currentCharacter.right + margin &&
      currentCursor.y >= currentCharacter.top - margin &&
      currentCursor.y <= currentCharacter.bottom + margin;
    const stillInsideToolbar =
      currentToolbarBounds !== null &&
      currentCursor.x >= currentToolbarBounds.x &&
      currentCursor.x < currentToolbarBounds.x + currentToolbarBounds.width &&
      currentCursor.y >= currentToolbarBounds.y &&
      currentCursor.y < currentToolbarBounds.y + currentToolbarBounds.height;
    if (!stillInsideCharacter && !stillInsideToolbar) hideToolbarWindow();
  }, 450);
}

function selectedStageDisplay(settings = stageSettings) {
  const displays = screen.getAllDisplays();
  return (
    displays.find((display) => display.id === settings.displayId) ??
    screen.getPrimaryDisplay()
  );
}

function clampStageSettings(input, base = stageSettings) {
  const displays = screen.getAllDisplays();
  const validDisplay = displays.find(
    (display) => display.id === input.displayId,
  );
  const display = validDisplay ?? screen.getPrimaryDisplay();
  const coverage = input.coverage === "all" ? "all" : "display";
  const maxWidth =
    coverage === "all"
      ? Math.min(getAllDisplayBounds().width, 10000)
      : Math.max(1, Math.min(display.workArea.width, 10000));
  const maxHeight =
    coverage === "all"
      ? Math.min(getAllDisplayBounds().height, 10000)
      : Math.max(1, Math.min(display.workArea.height, 10000));
  const minWidth = Math.min(240, maxWidth);
  const minHeight = Math.min(320, maxHeight);

  return {
    coverage,
    displayId: display.id,
    width: Math.round(
      Math.max(minWidth, Math.min(Number(input.width) || base.width, maxWidth)),
    ),
    height: Math.round(
      Math.max(
        minHeight,
        Math.min(Number(input.height) || base.height, maxHeight),
      ),
    ),
    characterScale: Math.max(
      0.5,
      Math.min(Number(input.characterScale) || 1, 1.35),
    ),
    characterX: Math.max(-1, Math.min(Number(input.characterX) || 0, 1)),
    characterY: Math.max(-1, Math.min(Number(input.characterY) || 0, 1)),
    facingDegrees:
      ((Math.round(Number(input.facingDegrees) || 0) % 360) + 360) % 360,
    walkingSpeed: Math.max(
      0.05,
      Math.min(Number(input.walkingSpeed) || 0.16, 0.5),
    ),
    roamingEnabled: Boolean(input.roamingEnabled),
  };
}

function persistStageSettingsSoon() {
  if (stageSettingsSaveTimer) clearTimeout(stageSettingsSaveTimer);
  stageSettingsSaveTimer = setTimeout(() => {
    stageSettingsSaveTimer = null;
    try {
      const filePath = path.join(app.getPath("userData"), STAGE_SETTINGS_FILE);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(stageSettings, null, 2));
    } catch (error) {
      console.error("[Fufuu] Could not persist desktop stage settings:", error);
    }
  }, 250);
}

function getStageWindowBounds(settings = stageSettings) {
  if (settings.coverage === "all") return getAllDisplayBounds();

  const area = selectedStageDisplay(settings).workArea;
  const width = Math.min(settings.width, area.width);
  const height = Math.min(settings.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function applyStageWindowBounds({ preservePosition = false } = {}) {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  const bounds = getStageWindowBounds();
  if (preservePosition && stageSettings.coverage === "display") {
    const area = selectedStageDisplay().workArea;
    const current = avatarWindow.getBounds();
    bounds.x = Math.round(
      Math.max(
        area.x,
        Math.min(current.x, area.x + area.width - bounds.width),
      ),
    );
    bounds.y = Math.round(
      Math.max(
        area.y,
        Math.min(current.y, area.y + area.height - bounds.height),
      ),
    );
  }
  avatarWindow.setMinimumSize(
    Math.min(240, bounds.width),
    Math.min(320, bounds.height),
  );
  avatarWindow.setMaximumSize(bounds.width, bounds.height);
  avatarWindow.setBounds(bounds);
  updateToolbarPositionForStage();
}

function loadStageSettings() {
  const filePath = path.join(app.getPath("userData"), STAGE_SETTINGS_FILE);
  let stored = {};
  try {
    if (fs.existsSync(filePath)) {
      stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
        throw new Error("Saved desktop stage settings are not an object.");
      }
    }
  } catch (error) {
    console.error("[Fufuu] Could not load desktop stage settings:", error);
  }

  stageSettings = clampStageSettings(
    { ...stageSettings, ...stored },
    stageSettings,
  );
  if (stageSettings.coverage === "all" && !supportsWholeDesktopStage()) {
    console.warn(
      "[Fufuu] Saved whole-desktop coverage exceeds the safe single-window limit; using the primary display.",
    );
    stageSettings = {
      ...stageSettings,
      coverage: "display",
      displayId: screen.getPrimaryDisplay().id,
    };
  }
  roamingEnabled = stageSettings.roamingEnabled;
}

function updatePointerInteractivity(event, interactive) {
  if (
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    event.sender !== avatarWindow.webContents ||
    typeof interactive !== "boolean"
  ) {
    return;
  }

  if (activeStageDrag && !interactive) return;

  setAvatarPointerInteractivity(interactive);
}

function setAvatarPointerInteractivity(interactive) {
  if (pointerIgnoreTimer) {
    clearTimeout(pointerIgnoreTimer);
    pointerIgnoreTimer = null;
  }

  if (interactive) {
    if (avatarMouseIgnored) {
      avatarWindow.setIgnoreMouseEvents(false);
      avatarMouseIgnored = false;
    }
    return;
  }

  pointerIgnoreTimer = setTimeout(() => {
    pointerIgnoreTimer = null;
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    avatarWindow.setIgnoreMouseEvents(true, { forward: true });
    avatarMouseIgnored = true;
  }, 50);
}

function isCursorInsideStageInteractiveRegion(cursor, bounds) {
  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  if (
    stageSettings.coverage === "display" &&
    localX >= 8 &&
    localX <= 46 &&
    localY >= 8 &&
    localY <= 46
  ) {
    return true;
  }

  const character = getCharacterScreenGeometry();
  const margin = 8;
  return (
    character !== null &&
    cursor.x >= character.left - margin &&
    cursor.x <= character.right + margin &&
    cursor.y >= character.top - margin &&
    cursor.y <= character.bottom + margin
  );
}

function startPointerProbe() {
  if (pointerProbeInterval) clearInterval(pointerProbeInterval);
  pointerProbeInterval = setInterval(() => {
    if (
      !avatarWindow ||
      avatarWindow.isDestroyed() ||
      avatarWindow.webContents.isDestroyed()
    ) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    updateToolbarDismissal(cursor);
    if (activeStageDrag) {
      const target = clampAvatarPosition(
        cursor.x - activeStageDrag.offsetX,
        cursor.y - activeStageDrag.offsetY,
        selectedStageDisplay(),
      );
      const bounds = avatarWindow.getBounds();
      if (target.x !== bounds.x || target.y !== bounds.y) {
        avatarWindow.setPosition(target.x, target.y);
        updateToolbarPositionForStage();
      }
      return;
    }

    const bounds = avatarWindow.getBounds();
    if (isCursorInsideStageInteractiveRegion(cursor, bounds)) {
      setAvatarPointerInteractivity(true);
    } else if (!avatarMouseIgnored && !pointerIgnoreTimer) {
      setAvatarPointerInteractivity(false);
    }

    if (!avatarMouseIgnored) return;

    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;

    avatarWindow.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(x),
      y: Math.round(y),
    });
  }, 16);
}

function clearRoamingTimer() {
  if (roamingTimer) {
    clearTimeout(roamingTimer);
    roamingTimer = null;
  }
}

function stopWindowMovement() {
  if (movementTimer) {
    clearInterval(movementTimer);
    movementTimer = null;
  }
  movementInProgress = false;
}

function stopRoamingTimer() {
  clearRoamingTimer();
  stopWindowMovement();
}

function getAvatarDisplay() {
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    return screen.getPrimaryDisplay();
  }

  const bounds = avatarWindow.getBounds();
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  return screen.getDisplayNearestPoint({ x: centerX, y: centerY });
}

function clampAvatarPosition(x, y, display = getAvatarDisplay()) {
  const area = display.workArea;
  const width = Math.min(avatarWindow.getBounds().width, area.width);
  const height = Math.min(avatarWindow.getBounds().height, area.height);

  return {
    x: Math.round(
      Math.max(area.x, Math.min(x, area.x + area.width - width)),
    ),
    y: Math.round(
      Math.max(area.y, Math.min(y, area.y + area.height - height)),
    ),
  };
}

function scheduleNextRoam(delay = ROAM_INTERVAL_MS) {
  if (
    !roamingEnabled ||
    currentDisplayMode !== "2d" ||
    stageSettings.coverage === "all" ||
    knockInProgress ||
    knockReturning ||
    quitting
  ) {
    return;
  }

  if (roamingTimer) clearTimeout(roamingTimer);

  roamingTimer = setTimeout(() => {
    roamingTimer = null;
    roamToNewPosition();
  }, delay);
}

function roamToNewPosition() {
  if (
    !roamingEnabled ||
    knockInProgress ||
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    movementInProgress
  ) {
    return;
  }

  if (stageSettings.coverage === "all") return;

  if (currentDisplayMode === "3d") {
    scheduleNextRoam(ROAM_INTERVAL_MS + Math.random() * 2500);
    return;
  }

  const display = getAvatarDisplay();
  const area = display.workArea;
  const bounds = avatarWindow.getBounds();

  const maxX = Math.max(area.x, area.x + area.width - bounds.width);
  const maxY = Math.max(area.y, area.y + area.height - bounds.height);

  const candidates = [
    { x: area.x + ROAM_MARGIN, y: area.y + ROAM_MARGIN },
    { x: maxX - ROAM_MARGIN, y: area.y + ROAM_MARGIN },
    { x: area.x + ROAM_MARGIN, y: maxY - ROAM_MARGIN },
    { x: maxX - ROAM_MARGIN, y: maxY - ROAM_MARGIN },
    { x: area.x + Math.max(0, (area.width - bounds.width) / 2), y: area.y + ROAM_MARGIN },
    { x: maxX, y: area.y + Math.max(0, (area.height - bounds.height) / 2) },
    { x: area.x + Math.max(0, (area.width - bounds.width) / 2), y: maxY },
    { x: area.x + ROAM_MARGIN, y: area.y + Math.max(0, (area.height - bounds.height) / 2) },
  ].map((point) => clampAvatarPosition(point.x, point.y, display));

  const current = { x: bounds.x, y: bounds.y };
  const farCandidates = candidates.filter(
    (point) =>
      Math.abs(point.x - current.x) + Math.abs(point.y - current.y) > 160,
  );

  const pool = farCandidates.length ? farCandidates : candidates;
  const target = pool[Math.floor(Math.random() * pool.length)];

  movementInProgress = true;
  broadcastRoamingState();

  animateAvatarWindowTo(target, () => {
    if (!quitting) scheduleNextRoam(ROAM_INTERVAL_MS + Math.random() * 2500);
  });
}

function animateAvatarWindowTo(target, onComplete) {
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    stopWindowMovement();
    return;
  }

  if (movementTimer) clearInterval(movementTimer);

  const start = avatarWindow.getBounds();
  const destination = clampAvatarPosition(target.x, target.y);
  const distance = Math.hypot(destination.x - start.x, destination.y - start.y);
  const duration = Math.max(900, Math.min(4500, (distance / 180) * 1000));
  const startedAt = Date.now();

  movementInProgress = true;
  broadcastRoamingState();

  movementTimer = setInterval(() => {
    if (!avatarWindow || avatarWindow.isDestroyed() || quitting) {
      stopWindowMovement();
      return;
    }

    const progress = Math.min((Date.now() - startedAt) / duration, 1);
    const eased = progress * progress * (3 - 2 * progress);
    const x = Math.round(start.x + (destination.x - start.x) * eased);
    const y = Math.round(start.y + (destination.y - start.y) * eased);

    avatarWindow.setPosition(x, y);
    updateToolbarPositionForStage();

    if (progress < 1) return;

    clearInterval(movementTimer);
    movementTimer = null;
    movementInProgress = false;
    broadcastRoamingState();
    onComplete?.();
  }, 16);
}

function setRoamingEnabled(enabled) {
  roamingEnabled = enabled;
  stageSettings.roamingEnabled = enabled;
  persistStageSettingsSoon();

  if (knockInProgress || knockReturning) {
    clearRoamingTimer();
  } else {
    stopRoamingTimer();
  }
  broadcastRoamingState();

  if (roamingEnabled && !knockInProgress && !knockReturning) {
    scheduleNextRoam(900);
  }
}

function moveAvatarToNearestEdge() {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;

  const display = getAvatarDisplay();
  const area = display.workArea;
  const bounds = avatarWindow.getBounds();

  const currentCenterX = bounds.x + bounds.width / 2;
  const currentCenterY = bounds.y + bounds.height / 2;

  const distances = [
    { edge: "left", distance: currentCenterX - area.x },
    { edge: "right", distance: area.x + area.width - currentCenterX },
    { edge: "top", distance: currentCenterY - area.y },
    { edge: "bottom", distance: area.y + area.height - currentCenterY },
  ].sort((a, b) => a.distance - b.distance);

  const edge = distances[0].edge;
  let x = bounds.x;
  let y = bounds.y;

  if (edge === "left") x = area.x;
  if (edge === "right") x = area.x + area.width - bounds.width;
  if (edge === "top") y = area.y;
  if (edge === "bottom") y = area.y + area.height - bounds.height;

  const target = clampAvatarPosition(x, y, display);

  animateAvatarWindowTo(target, () => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send("fufuu:avatar:knock");
    }
  });
}

function createAvatarWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.show();
    return;
  }

  const initialBounds = getStageWindowBounds();
  avatarWindow = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: 240,
    minHeight: 320,
    useContentSize: true,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  avatarWindow.setAlwaysOnTop(true, "screen-saver");
  avatarWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  avatarWindow.webContents.on("before-input-event", dismissToolbarOnEscape);

  avatarWindow.loadURL(`${APP_URL}/?avatar=1`);

  avatarWindow.once("ready-to-show", () => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    applyStageWindowBounds();
    avatarWindow.show();
    avatarWindow.setIgnoreMouseEvents(true, { forward: true });
    avatarMouseIgnored = true;
    startPointerProbe();
    broadcastRoamingState();
    broadcastStageState();
  });

  avatarWindow.on("close", () => {
    console.info("[Fufuu] Avatar window close requested.");
  });

  avatarWindow.on("closed", () => {
    console.info("[Fufuu] Avatar window closed.");
    if (pointerIgnoreTimer) {
      clearTimeout(pointerIgnoreTimer);
      pointerIgnoreTimer = null;
    }
    if (pointerProbeInterval) {
      clearInterval(pointerProbeInterval);
      pointerProbeInterval = null;
    }
    if (toolbarHideTimer) {
      clearTimeout(toolbarHideTimer);
      toolbarHideTimer = null;
    }
    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
      toolbarWindow.destroy();
    }
    toolbarWindow = null;
    toolbarWindowLoad = null;
    toolbarVisible = false;
    lastCharacterGeometry = null;
    avatarMouseIgnored = false;
    activeStageDrag = null;
    avatarWindow = null;
    knockInProgress = false;
    knockReturnPosition = null;
    knockReturning = false;
    setRoamingEnabled(false);
  });
}

function openChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  const windowRef = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: "#15121d",
    title: "Fufuu",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWindow = windowRef;

  windowRef.webContents.once("did-finish-load", () => {
    loadedChatWebContents.add(windowRef.webContents);
  });

  void windowRef.loadURL(APP_URL).catch((error) => {
    console.error("[Fufuu] Chat window failed to load:", error);
  });

  windowRef.once("ready-to-show", () => {
    if (windowRef.isDestroyed()) return;
    windowRef.show();
    broadcastRoamingState();
  });

  windowRef.on("close", () => {
    console.info("[Fufuu] Chat window close requested.");
  });

  windowRef.on("closed", () => {
    console.info("[Fufuu] Chat window closed.");
    if (chatWindow === windowRef) {
      chatWindow = null;
    }
  });

  windowRef.webContents.on(
    "render-process-gone",
    (_event, details) => {
      console.error("[Fufuu] Chat renderer process exited:", details);
    },
  );

  return windowRef;
}

function waitForWindowLoad(windowRef) {
  const contents = windowRef.webContents;
  if (windowRef.isDestroyed() || loadedChatWebContents.has(contents)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      contents.removeListener("did-finish-load", handleFinished);
      contents.removeListener("did-fail-load", handleFailed);
    };
    const handleFinished = () => {
      cleanup();
      resolve();
    };
    const handleFailed = (
      _event,
      errorCode,
      errorDescription,
      _validatedURL,
      isMainFrame,
    ) => {
      if (!isMainFrame) return;
      cleanup();
      reject(
        new Error(
          `Chat window load failed (${errorCode}): ${errorDescription}`,
        ),
      );
    };

    contents.once("did-finish-load", handleFinished);
    contents.on("did-fail-load", handleFailed);
  });
}

function createSpeechBubbleWindow() {
  if (speechBubbleWindow && !speechBubbleWindow.isDestroyed()) {
    speechBubbleWindow.showInactive();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = 380;
  const height = 170;
  const margin = 24;

  speechBubbleWindow = new BrowserWindow({
    width,
    height,
    x: area.x + area.width - width - margin,
    y: area.y + margin,
    useContentSize: true,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  speechBubbleWindow.setAlwaysOnTop(true, "screen-saver");
  speechBubbleWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });

  speechBubbleWindow.loadURL(`${APP_URL}/?bubble=1`);

  speechBubbleWindow.webContents.once("did-finish-load", () => {
    if (!speechBubbleWindow || speechBubbleWindow.isDestroyed()) return;

    speechBubbleWindow.webContents.send(
      "fufuu:speech-bubble:update",
      speechBubbleText,
    );

    if (speechBubbleEnabled) {
      speechBubbleWindow.showInactive();
    }
  });

  speechBubbleWindow.on("closed", () => {
    speechBubbleWindow = null;
    speechBubbleEnabled = false;
    broadcastSpeechBubbleEnabled();
  });
}

function setSpeechBubbleEnabled(enabled) {
  speechBubbleEnabled = enabled;

  if (enabled) {
    createSpeechBubbleWindow();
  } else if (speechBubbleWindow && !speechBubbleWindow.isDestroyed()) {
    speechBubbleWindow.hide();
  }

  broadcastSpeechBubbleEnabled();
}

function updateSpeechBubbleText(text) {
  speechBubbleText = text.slice(0, 1500);

  if (speechBubbleWindow && !speechBubbleWindow.isDestroyed()) {
    speechBubbleWindow.webContents.send(
      "fufuu:speech-bubble:update",
      speechBubbleText,
    );
  }
}

// -----------------------------------------------------------------------------
// Piper Plus voice output
// Uses sentence-sized chunks and a slower default rate for more natural pacing.
// -----------------------------------------------------------------------------
let speechRequestId = 0;
let activePiperProcess = null;
let activeAudioProcess = null;

function getPiperPlusRoots() {
  // The engine and model assets may live in different roots. In particular,
  // Fufuu's project-local resources copy should be checked even when the
  // external Piper Plus installation also contains the executable.
  return [...new Set([
    process.env.PIPER_PLUS_ROOT,
    path.join(ROOT, "resources", "piper-plus"),
    "D:\\AI\\PiperPlus\\piper-plus",
    "D:\\AI\\PiperPlus",
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function findPiperPlusAsset(envName, relativePath) {
  const override = process.env[envName];
  if (override) return path.resolve(override);

  const candidates = [];
  for (const root of getPiperPlusRoots()) {
    candidates.push(path.join(root, relativePath));
    // Also support layouts where the executable is in piper-plus/bin while
    // models are in the parent install's models directory.
    candidates.push(path.join(path.dirname(root), relativePath));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function getPiperPlusEngine() {
  const roots = getPiperPlusRoots();
  const candidates = roots.map((root) => path.join(root, "bin", "piper-plus.exe"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function stopPiperSpeech() {
  speechRequestId += 1;
  for (const child of [activePiperProcess, activeAudioProcess]) {
    if (child && child.exitCode === null) {
      try { child.kill(); } catch {}
    }
  }
  activePiperProcess = null;
  activeAudioProcess = null;
  return true;
}

function splitSpeechIntoChunks(text, maxChars = 360) {
  const normalized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!normalized) return [];

  // Combine short sentences into a single synthesis job. Starting a new
  // Piper process for every short sentence causes avoidable CPU spikes and
  // long gaps between playback.
  const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]*/gu) || [normalized];
  const chunks = [];
  let pending = "";

  const flush = () => {
    if (pending.trim()) chunks.push(pending.trim());
    pending = "";
  };

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;

    if (sentence.length <= maxChars) {
      const combined = [pending, sentence].filter(Boolean).join(" ");
      if (combined.length <= maxChars) {
        pending = combined;
      } else {
        flush();
        pending = sentence;
      }
      continue;
    }

    flush();
    // Split long sentences at clause boundaries where possible.
    const clauses = sentence.split(/(?<=[,，、;；:：])\s*/u).filter(Boolean);
    for (const rawClause of clauses) {
      const clause = rawClause.trim();
      if (!clause) continue;
      const combined = [pending, clause].filter(Boolean).join(" ");
      if (combined.length <= maxChars) {
        pending = combined;
      } else {
        flush();
        if (clause.length <= maxChars) {
          pending = clause;
        } else {
          for (let i = 0; i < clause.length; i += maxChars) {
            chunks.push(clause.slice(i, i + maxChars));
          }
        }
      }
    }
    flush();
  }
  flush();
  return chunks;
}

function runChild(child, label) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function speakWithPiperPlus(text, options = {}) {
  const cleanText = typeof text === "string" ? text.trim().slice(0, 1200) : "";
  if (!cleanText) return { ok: false, error: "No text to speak." };

  stopPiperSpeech();
  const requestId = speechRequestId;
  const engine = getPiperPlusEngine();
  const model = findPiperPlusAsset(
    "PIPER_PLUS_MODEL",
    path.join("models", "tsukuyomi-chan-6lang-fp16.onnx"),
  );
  const config = findPiperPlusAsset(
    "PIPER_PLUS_CONFIG",
    path.join("models", "config.json"),
  );
  const piperRoot = path.dirname(path.dirname(engine));

  if (!fs.existsSync(engine)) return { ok: false, error: `Piper Plus executable not found: ${engine}` };
  if (!fs.existsSync(model)) return { ok: false, error: `Piper Plus model not found: ${model}` };
  if (!fs.existsSync(config)) return { ok: false, error: `Piper Plus config not found: ${config}` };

  const detectedLanguage = /[\u3040-\u30ff]/u.test(cleanText)
    ? "ja"
    : (/[\u3400-\u9fff]/u.test(cleanText) ? "zh" : "en");
  const requestedLanguage = ["ja", "en", "zh"].includes(options?.language) ? options.language : "auto";
  const language = requestedLanguage === "auto" ? detectedLanguage : requestedLanguage;
  const rate = Number(options?.rate);
  const safeRate = Number.isFinite(rate) && rate >= 0.5 && rate <= 1.3 ? rate : 0.65;
  // Add a deliberately slower baseline even when the UI sends rate=1.0.
  // Piper length_scale is inverse speed: larger values speak more slowly.
  // Keep speech natural without stretching every utterance so much that
  // playback becomes sluggish. Piper length_scale is inverse speed.
  const lengthScale = String(Math.max(0.95, Math.min(1.65, 1.05 / safeRate)));
  const chunks = splitSpeechIntoChunks(cleanText);
  const childEnv = {
    ...process.env,
    OPENJTALK_DICTIONARY_PATH: path.join(ROOT, "resources", "piper-plus", "share", "open_jtalk", "dic"),
    CMUDICT_PATH: path.join(ROOT, "resources", "piper-plus", "share", "piper-plus", "dicts", "cmudict_data.json"),
    PIPER_PLUS_DICTIONARIES_PATH: path.join(ROOT, "resources", "piper-plus", "share", "piper-plus", "dicts"),
  };

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      if (requestId !== speechRequestId || quitting) return { ok: false, cancelled: true };
      const outputFile = path.join(os.tmpdir(), `fufuu-voice-${process.pid}-${requestId}-${index}.wav`);
      try {
        const synth = spawn(engine, [
          "--model", model,
          "--config", config,
          "--language", language,
          "--length_scale", lengthScale,
          "--text", chunks[index],
          "--output_file", outputFile,
        ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: childEnv, cwd: piperRoot });
        activePiperProcess = synth;
        await runChild(synth, "Piper Plus");
        activePiperProcess = null;
        if (requestId !== speechRequestId || quitting) return { ok: false, cancelled: true };
        if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 44) {
          throw new Error("Piper Plus did not create a valid WAV file.");
        }

        // PlaySync keeps each sentence in order. PowerShell receives a base64
        // encoded script to avoid path quoting issues on Windows.
        const psScript = `$player = New-Object System.Media.SoundPlayer('${outputFile.replace(/'/g, "''")}'); $player.Load(); $player.PlaySync(); $player.Dispose();`;
        const encoded = Buffer.from(psScript, "utf16le").toString("base64");
        const player = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
          windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
        });
        activeAudioProcess = player;
        await runChild(player, "Audio playback");
        activeAudioProcess = null;
      } finally {
        try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch {}
      }
      if (index < chunks.length - 1) {
        const chunk = chunks[index];
        const isSentenceEnd = /[。！？.!?]$/u.test(chunk);
        const isClauseEnd = /[,，、;；:：]$/u.test(chunk);
        // Short, natural breathing room between separately synthesized chunks.
        // Keep it brief so pauses feel conversational without making playback drag.
        await delay(isSentenceEnd ? 300 : isClauseEnd ? 155 : 90);
      }
    }
    return { ok: true, language, chunks: chunks.length };
  } catch (error) {
    if (requestId !== speechRequestId) return { ok: false, cancelled: true };
    console.error("[Fufuu] Piper Plus speech failed:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (requestId === speechRequestId) {
      activePiperProcess = null;
      activeAudioProcess = null;
    }
  }
}

function startSpeechBridge() {
  if (speechBridgeServer) return;

  speechBridgeServer = http.createServer((req, res) => {
    const origin = req.headers.origin;

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (req.method === "OPTIONS") {
      if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }

      res.writeHead(204);
      res.end();
      return;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "GET" && req.url === "/state") {
      res.writeHead(200);
      res.end(JSON.stringify({
        enabled: speechBubbleEnabled,
        text: speechBubbleText,
      }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/command") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let body = "";
    let finished = false;

    req.on("data", (chunk) => {
      if (finished) return;

      body += chunk.toString();

      if (Buffer.byteLength(body, "utf8") > 10000) {
        finished = true;
        res.writeHead(413);
        res.end(JSON.stringify({ error: "Request too large" }));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (finished) return;

      try {
        const data = JSON.parse(body || "{}");

        if (data.action === "set-enabled") {
          if (typeof data.enabled !== "boolean") {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "enabled must be boolean" }));
            return;
          }

          setSpeechBubbleEnabled(data.enabled);
        } else if (data.action === "update-text") {
          if (typeof data.text !== "string") {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "text must be a string" }));
            return;
          }

          updateSpeechBubbleText(data.text);
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Unknown action" }));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          enabled: speechBubbleEnabled,
          text: speechBubbleText,
        }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  });

  speechBridgeServer.on("error", (error) => {
    console.error("Fufuu speech bridge error:", error);
  });

  speechBridgeServer.listen(
    SPEECH_BRIDGE_PORT,
    SPEECH_BRIDGE_HOST,
    () => {
      console.log(
        `Fufuu speech bridge listening on ${SPEECH_BRIDGE_HOST}:${SPEECH_BRIDGE_PORT}`,
      );
    },
  );
}

ipcMain.handle("sakura:open-chat", () => {
  const targetWindow = openChatWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("The Fufuu chat window could not be opened.");
  }

  return waitForWindowLoad(targetWindow).then(() => {
    if (targetWindow.isDestroyed()) {
      throw new Error("The Fufuu chat window closed before it finished opening.");
    }
    targetWindow.show();
    targetWindow.focus();
    return true;
  });
});

ipcMain.handle("sakura:open-memories", async () => {
  const targetWindow = openChatWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("The Fufuu chat window could not be opened.");
  }

  await waitForWindowLoad(targetWindow);
  if (targetWindow.isDestroyed()) {
    throw new Error("The Fufuu chat window closed before Memories could open.");
  }

  targetWindow.webContents.send("sakura:open-memories");
  targetWindow.focus();
  return true;
});

ipcMain.handle("fufuu:toolbar:open", async (event, geometry) => {
  if (event.sender !== avatarWindow?.webContents) {
    throw new Error("Only the character stage can open the contextual toolbar.");
  }
  return showToolbarWindow(geometry);
});

ipcMain.handle("fufuu:toolbar:close", (event) => {
  if (!isAvatarOrToolbarSender(event.sender)) {
    throw new Error("Only Fufuu windows can close the contextual toolbar.");
  }
  hideToolbarWindow();
  return true;
});

ipcMain.handle("fufuu:toolbar:get-state", (event) => {
  if (!isAvatarOrToolbarSender(event.sender)) {
    throw new Error("Only Fufuu windows can read the contextual toolbar state.");
  }
  return toolbarVisible;
});

ipcMain.on("fufuu:stage:character-geometry", (event, geometry) => {
  if (
    event.sender !== avatarWindow?.webContents ||
    !avatarWindow ||
    !validateCharacterGeometry(geometry, avatarWindow.getBounds())
  ) {
    return;
  }
  lastCharacterGeometry = geometry;
  updateToolbarPositionForStage();
});

ipcMain.handle("fufuu:toolbar:play-motion", (event, motionId) => {
  if (
    event.sender !== toolbarWindow?.webContents ||
    typeof motionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(motionId)
  ) {
    throw new Error("Invalid motion request from the contextual toolbar.");
  }
  if (!avatarWindow || avatarWindow.isDestroyed()) {
    throw new Error("The character stage is unavailable.");
  }

  currentDisplayMode = "3d";
  avatarWindow.webContents.send("fufuu:display-mode", "3d");
  avatarWindow.webContents.send("fufuu:motion:play", motionId);
  hideToolbarWindow();
  return true;
});

ipcMain.on("fufuu:stage:pointer-interactive", updatePointerInteractivity);

ipcMain.on("fufuu:stage:drag", (event, action, point) => {
  if (
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    event.sender !== avatarWindow.webContents
  ) {
    return;
  }

  if (action === "start") {
    if (
      stageSettings.coverage !== "display" ||
      !point ||
      !Number.isFinite(point.screenX) ||
      !Number.isFinite(point.screenY)
    ) {
      return;
    }

    const bounds = avatarWindow.getBounds();
    activeStageDrag = {
      offsetX: point.screenX - bounds.x,
      offsetY: point.screenY - bounds.y,
    };
    setAvatarPointerInteractivity(true);
    return;
  }

  if (action === "end") {
    if (!activeStageDrag) return;
    activeStageDrag = null;
    setAvatarPointerInteractivity(false);
  }
});

ipcMain.handle("fufuu:stage:get-state", () => getStageState());

ipcMain.handle("fufuu:stage:set-size", (event, size) => {
  if (
    event.sender !== avatarWindow?.webContents ||
    !size ||
    typeof size.width !== "number" ||
    !Number.isFinite(size.width) ||
    typeof size.height !== "number" ||
    !Number.isFinite(size.height) ||
    stageSettings.coverage !== "display"
  ) {
    throw new Error("Invalid stage resize request.");
  }

  stageSettings = clampStageSettings(
    { ...stageSettings, width: size.width, height: size.height },
    stageSettings,
  );
  applyStageWindowBounds({ preservePosition: true });
  persistStageSettingsSoon();
  broadcastStageState();
  return getStageState();
});

ipcMain.handle("fufuu:stage:update-settings", (event, update) => {
  if (
    !isAvatarOrToolbarSender(event.sender) ||
    !update ||
    typeof update !== "object" ||
    Array.isArray(update)
  ) {
    throw new Error("Invalid desktop stage settings update.");
  }

  const allowedKeys = new Set([
    "coverage",
    "displayId",
    "width",
    "height",
    "characterScale",
    "characterX",
    "characterY",
    "facingDegrees",
    "walkingSpeed",
    "roamingEnabled",
  ]);
  if (Object.keys(update).some((key) => !allowedKeys.has(key))) {
    throw new Error("Desktop stage settings contain an unsupported field.");
  }

  const candidate = { ...stageSettings, ...update };
  if (
    (candidate.coverage !== "display" && candidate.coverage !== "all") ||
    (candidate.displayId !== null &&
      (typeof candidate.displayId !== "number" ||
        !Number.isInteger(candidate.displayId))) ||
    !Number.isFinite(candidate.width) ||
    !Number.isFinite(candidate.height) ||
    !Number.isFinite(candidate.characterScale) ||
    !Number.isFinite(candidate.characterX) ||
    !Number.isFinite(candidate.characterY) ||
    !Number.isFinite(candidate.facingDegrees) ||
    !Number.isFinite(candidate.walkingSpeed) ||
    typeof candidate.roamingEnabled !== "boolean"
  ) {
    throw new Error("Desktop stage settings contain invalid values.");
  }

  if (candidate.coverage === "all" && !supportsWholeDesktopStage()) {
    throw new Error(
      "The combined display area exceeds the safe single-window rendering limits. Select one display instead.",
    );
  }

  const preservePosition =
    stageSettings.coverage === "display" &&
    candidate.coverage === "display" &&
    candidate.displayId === stageSettings.displayId;
  const previousCoverage = stageSettings.coverage;
  stageSettings = clampStageSettings(candidate, stageSettings);
  if (update.roamingEnabled !== undefined) {
    setRoamingEnabled(stageSettings.roamingEnabled);
  }
  if (previousCoverage !== stageSettings.coverage && currentDisplayMode === "2d") {
    if (stageSettings.coverage === "all") {
      stopRoamingTimer();
    } else if (roamingEnabled) {
      scheduleNextRoam(900);
    }
  }
  if (
    previousCoverage !== stageSettings.coverage ||
    update.displayId !== undefined ||
    update.width !== undefined ||
    update.height !== undefined
  ) {
    applyStageWindowBounds({ preservePosition });
  }
  persistStageSettingsSoon();
  broadcastStageState();
  return getStageState();
});

ipcMain.handle("fufuu:stage:reset", (event) => {
  if (!isAvatarOrToolbarSender(event.sender)) {
    throw new Error("Only Fufuu windows can reset desktop stage settings.");
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  stageSettings = clampStageSettings(
    {
      ...stageSettings,
      coverage: "display",
      displayId: primaryDisplay.id,
      width: AVATAR_WIDTH,
      height: AVATAR_HEIGHT,
      characterScale: 1,
      characterX: 0,
      characterY: 0,
      facingDegrees: 0,
      walkingSpeed: 0.16,
    },
    stageSettings,
  );
  applyStageWindowBounds();
  persistStageSettingsSoon();
  broadcastStageState();
  return getStageState();
});

ipcMain.on("fufuu:set-display-mode", (_event, mode) => {
  if (mode !== "2d" && mode !== "3d") return;

  const previousMode = currentDisplayMode;
  currentDisplayMode = mode;

  if (previousMode !== currentDisplayMode && !knockInProgress) {
    if (knockReturning) clearRoamingTimer();
    else stopRoamingTimer();
    if (roamingEnabled) scheduleNextRoam(900);
  }

  for (const win of [avatarWindow, chatWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("fufuu:display-mode", currentDisplayMode);
    }
  }
});

ipcMain.on("fufuu:roam:set-enabled", (_event, enabled) => {
  if (typeof enabled !== "boolean") return;
  setRoamingEnabled(enabled);
});

ipcMain.handle("fufuu:roam:get-state", () => ({
  enabled: roamingEnabled,
  moving: movementInProgress,
}));

ipcMain.on("fufuu:roam:knock", () => {
  if (
    knockInProgress ||
    knockReturning ||
    !avatarWindow ||
    avatarWindow.isDestroyed()
  ) {
    return;
  }

  knockInProgress = true;
  clearRoamingTimer();
  stopWindowMovement();
  const bounds = avatarWindow.getBounds();
  knockReturnPosition = { x: bounds.x, y: bounds.y };
  broadcastRoamingState();
  moveAvatarToNearestEdge();
});

ipcMain.on("fufuu:roam:knock-finished", () => {
  if (!knockInProgress) return;

  knockInProgress = false;
  broadcastRoamingState();
  const returnPosition = knockReturnPosition;
  knockReturnPosition = null;

  if (roamingEnabled && currentDisplayMode === "2d") {
    scheduleNextRoam(900);
  } else if (returnPosition) {
    knockReturning = true;
    animateAvatarWindowTo(returnPosition, () => {
      knockReturning = false;
      if (roamingEnabled && currentDisplayMode === "2d") {
        scheduleNextRoam(900);
      }
    });
  }
});

ipcMain.handle("fufuu:voice:speak", async (event, text, options = {}) => {
  if (typeof text !== "string") throw new Error("Speech text must be a string.");
  const senderUrl = event.senderFrame?.url || "";
  if (senderUrl && !ALLOWED_ORIGINS.has(new URL(senderUrl).origin)) {
    throw new Error("Voice requests are only allowed from Fufuu windows.");
  }
  return speakWithPiperPlus(text, options);
});

ipcMain.handle("fufuu:voice:stop", () => stopPiperSpeech());

ipcMain.on("fufuu:speech-bubble:set-enabled", (_event, enabled) => {
  if (typeof enabled !== "boolean") return;
  setSpeechBubbleEnabled(enabled);
});

ipcMain.on("fufuu:speech-bubble:update", (_event, text) => {
  if (typeof text !== "string") return;
  updateSpeechBubbleText(text);
});

ipcMain.on("fufuu:speech-bubble:hide", () => {
  setSpeechBubbleEnabled(false);
});

ipcMain.handle("fufuu:speech-bubble:get-state", () => ({
  enabled: speechBubbleEnabled,
  text: speechBubbleText,
}));

app.whenReady().then(async () => {
  try {
    loadStageSettings();
    await startStorageServer();
    await startVite();
    startSpeechBridge();
    createAvatarWindow();

    const refreshStageForDisplayChange = () => {
      stopRoamingTimer();
      const previousCoverage = stageSettings.coverage;
      const previousDisplayId = stageSettings.displayId;
      if (stageSettings.coverage === "all" && !supportsWholeDesktopStage()) {
        console.warn(
          "[Fufuu] The updated display union exceeds the safe single-window limit; reverting to the primary display.",
        );
        stageSettings = {
          ...stageSettings,
          coverage: "display",
          displayId: screen.getPrimaryDisplay().id,
        };
      }
      stageSettings = clampStageSettings(stageSettings, stageSettings);
      if (
        previousCoverage !== stageSettings.coverage ||
        previousDisplayId !== stageSettings.displayId
      ) {
        persistStageSettingsSoon();
      }
      applyStageWindowBounds();
      broadcastStageState();
      if (roamingEnabled && currentDisplayMode === "2d") {
        scheduleNextRoam(900);
      }
    };
    screen.on("display-added", refreshStageForDisplayChange);
    screen.on("display-removed", refreshStageForDisplayChange);
    screen.on("display-metrics-changed", refreshStageForDisplayChange);
  } catch (error) {
    console.error("Fufuu desktop startup failed:", error);
    app.quit();
  }
});

app.on("activate", () => {
  if (!avatarWindow) createAvatarWindow();
});

app.on("before-quit", () => {
  quitting = true;
  stopRoamingTimer();
  stopPiperSpeech();
  speechBridgeServer?.close();
  viteProcess?.kill();
  storageProcess?.kill();
});

app.on("window-all-closed", () => {
  console.info("[Fufuu] All application windows closed.");
  if (!quitting && process.platform !== "darwin") {
    app.quit();
  }
});
