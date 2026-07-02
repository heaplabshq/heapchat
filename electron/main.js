// electron/main.js — desktop shell around the existing Cortex Express server.
// It boots server.js as a child process (using Electron's own bundled Node, so no
// separate Node install is needed), waits for the port, then shows it in a window.
// Day-to-day feature work happens in server.js / public/ — you rarely touch this file.
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, Tray, globalShortcut, nativeImage, systemPreferences } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");
// auto-update (only meaningful in a packaged, published build) — optional require so dev still runs
let autoUpdater = null;
try { ({ autoUpdater } = require("electron-updater")); } catch {}

// Pin the app name BEFORE app is ready so userData resolves to a stable, branded folder
// (…/Cortex/) in both dev and packaged builds — otherwise dev would use "…/Electron".
app.setName("Cortex");

const PORT = Number(process.env.CORTEX_PORT) || 5174;
const BASE_URL = `http://localhost:${PORT}`;
// In a packaged app, __dirname is inside app.asar (read-only); resolve the server entry from there.
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");

let serverProc = null;
let mainWindow = null;
let tray = null;
let updateInteractive = false;   // true when the user explicitly clicked "Check for Updates"
let mainReady = false;           // the main window's React app has mounted + subscribed
let pendingContinue = null;      // a Quick Ask exchange waiting to be handed to the main window

// deliver a buffered "Continue in Cortex" payload once the renderer is actually listening
function flushContinue() {
  if (pendingContinue && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("native:continue-chat", pendingContinue);
    pendingContinue = null;
  }
}

/* ---- boot the Express server as a child of this process ---- */
function startServer() {
  if (serverProc) return;
  const env = {
    ...process.env,
    PORT: String(PORT),
    // packaged app dir is read-only → keep all user data in a writable per-user location
    CORTEX_DATA_DIR: path.join(app.getPath("userData"), "data"),
    // run the Electron binary as a plain Node process for the child (no second Node needed)
    ELECTRON_RUN_AS_NODE: "1",
  };
  serverProc = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: "inherit" });
  serverProc.on("exit", (code) => {
    serverProc = null;
    if (code && code !== 0 && !app.isQuitting) {
      dialog.showErrorBox("Cortex", `The Cortex server stopped unexpectedly (exit ${code}).`);
    }
  });
  serverProc.on("error", (err) => {
    dialog.showErrorBox("Cortex", `Could not start the server:\n${err.message}`);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    const p = serverProc;
    serverProc = null;
    p.once("exit", resolve);       // wait for the port to actually free before any restart
    try { p.kill(); } catch { resolve(); }
    setTimeout(resolve, 4000);     // safety: never hang if exit never fires
  });
}

/* ---- wait until the server answers before loading the window ---- */
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(BASE_URL, (res) => { res.destroy(); resolve(); });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("Server did not start in time"));
        else setTimeout(ping, 300);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    ping();
  });
}

