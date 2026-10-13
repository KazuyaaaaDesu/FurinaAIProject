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
});
