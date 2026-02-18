/* ============================================================
   Technical Delivery Architect — Electron Main Process
   Creates the desktop window, starts the internal Express server.
   Auth via Azure CLI — Work IQ handles Graph API internally.
   ============================================================ */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

let mainWindow = null;
let serverPort = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Technical Delivery Architect",
    icon: path.join(__dirname, "public", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.setMenuBarVisibility(false);

  // Load the app once the Express server is ready
  mainWindow.loadURL(`http://localhost:${serverPort}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ------------- IPC handlers -------------

ipcMain.handle("auth:status", () => {
  const { isAuthenticated, getUserName } = require("./auth/msalConfig");
  return { authenticated: isAuthenticated(), name: getUserName() };
});

ipcMain.handle("auth:login", async () => {
  const { login } = require("./auth/msalConfig");
  try {
    const result = await login();
    return { success: true, name: result.name };
  } catch (err) {
    console.error("Login failed:", err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("auth:logout", () => {
  const { logout } = require("./auth/msalConfig");
  logout();
  return { ok: true };
});

// ------------- Boot sequence -------------

app.whenReady().then(async () => {
  // 1. Start Express server on a random available port
  const { startServer } = require("./server");
  serverPort = await startServer(0);

  // 2. Create & show window (login screen will be displayed)
  createWindow();
});

app.on("window-all-closed", () => {
  // Gracefully shut down the Copilot SDK client
  const { stopClient } = require("./lib/copilot");
  stopClient().catch(() => {}).finally(() => app.quit());
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