/* ---- dev hot-reload: restart the child server / reload the window on file changes ---- */
function reloadWindows() {
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.reloadIgnoringCache(); } catch {} }
}
let restarting = false;
async function restartServer() {
  if (restarting) return;          // coalesce a burst of save events into one restart
  restarting = true;
  try {
    await stopServer();
    startServer();
    await waitForServer();
    reloadWindows();
    console.log("[dev] server.js changed → restarted server + reloaded UI");
  } catch (e) {
    console.error("[dev] server restart failed:", e.message);
  } finally {
    restarting = false;
  }
}
// Watch source in development only. A packaged build runs from a read-only asar, ships no
// watchable tree, and must never restart itself — so this is gated on !app.isPackaged.
let uiBuildProc = null;
function setupDevWatch() {
  if (app.isPackaged) return;
  const root = path.join(__dirname, "..");
  let timer = null;
  const debounce = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 250); };
  try {
    // public/js/*.jsx is transpiled+concatenated into public/app.js at build time.
    // In dev, run the esbuild watcher so jsx edits rebuild app.js (which then triggers a reload below).
    uiBuildProc = spawn(process.execPath, [path.join(root, "build", "esbuild.mjs"), "--watch"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
    // server-side change → restart the child server, then reload the window(s)
    fs.watch(root, { recursive: false }, (_evt, file) => { if (file === "server.js") debounce(restartServer); });
    // server.js now delegates to modules under src/ — watch the whole tree so edits there restart too
    try { fs.watch(path.join(root, "src"), { recursive: true }, (_evt, file) => { if (file && /\.js$/i.test(file)) debounce(restartServer); }); } catch {}
    // reload on the built bundle / css / html (jsx edits flow through esbuild → app.js → here)
    fs.watch(path.join(root, "public"), { recursive: true }, (_evt, file) => {
      if (file && /app\.js$|\.(css|html)$/i.test(file)) debounce(reloadWindows);
    });
    console.log("[dev] watching server.js + src/ (auto-restart) + public/ (auto-reload, esbuild --watch on js/)");
  } catch (e) { console.error("[dev] watch setup failed:", e.message); }
}

/* ---- the native window ---- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1419",
    title: "Cortex",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // secure defaults — the web page can't touch Node directly,
      nodeIntegration: false,   // only the small, explicit bridge in preload.js
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(BASE_URL);

  // open target=_blank / external links in the user's real browser, not a new app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE_URL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; mainReady = false; });
}

/* ---- generic native bridge: IPC handlers the web app can call (see preload.js) ----
   Add a handler here + expose it in preload.js whenever a future feature needs a
   native capability. Existing web features never go through here. */
function registerNativeBridge() {
  ipcMain.handle("native:pickFolder", async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath || undefined,
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // pick a folder OR a file in one dialog (macOS supports both at once; Windows/Linux fall back
  // to a directory chooser). Returns the path plus whether it's a directory so the UI can route it.
  ipcMain.handle("native:pickPath", async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "openDirectory", "createDirectory"],
      defaultPath: defaultPath || undefined,
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    let isDirectory = false;
    try { isDirectory = fs.statSync(p).isDirectory(); } catch {}
    return { path: p, isDirectory };
  });
  ipcMain.handle("native:pickFiles", async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      defaultPath: defaultPath || undefined,
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle("native:notify", (_e, { title, body } = {}) => {
    if (Notification.isSupported()) new Notification({ title: title || "Cortex", body: body || "" }).show();
    return true;
  });
  ipcMain.handle("native:version", () => app.getVersion());
  // Quick Ask panel controls
  ipcMain.handle("native:quickHide", () => { if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); });
  ipcMain.handle("native:openMain", (_e, payload) => {
    if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
    if (payload && payload.question) {
      pendingContinue = payload;
      withWindow(() => {});            // surface the main window (creating it if needed)
      if (mainReady) flushContinue();  // already mounted → deliver now; otherwise the renderer flushes on ready
    } else {
      summon();
    }
  });
  // the main window's React app calls this on mount → deliver anything buffered for it
  ipcMain.handle("native:rendererReady", () => { mainReady = true; flushContinue(); });
  ipcMain.handle("native:captureScreenshot", () => captureScreenshot());
}

/* ---- app:action channel ---- tray/menu/hotkey ask the (authenticated) web app to do something.
   The renderer listens via window.cortex.onAction (see preload.js + app.jsx). */
function sendAction(name) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:action", name);
}
// ensure the main window exists + is focused, then run cb once its page is ready
function withWindow(cb) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  if (!cb) return;
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", cb);
  else cb();
}
function summon(action) { withWindow(action ? () => sendAction(action) : null); }

/* ---- ingest into the KB ---- the main process can't hit the authenticated server itself, so it
   hands files/folders to the (logged-in) renderer, which uploads/opens them. Used by the screenshot
   capture and by Finder/Dock drops. */
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", pdf: "application/pdf" };
function fileToPayload(p) {
  try {
    const buf = fs.readFileSync(p);
    if (!buf.length || buf.length > 50 * 1024 * 1024) return null;   // matches the KB upload limit
    const ext = path.extname(p).slice(1).toLowerCase();
    return { name: path.basename(p), dataUrl: `data:${MIME[ext] || "application/octet-stream"};base64,${buf.toString("base64")}` };
  } catch { return null; }
}
function ingestPaths(paths) {
  const folders = [], files = [];
  for (const p of paths) { try { (fs.statSync(p).isDirectory() ? folders : files).push(p); } catch {} }
  if (folders.length) withWindow(() => folders.forEach(f => mainWindow.webContents.send("native:open-folder", { path: f })));
  const payloads = files.map(fileToPayload).filter(Boolean);
  if (payloads.length) withWindow(() => mainWindow.webContents.send("native:ingest-files", { files: payloads }));
}

