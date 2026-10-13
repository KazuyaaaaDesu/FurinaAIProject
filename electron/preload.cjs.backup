
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sakuraDesktop", {
  openChat() {
    ipcRenderer.send("sakura:open-chat");
  },
});
