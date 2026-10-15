
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const APP_URL = "http://127.0.0.1:5173";
const STORAGE_URL = "http://127.0.0.1:4317/api/health";

const SPEECH_BRIDGE_HOST = "127.0.0.1";
const SPEECH_BRIDGE_PORT = 4318;

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

let avatarWindow = null;
let chatWindow = null;
let speechBubbleWindow = null;
const loadedChatWebContents = new WeakSet();
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

  avatarWindow = new BrowserWindow({
    width: AVATAR_WIDTH,
    height: AVATAR_HEIGHT,
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

  avatarWindow.loadURL(`${APP_URL}/?avatar=1`);

  avatarWindow.once("ready-to-show", () => {
    avatarWindow?.show();
    broadcastRoamingState();
  });

  avatarWindow.on("close", () => {
    console.info("[Fufuu] Avatar window close requested.");
  });

  avatarWindow.on("closed", () => {
    console.info("[Fufuu] Avatar window closed.");
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
    await startStorageServer();
    await startVite();
    startSpeechBridge();
    createAvatarWindow();
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
