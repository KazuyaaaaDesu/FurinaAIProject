
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const APP_URL = "http://127.0.0.1:5173";
const STORAGE_URL = "http://127.0.0.1:4317/api/health";

let avatarWindow = null;
let chatWindow = null;
let viteProcess = null;
let storageProcess = null;
let quitting = false;

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
    }
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

  try {
    await waitForService(STORAGE_URL, storageProcess, "Storage server");
  } catch (error) {
    console.error(error);
    throw error;
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

  avatarWindow.webContents.openDevTools({ mode: "detach" });
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

ipcMain.on("sakura:open-chat", () => {
  openChatWindow();
});

app.whenReady().then(async () => {
  try {
    await startStorageServer();
    await startVite();
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
  viteProcess?.kill();
  storageProcess?.kill();
});

app.on("window-all-closed", () => {
  if (!quitting && process.platform !== "darwin") {
    app.quit();
  }
});


// Fufuu display-mode synchronization
let currentDisplayMode = "2d";
ipcMain.on("fufuu:set-display-mode", (_event, mode) => {
  if (mode !== "2d" && mode !== "3d") return;
  currentDisplayMode = mode;
  for (const win of [avatarWindow, chatWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("fufuu:display-mode", currentDisplayMode);
    }
  }
});
