/* ============================================================
   Electron Preload — Secure bridge between main & renderer
   Exposes a safe `window.electronAPI` object via contextBridge.
   ============================================================ */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  login: () => ipcRenderer.invoke("auth:login"),
  logout: () => ipcRenderer.invoke("auth:logout"),
});