/* ---- macOS region screenshot → KB ---- uses the OS screenshot tool; the PNG is ingested + OCR'd.
   macOS gates all screen capture behind the Screen Recording permission — without it screencapture
   silently yields nothing, so we check first and guide the user to grant it. */
function ensureScreenPermission() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return true;
  // first-ever attempt: let Apple's own `screencapture` raise the standard "record the screen" prompt
  if (status === "not-determined") return true;
  // explicitly denied/restricted → can't prompt again, send the user to the right Settings pane
  const r = dialog.showMessageBoxSync(mainWindow, {
    type: "info", buttons: ["Open Settings", "Cancel"], defaultId: 0, cancelId: 1,
    message: "Allow Screen Recording",
    detail: "macOS needs Screen Recording permission to capture screenshots.\n\nEnable Cortex under System Settings → Privacy & Security → Screen Recording, then quit and reopen the app.\n\nWhen running from a code editor in development, the permission is attributed to that editor (e.g. “Visual Studio Code”) instead — for a clean test, launch the packaged Cortex app.",
  });
  if (r === 0) shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  return false;
}
function captureScreenshot() {
  if (process.platform !== "darwin") { dialog.showMessageBox(mainWindow, { message: "Screenshot capture is macOS-only for now." }); return; }
  if (!ensureScreenPermission()) return;
  const tmp = path.join(app.getPath("temp"), `cortex-shot-${Date.now()}.png`);
  const proc = spawn("screencapture", ["-i", tmp]);   // -i = interactive region/window selection
  proc.on("exit", () => {
    let buf = null; try { buf = fs.readFileSync(tmp); } catch {}
    if (buf && buf.length) {
      const stamp = new Date().toLocaleString().replace(/[/:,]/g, "-").replace(/\s+/g, " ").trim();
      const payload = { name: `Screenshot ${stamp}.png`, dataUrl: `data:image/png;base64,${buf.toString("base64")}` };
      withWindow(() => mainWindow.webContents.send("native:ingest-files", { files: [payload], source: "screenshot" }));
    }
    try { fs.unlinkSync(tmp); } catch {}
  });
}

/* ---- Quick Ask: a small, always-on-top Spotlight-style panel ---- */
let quickWin = null;
function toggleQuickAsk() {
  if (quickWin && !quickWin.isDestroyed()) {
    if (quickWin.isVisible()) { quickWin.hide(); return; }
    quickWin.show(); quickWin.focus(); return;
  }
  quickWin = new BrowserWindow({
    width: 660, height: 480, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: "#0f1419", show: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  quickWin.loadURL(BASE_URL + "?quick=1");
  quickWin.once("ready-to-show", () => { quickWin.show(); quickWin.focus(); });
  quickWin.on("blur", () => { if (quickWin && !quickWin.webContents.isDevToolsOpened()) quickWin.hide(); });   // dismiss like Spotlight
  quickWin.on("closed", () => { quickWin = null; });
  quickWin.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(BASE_URL)) shell.openExternal(url); return { action: "deny" }; });
}

