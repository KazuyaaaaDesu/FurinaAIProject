
const { contextBridge, ipcRenderer } = require("electron");

const memoryOpenListeners = new Set();
let pendingMemoryOpen = false;

ipcRenderer.on("sakura:open-memories", () => {
  if (memoryOpenListeners.size === 0) {
    pendingMemoryOpen = true;
    return;
  }

  for (const callback of memoryOpenListeners) {
    callback();
  }
});

contextBridge.exposeInMainWorld("sakuraDesktop", {
  openChat() {
    return ipcRenderer.invoke("sakura:open-chat");
  },

  openMemories() {
    return ipcRenderer.invoke("sakura:open-memories");
  },

  onOpenMemories(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onOpenMemories requires a callback.");
    }

    memoryOpenListeners.add(callback);
    if (pendingMemoryOpen) {
      pendingMemoryOpen = false;
      callback();
    }

    return () => memoryOpenListeners.delete(callback);
  },

  setPointerInteractive(interactive) {
    if (typeof interactive === "boolean") {
      ipcRenderer.send("fufuu:stage:pointer-interactive", interactive);
    }
  },

  beginDesktopStageDrag(screenX, screenY) {
    if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
      ipcRenderer.send("fufuu:stage:drag", "start", { screenX, screenY });
    }
  },

  endDesktopStageDrag() {
    ipcRenderer.send("fufuu:stage:drag", "end");
  },

  getDesktopStageState() {
    return ipcRenderer.invoke("fufuu:stage:get-state");
  },

  updateDesktopStageSettings(settings) {
    return ipcRenderer.invoke("fufuu:stage:update-settings", settings);
  },

  setDesktopStageSize(width, height) {
    return ipcRenderer.invoke("fufuu:stage:set-size", { width, height });
  },

  resetDesktopStageSettings() {
    return ipcRenderer.invoke("fufuu:stage:reset");
  },

  onDesktopStageState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("fufuu:stage:state", listener);
    return () => ipcRenderer.removeListener("fufuu:stage:state", listener);
  },

  setDisplayMode(mode) {
    if (mode === "2d" || mode === "3d") {
      ipcRenderer.send("fufuu:set-display-mode", mode);
    }
  },

  onDisplayMode(callback) {
    const listener = (_event, mode) => {
      if (mode === "2d" || mode === "3d") callback(mode);
    };

    ipcRenderer.on("fufuu:display-mode", listener);
    return () => ipcRenderer.removeListener("fufuu:display-mode", listener);
  },

  setRoamingEnabled(enabled) {
    if (typeof enabled === "boolean") {
      ipcRenderer.send("fufuu:roam:set-enabled", enabled);
    }
  },

  getRoamingState() {
    return ipcRenderer.invoke("fufuu:roam:get-state");
  },

  onRoamingState(callback) {
    const listener = (_event, state) => {
      if (
        state &&
        typeof state.enabled === "boolean" &&
        typeof state.moving === "boolean"
      ) {
        callback(state);
      }
    };

    ipcRenderer.on("fufuu:roam:state", listener);
    return () => ipcRenderer.removeListener("fufuu:roam:state", listener);
  },

  knock() {
    ipcRenderer.send("fufuu:roam:knock");
  },

  completeKnock() {
    ipcRenderer.send("fufuu:roam:knock-finished");
  },

  onKnock(callback) {
    const listener = () => callback();

    ipcRenderer.on("fufuu:avatar:knock", listener);
    return () => ipcRenderer.removeListener("fufuu:avatar:knock", listener);
  },

  setSpeechBubbleEnabled(enabled) {
    if (typeof enabled === "boolean") {
      ipcRenderer.send("fufuu:speech-bubble:set-enabled", enabled);
    }
  },

  updateSpeechBubble(text) {
    if (typeof text === "string") {
      ipcRenderer.send("fufuu:speech-bubble:update", text);
    }
  },

  hideSpeechBubble() {
    ipcRenderer.send("fufuu:speech-bubble:hide");
  },

  getSpeechBubbleState() {
    return ipcRenderer.invoke("fufuu:speech-bubble:get-state");
  },

  onSpeechBubbleEnabled(callback) {
    const listener = (_event, enabled) => callback(Boolean(enabled));

    ipcRenderer.on("fufuu:speech-bubble:enabled", listener);
    return () =>
      ipcRenderer.removeListener("fufuu:speech-bubble:enabled", listener);
  },

  onSpeechBubbleUpdate(callback) {
    const listener = (_event, text) => {
      if (typeof text === "string") callback(text);
    };

    ipcRenderer.on("fufuu:speech-bubble:update", listener);
    return () =>
      ipcRenderer.removeListener("fufuu:speech-bubble:update", listener);
  },
});
