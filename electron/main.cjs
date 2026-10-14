
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
let speechBubbleEnabled = false;
let speechBubbleText = "Oh? You're here. What is it?";

let viteProcess = null;
let storageProcess = null;
let speechBridgeServer = null;
let quitting = false;
let currentDisplayMode = "2d";

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

function createAvatarWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.show();
    return;
  }

  avatarWindow = new BrowserWindow({
    width: 360,
    height: 520,
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
  });

  avatarWindow.on("closed", () => {
    avatarWindow = null;
  });
}

function openChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
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

  chatWindow.loadURL(APP_URL);

  chatWindow.once("ready-to-show", () => {
    chatWindow?.show();
  });

  chatWindow.on("closed", () => {
    chatWindow = null;
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

    // Only allow browser requests from the local Fufuu app.
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
      res.end(
        JSON.stringify({
          enabled: speechBubbleEnabled,
          text: speechBubbleText,
        }),
      );
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
        res.end(
          JSON.stringify({
            enabled: speechBubbleEnabled,
            text: speechBubbleText,
          }),
        );
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

ipcMain.on("sakura:open-chat", () => {
  openChatWindow();
});

ipcMain.on("fufuu:set-display-mode", (_event, mode) => {
  if (mode !== "2d" && mode !== "3d") return;

  currentDisplayMode = mode;

  for (const win of [avatarWindow, chatWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("fufuu:display-mode", currentDisplayMode);
    }
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
  speechBridgeServer?.close();
  viteProcess?.kill();
  storageProcess?.kill();
});

app.on("window-all-closed", () => {
  if (!quitting && process.platform !== "darwin") {
    app.quit();
  }
});
