// electron/preload.js — the ONLY bridge between the web app and native capabilities.
// Runs with contextIsolation, so it exposes a small, explicit, safe surface on
// window.cortex. The frontend can feature-detect it:
//
//   if (window.cortex) { const dir = await window.cortex.pickFolder(); ... }
//   else { /* running in a plain browser — use the in-app folder picker */ }
//
// To add a native feature later: add an ipcMain.handle() in main.js and a matching
// method here. Nothing else in the app needs to change.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cortex", {
  isDesktop: true,
  platform: process.platform,
  pickFolder: (defaultPath) => ipcRenderer.invoke("native:pickFolder", defaultPath),
  pickPath: (defaultPath) => ipcRenderer.invoke("native:pickPath", defaultPath),
  pickFiles: (defaultPath) => ipcRenderer.invoke("native:pickFiles", defaultPath),
  notify: (title, body) => ipcRenderer.invoke("native:notify", { title, body }),
  version: () => ipcRenderer.invoke("native:version"),
  // subscribe to actions fired by the tray / menu / global hotkey (e.g. "new-chat", "open-settings").
  // returns an unsubscribe function.
  onAction: (cb) => {
    const fn = (_e, name) => cb(name);
    ipcRenderer.on("app:action", fn);
    return () => ipcRenderer.removeListener("app:action", fn);
  },
  // screenshot capture + Finder/Dock drops: the main process hands files/folders to the renderer to ingest
  onIngestFiles: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("native:ingest-files", fn);
    return () => ipcRenderer.removeListener("native:ingest-files", fn);
  },
  onOpenFolder: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("native:open-folder", fn);
    return () => ipcRenderer.removeListener("native:open-folder", fn);
  },
  captureScreenshot: () => ipcRenderer.invoke("native:captureScreenshot"),
  // Quick Ask panel controls (used by the ?quick window)
  quickHide: () => ipcRenderer.invoke("native:quickHide"),
  openMain: (payload) => ipcRenderer.invoke("native:openMain", payload),
  // main window: continue a Quick Ask exchange as a real chat
  onContinueChat: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("native:continue-chat", fn);
    return () => ipcRenderer.removeListener("native:continue-chat", fn);
  },
  rendererReady: () => ipcRenderer.invoke("native:rendererReady"),
});
