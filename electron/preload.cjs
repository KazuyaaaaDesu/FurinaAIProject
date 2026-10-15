
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sakuraDesktop", {
  openChat() {
    ipcRenderer.send("sakura:open-chat");
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