/* ---- menu-bar / system-tray icon ---- */
function createTray() {
  try {
    // use a bundled icon (build/ isn't packaged; public/ is) and size it down for the tray
    const img = nativeImage.createFromPath(path.join(__dirname, "..", "public", "icon-192.png")).resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip("Cortex");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Cortex", click: () => summon() },
      { label: "New chat", accelerator: "CmdOrCtrl+N", click: () => summon("new-chat") },
      { label: "Quick Ask…", accelerator: "CmdOrCtrl+Shift+A", click: () => toggleQuickAsk() },
      ...(process.platform === "darwin" ? [{ label: "Capture Screenshot to KB", accelerator: "CmdOrCtrl+Shift+2", click: () => captureScreenshot() }] : []),
      { type: "separator" },
      { label: "Quit Cortex", click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on("click", () => summon());
  } catch (e) { console.error("tray:", e.message); }
}

/* ---- global hotkey: summon Cortex to a fresh chat from anywhere ---- */
function registerShortcuts() {
  try {
    globalShortcut.register("CommandOrControl+Shift+A", () => toggleQuickAsk());        // Spotlight-style Quick Ask
    if (process.platform === "darwin") globalShortcut.register("CommandOrControl+Shift+2", () => captureScreenshot());  // region screenshot → KB
  } catch (e) { console.error("hotkey:", e.message); }
}

/* ---- native application menu (gives Cmd-N / Cmd-, and standard roles) ---- */
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const settingsItem = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => summon("open-settings") };
  const updatesItem = autoUpdater ? { label: "Check for Updates…", click: checkForUpdatesInteractive } : null;
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        ...(updatesItem ? [updatesItem] : []),
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => summon("new-chat") },
        { label: "Quick Ask…", accelerator: "CmdOrCtrl+Shift+A", click: () => toggleQuickAsk() },
        ...(isMac ? [{ label: "Capture Screenshot to KB", accelerator: "CmdOrCtrl+Shift+2", click: () => captureScreenshot() }] : []),
        ...(!isMac ? [{ type: "separator" }, settingsItem] : []),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Learn about Ollama", click: () => shell.openExternal("https://ollama.com") },
        ...(!isMac && updatesItem ? [updatesItem] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---- auto-update (electron-updater) ---- only runs in a packaged build with a published release.
   NOTE: on macOS, applying an update requires the app to be code-signed; unsigned builds will
   download but not install. Windows (NSIS) auto-update works unsigned. */
function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      message: `Cortex ${info.version} is ready`, detail: "Restart to finish updating.",
    });
    if (r === 0) { app.isQuitting = true; autoUpdater.quitAndInstall(); }
  });
  autoUpdater.on("update-not-available", () => {
    if (updateInteractive) { updateInteractive = false; dialog.showMessageBox(mainWindow, { message: "You're on the latest version." }); }
  });
  autoUpdater.on("error", (e) => {
    if (updateInteractive) { updateInteractive = false; dialog.showMessageBox(mainWindow, { message: "Update check failed", detail: String((e && e.message) || e) }); }
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}
function checkForUpdatesInteractive() {
  if (!autoUpdater || !app.isPackaged) { dialog.showMessageBox(mainWindow, { message: "Updates apply to the installed app only." }); return; }
  updateInteractive = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

/* ---- lifecycle ---- */
// single-instance: focus the existing window instead of launching a second copy + server
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    // Windows passes opened file paths as argv on the second instance
    const paths = argv.slice(1).filter(a => { try { return fs.existsSync(a); } catch { return false; } });
    if (paths.length) ingestPaths(paths);
  });

  // macOS: files/folders dropped on the Dock icon or opened via "Open With Cortex".
  // Can fire before the app is ready, so queue until the window exists.
  const pendingOpen = [];
  app.on("open-file", (e, p) => { e.preventDefault(); if (app.isReady() && mainWindow) ingestPaths([p]); else pendingOpen.push(p); });

  app.whenReady().then(async () => {
    registerNativeBridge();
    buildAppMenu();
    startServer();
    try {
      await waitForServer();
    } catch (e) {
      dialog.showErrorBox("Cortex", `The server didn't come up:\n${e.message}`);
    }
    createWindow();
    createTray();
    registerShortcuts();
    setupAutoUpdate();
    setupDevWatch();   // dev only: hot-restart the server / reload the UI on source changes
    if (pendingOpen.length) { withWindow(() => ingestPaths(pendingOpen.splice(0))); }   // files opened before ready

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("before-quit", () => { app.isQuitting = true; stopServer(); });
  app.on("quit", () => { stopServer(); if (uiBuildProc) { try { uiBuildProc.kill(); } catch {} } });
}
