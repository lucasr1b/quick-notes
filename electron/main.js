const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  net,
  protocol,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const Store = require("electron-store");
const { createVault } = require("./vault");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "qn-image",
    privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  },
]);

const isDev = !app.isPackaged;

// A separate profile for demos and screen recordings (npm run demo), so they
// never touch the real window state. Must run before electron-store opens.
if (process.env.QUICK_NOTES_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.QUICK_NOTES_USER_DATA));
}

const store = new Store({
  defaults: {
    notes: [],
    windows: [],
    legacyMigrated: false,
    // legacy (retained so older installs still read cleanly during migration)
    notesBounds: { width: 380, height: 480, x: undefined, y: undefined },
    alwaysOnTop: true,
    launchAtStartup: false,
    shortcut: "Ctrl+Alt+Command+N",
    vaultPath: null,
  },
});

// A few presets rather than a key recorder: all of them are free in macOS and
// the common apps, and the menu bar can offer them as a plain radio list.
const SHORTCUTS = [
  { accelerator: "Ctrl+Alt+Command+N", label: "⌃⌥⌘N" },
  { accelerator: "Alt+Command+N", label: "⌥⌘N" },
  { accelerator: "Ctrl+Command+N", label: "⌃⌘N" },
  { accelerator: "Ctrl+Alt+N", label: "⌃⌥N" },
];

// Notes live as files in the vault: QUICK_NOTES_VAULT if set, else the folder
// picked from the menu bar, else ~/Documents/quick-notes. electron-store holds
// only settings and window state; its old `notes` key is left untouched as a
// backup of the pre-vault data.
const vault = createVault(process.env.QUICK_NOTES_VAULT || store.get("vaultPath") || undefined);

/** @type {Map<string, BrowserWindow>} */
const windows = new Map();

let loadURL;
if (!isDev) {
  // electron-serve v3 is ESM-first: require() hands back { default: fn }, not
  // the function itself. Only the packaged app takes this path, which is why
  // `electron:dev` never showed the breakage.
  const serveModule = require("electron-serve");
  const serve =
    typeof serveModule === "function" ? serveModule : serveModule.default;
  loadURL = serve({ directory: path.join(__dirname, "../out") });
}

let tray;
let isQuitting = false;

/* ═══════════════════════════════════════════════════════════ */
/*  HELPERS                                                   */
/* ═══════════════════════════════════════════════════════════ */

function newWindowId() {
  return `win-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function newNote() {
  return {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: "Untitled",
    customTitle: false,
    content: null,
    pinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getWindowsState() {
  return store.get("windows", []);
}

function saveWindowsState(next) {
  store.set("windows", next);
}

function upsertWindowState(winState) {
  const all = getWindowsState();
  const idx = all.findIndex((w) => w.id === winState.id);
  if (idx >= 0) all[idx] = winState;
  else all.push(winState);
  saveWindowsState(all);
}

function removeWindowState(id) {
  saveWindowsState(getWindowsState().filter((w) => w.id !== id));
}

function windowIdFromSender(event) {
  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw) return null;
  for (const [id, win] of windows) {
    if (win === bw) return id;
  }
  return null;
}

function validateBounds(bounds) {
  if (!bounds || bounds.x === undefined || bounds.y === undefined) return false;
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    return (
      bounds.x >= x - 100 &&
      bounds.y >= y - 100 &&
      bounds.x < x + width + 100 &&
      bounds.y < y + height + 100
    );
  });
}

function broadcastNotesUpdated(exceptWindowId = null) {
  for (const [id, win] of windows) {
    if (id === exceptWindowId) continue;
    if (win && !win.isDestroyed()) {
      win.webContents.send("notes:updated");
    }
  }
}

/* ═══════════════════════════════════════════════════════════ */
/*  WINDOW CREATION                                           */
/* ═══════════════════════════════════════════════════════════ */

function createNotesWindow(winState) {
  const bounds = winState.bounds || {};
  const defaults = { width: 380, height: 480 };

  const opts = {
    width: bounds.width || defaults.width,
    height: bounds.height || defaults.height,
    minWidth: 300,
    minHeight: 300,
    alwaysOnTop: store.get("alwaysOnTop", true),
    frame: false,
    titleBarStyle: "hiddenInset",
    // centred in the 38px title bar: (38 - 12) / 2
    trafficLightPosition: { x: 13, y: 13 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--winId=${winState.id}`],
    },
  };

  if (validateBounds(bounds)) {
    opts.x = bounds.x;
    opts.y = bounds.y;
  }

  const win = new BrowserWindow(opts);

  // Keep the window visible when other apps enter fullscreen (their own Space).
  // Without this, alwaysOnTop windows vanish when another app goes fullscreen.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (store.get("alwaysOnTop", true)) {
    win.setAlwaysOnTop(true, "floating");
  }

  const query = `?winId=${encodeURIComponent(winState.id)}`;
  if (isDev) {
    win.loadURL(`http://localhost:3800/${query}`);
  } else {
    loadURL(win).then(() => {
      win.webContents
        .executeJavaScript(`history.replaceState({}, '', '${query}')`)
        .catch(() => {});
    });
  }

  win.once("ready-to-show", () => win.show());

  const persistBounds = () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const all = getWindowsState();
    const existing = all.find((w) => w.id === winState.id);
    if (existing) {
      existing.bounds = b;
      saveWindowsState(all);
    }
  };

  win.on("moved", persistBounds);
  win.on("resized", persistBounds);

  win.on("closed", () => {
    windows.delete(winState.id);
    // Only forget the window from the store when the user explicitly closed it.
    // On app quit we want the currently-open windows to be restored on next launch.
    if (!isQuitting) {
      removeWindowState(winState.id);
      buildTrayMenu();
    }
  });

  windows.set(winState.id, win);
  upsertWindowState(winState);
  buildTrayMenu();
  return win;
}

function spawnNewWindow({ initialNote, bounds, viewMode } = {}) {
  let noteId = initialNote || null;
  if (!noteId) {
    const notes = vault.list();
    const fresh = newNote();
    vault.saveAll([fresh, ...notes]);
    noteId = fresh.id;
  }

  const winState = {
    id: newWindowId(),
    noteId,
    viewMode: viewMode || "rich",
    bounds: bounds || null,
  };

  createNotesWindow(winState);
  broadcastNotesUpdated();
  return winState.id;
}

function closeWindowById(id) {
  const win = windows.get(id);
  if (!win) return;
  if (win.isDestroyed()) {
    windows.delete(id);
    removeWindowState(id);
    return;
  }
  win.close();
}

function toggleFrontmostWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    if (focused.isVisible()) {
      focused.hide();
      if (process.platform === "darwin") app.hide();
    } else {
      focused.show();
      focused.focus();
    }
    return;
  }
  if (windows.size === 0) {
    spawnNewWindow({});
    return;
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  }
}

/* ═══════════════════════════════════════════════════════════ */
/*  MIGRATION                                                 */
/* ═══════════════════════════════════════════════════════════ */

function migrateLegacyIfNeeded() {
  if (store.get("legacyMigrated", false)) return;
  const existingWindows = getWindowsState();
  if (existingWindows.length > 0) {
    // Previous install already wrote window state — migrate any old-shape
    // entries (tabs/activeTab) to the new noteId shape.
    const migrated = existingWindows
      .map((w) => {
        if (typeof w.noteId !== "undefined") return w;
        const noteId =
          w.activeTab ?? (Array.isArray(w.tabs) && w.tabs[0]) ?? null;
        return {
          id: w.id,
          noteId,
          viewMode: w.viewMode || "rich",
          bounds: w.bounds || null,
        };
      })
      .filter((w) => w.noteId);
    saveWindowsState(migrated);
    store.set("legacyMigrated", true);
    return;
  }
  const notes = vault.list();
  const legacyBounds = store.get("notesBounds", null);
  if (notes.length > 0) {
    const winState = {
      id: newWindowId(),
      noteId: notes[0].id,
      viewMode: "rich",
      bounds: legacyBounds && legacyBounds.width ? legacyBounds : null,
    };
    saveWindowsState([winState]);
  }
  store.set("legacyMigrated", true);
}

/* ═══════════════════════════════════════════════════════════ */
/*  TRAY                                                      */
/* ═══════════════════════════════════════════════════════════ */

function createTray() {
  const iconPath = path.join(__dirname, "assets", "TrayIconTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip("Quick Notes");
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;

  const notes = vault.list();
  const pinnedNotes = notes.filter((n) => n.pinned);
  const recentNotes = notes.filter((n) => !n.pinned).slice(0, 5);

  const alwaysOnTop = store.get("alwaysOnTop", true);
  const launchAtStartup = store.get("launchAtStartup", false);

  const template = [
    {
      label: "Toggle Quick Notes",
      accelerator: store.get("shortcut"),
      registerAccelerator: false,
      click: () => toggleFrontmostWindow(),
    },
    { type: "separator" },
    {
      label: "New Note (New Window)",
      click: () => spawnNewWindow({}),
    },
    { type: "separator" },
  ];

  if (pinnedNotes.length > 0) {
    template.push({
      label: "Pinned",
      submenu: pinnedNotes.map((note) => ({
        label: note.title || "Untitled",
        click: () => jumpToNote(note.id),
      })),
    });
  }

  if (recentNotes.length > 0) {
    template.push({
      label: "Recent",
      submenu: recentNotes.map((note) => ({
        label: note.title || "Untitled",
        click: () => jumpToNote(note.id),
      })),
    });
  }

  template.push({
    label: `${notes.length} Note${notes.length !== 1 ? "s" : ""}`,
    enabled: false,
  });

  template.push({ type: "separator" });

  template.push({
    label: "Launch on Startup",
    type: "checkbox",
    checked: launchAtStartup,
    click: (menuItem) => {
      const enabled = menuItem.checked;
      store.set("launchAtStartup", enabled);
      app.setLoginItemSettings({ openAtLogin: enabled });
    },
  });

  template.push({
    label: "Always on Top",
    type: "checkbox",
    checked: alwaysOnTop,
    click: (menuItem) => {
      const enabled = menuItem.checked;
      store.set("alwaysOnTop", enabled);
      for (const win of windows.values()) {
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(enabled, enabled ? "floating" : "normal");
          win.setVisibleOnAllWorkspaces(enabled, { visibleOnFullScreen: enabled });
        }
      }
    },
  });

  const current = store.get("shortcut");
  template.push({
    label: "Shortcut",
    submenu: SHORTCUTS.map((s) => ({
      label: s.label,
      type: "radio",
      checked: s.accelerator === current,
      click: () => setShortcut(s.accelerator),
    })),
  });

  const fromEnv = Boolean(process.env.QUICK_NOTES_VAULT);
  template.push({
    label: "Notes Folder",
    submenu: [
      { label: prettyPath(vault.vault), enabled: false },
      ...(fromEnv ? [{ label: "Set by QUICK_NOTES_VAULT", enabled: false }] : []),
      { type: "separator" },
      { label: "Show in Finder", click: () => shell.openPath(vault.vault) },
      { label: "Change Folder…", enabled: !fromEnv, click: () => chooseNotesFolder() },
      { type: "separator" },
      { label: "Export All Notes…", click: () => exportAllNotes() },
      { label: "Import Notes…", click: () => importNotes() },
    ],
  });

  template.push({ type: "separator" });

  template.push({
    label: "Quit Quick Notes",
    accelerator: "CommandOrControl+Q",
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/* ═══════════════════════════════════════════════════════════ */
/*  SETTINGS                                                  */
/* ═══════════════════════════════════════════════════════════ */

function prettyPath(p) {
  const home = require("os").homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function registerShortcut(accelerator) {
  try {
    return globalShortcut.register(accelerator, () => toggleFrontmostWindow());
  } catch {
    return false;
  }
}

function setShortcut(accelerator) {
  const previous = store.get("shortcut");
  if (accelerator === previous) return;
  globalShortcut.unregister(previous);
  if (registerShortcut(accelerator)) {
    store.set("shortcut", accelerator);
  } else {
    registerShortcut(previous);
    const label = SHORTCUTS.find((s) => s.accelerator === accelerator)?.label || accelerator;
    dialog.showMessageBox({
      type: "warning",
      message: `${label} is already taken`,
      detail: "Another app is using that shortcut. Quick Notes kept the one it had.",
    });
  }
  buildTrayMenu();
}

const isVault = (dir) => fs.existsSync(path.join(dir, "notes"));
const isEmptyDir = (dir) => fs.readdirSync(dir).filter((f) => f !== ".DS_Store").length === 0;

/**
 * Point the vault at another folder. A folder that already holds notes is
 * opened as it is; otherwise the current notes are copied in (into a
 * quick-notes subfolder unless the folder is empty, so picking iCloud Drive
 * does not scatter files across it). The old folder is left in place as a
 * backup, and the app relaunches on the new one.
 */
async function chooseNotesFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Choose Notes Folder",
    message: "Choose where Quick Notes keeps your notes",
    buttonLabel: "Use Folder",
    defaultPath: path.dirname(vault.vault),
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths[0]) return;

  const picked = path.resolve(filePaths[0]);
  let target = picked;
  if (!isVault(picked) && !isEmptyDir(picked)) target = path.join(picked, "quick-notes");
  if (target === vault.vault) return;
  if (target.startsWith(vault.vault + path.sep)) {
    dialog.showMessageBox({
      type: "warning",
      message: "Pick a folder outside the current notes folder",
      detail: prettyPath(vault.vault),
    });
    return;
  }

  const opening = isVault(target);
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: [opening ? "Open Notes" : "Copy and Switch", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: opening
      ? `Open the notes in ${prettyPath(target)}?`
      : `Copy your notes to ${prettyPath(target)}?`,
    detail: opening
      ? "That folder already has notes, so Quick Notes will switch to them. Your current notes stay where they are."
      : "Quick Notes will copy everything there and restart. The current folder is left untouched as a backup.",
  });
  if (response !== 0) return;

  try {
    if (!opening) {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(vault.vault, target, { recursive: true, force: false, errorOnExist: false });
    }
  } catch (err) {
    dialog.showErrorBox("Couldn't copy your notes", err.message);
    return;
  }

  store.set("vaultPath", target);
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

/* ═══════════════════════════════════════════════════════════ */
/*  EXPORT / IMPORT                                           */
/* ═══════════════════════════════════════════════════════════ */

// Attach dialogs to the note window when there is one: the windows float above
// everything, so a free-standing dialog can open behind them.
const showDialog = (fn, parent, opts) => (parent ? fn(parent, opts) : fn(opts));

/**
 * Everything another Mac needs, as one zip: "Quick Notes/" holding notes/,
 * images/, order.json and a manifest. Zipped with ditto, which ships with
 * macOS, so there is no archive library to bundle.
 */
async function exportAllNotes(parent) {
  const day = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await showDialog(dialog.showSaveDialog, parent, {
    title: "Export All Notes",
    buttonLabel: "Export",
    defaultPath: path.join(app.getPath("desktop"), `Quick Notes ${day}.zip`),
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (canceled || !filePath) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quick-notes-export-"));
  const stage = path.join(tmp, "Quick Notes");
  try {
    const notes = vault.exportInto(stage);
    const manifest = {
      app: "quick-notes",
      format: 1,
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      notes,
    };
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.rmSync(filePath, { force: true });
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", stage, filePath]);
    shell.showItemInFolder(filePath);
    return { notes };
  } catch (err) {
    dialog.showErrorBox("Couldn't export your notes", err.message);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The folder inside an unzipped export that holds notes/, if any. */
function findExportRoot(dir) {
  if (fs.existsSync(path.join(dir, "notes"))) return dir;
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    if (name === "__MACOSX" || !fs.statSync(sub).isDirectory()) continue;
    if (fs.existsSync(path.join(sub, "notes"))) return sub;
  }
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Merges a zip from Export All Notes into this vault. See vault.importFrom. */
async function importNotes(parent) {
  const { canceled, filePaths } = await showDialog(dialog.showOpenDialog, parent, {
    title: "Import Notes",
    buttonLabel: "Import",
    defaultPath: app.getPath("desktop"),
    properties: ["openFile"],
    filters: [{ name: "Quick Notes export", extensions: ["zip"] }],
  });
  if (canceled || !filePaths[0]) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quick-notes-import-"));
  try {
    execFileSync("/usr/bin/ditto", ["-x", "-k", filePaths[0], tmp]);
    const root = findExportRoot(tmp);
    if (!root) {
      await showDialog(dialog.showMessageBox, parent, {
        type: "warning",
        message: "There are no notes in that zip",
        detail: "Pick a .zip made with Export All Notes.",
      });
      return null;
    }

    const stats = vault.importFrom(root);
    buildTrayMenu();
    broadcastNotesUpdated();

    const changed = stats.added + stats.updated;
    const detail = [
      stats.added && `${plural(stats.added, "new note")} added.`,
      stats.updated && `${plural(stats.updated, "note")} replaced by a newer copy. The older copies are in the versions folder.`,
      stats.unchanged && `${plural(stats.unchanged, "note")} already up to date.`,
      stats.images && `${plural(stats.images, "image")} copied.`,
    ].filter(Boolean);
    await showDialog(dialog.showMessageBox, parent, {
      type: "info",
      message: changed ? `Imported ${plural(changed, "note")}` : "All of these notes were already here",
      detail: detail.join("\n"),
    });
    return stats;
  } catch (err) {
    dialog.showErrorBox("Couldn't import those notes", err.message);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ═══════════════════════════════════════════════════════════ */
/*  TRAY ACTIONS                                              */
/* ═══════════════════════════════════════════════════════════ */

function jumpToNote(noteId) {
  // Show the note in the frontmost window; spawn a new one if none exist.
  const focused = BrowserWindow.getFocusedWindow();
  let targetWinId = null;
  if (focused) {
    for (const [id, win] of windows) {
      if (win === focused) {
        targetWinId = id;
        break;
      }
    }
  }
  if (!targetWinId && windows.size > 0) {
    targetWinId = windows.keys().next().value;
  }
  if (!targetWinId) {
    spawnNewWindow({ initialNote: noteId });
    return;
  }

  const all = getWindowsState();
  const w = all.find((x) => x.id === targetWinId);
  if (w) {
    w.noteId = noteId;
    saveWindowsState(all);
    const bw = windows.get(targetWinId);
    if (bw && !bw.isDestroyed()) {
      if (!bw.isVisible()) bw.show();
      bw.focus();
      bw.webContents.send("notes:jump-to", noteId);
    }
  }
}

/* ═══════════════════════════════════════════════════════════ */
/*  APP LIFECYCLE                                             */
/* ═══════════════════════════════════════════════════════════ */

// Links in notes open in the default browser. Without this, window.open and
// navigation load remote pages inside an Electron window that inherits the
// preload, so any page could call saveNotes() and overwrite every note.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("data:") || (isDev && url.startsWith("http://localhost:3800"))) return;
    if (url.startsWith("app://")) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
});

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  // Image storage directory
  const imagesDir = vault.imagesDir;
  vault.adoptImages(path.join(app.getPath("userData"), "images"));

  // Custom protocol: qn-image://filename.png → local file
  protocol.handle("qn-image", (request) => {
    // basename only: qn-image://../../etc/passwd must not escape the folder
    const filename = path.basename(decodeURIComponent(request.url.replace("qn-image://", "")));
    return net.fetch("file://" + path.join(imagesDir, filename));
  });

  migrateLegacyIfNeeded();

  // One-time lift of the notes that used to live inside electron-store's
  // config.json. The config is snapshotted into the vault's backup/ folder
  // first, and its `notes` key is never written again or removed.
  const moved = vault.migrateFrom(
    store.get("notes"),
    path.join(app.getPath("userData"), "config.json"),
  );
  if (moved) {
    console.log(`[quick-notes] migrated ${moved} notes into ${vault.vault}`);
  }

  createTray();

  // Sanitize stored windows: drop any with dead or missing noteId refs.
  const allNotes = vault.list();
  const noteIdSet = new Set(allNotes.map((n) => n.id));
  const rawSaved = getWindowsState();
  const savedWindows = rawSaved.filter((w) => w.noteId && noteIdSet.has(w.noteId));

  if (savedWindows.length !== rawSaved.length) {
    saveWindowsState(savedWindows);
  }

  if (savedWindows.length === 0) {
    spawnNewWindow({});
  } else {
    for (const winState of savedWindows) {
      createNotesWindow(winState);
    }
  }

  const launchAtStartup = store.get("launchAtStartup", false);
  app.setLoginItemSettings({ openAtLogin: launchAtStartup });

  if (!registerShortcut(store.get("shortcut"))) {
    console.log(`[quick-notes] could not register ${store.get("shortcut")}`);
  }

  startAutoUpdates();
});

// Packaged builds check GitHub releases on launch and every six hours. An
// update downloads in the background and installs the next time the app quits,
// so a note is never interrupted mid-sentence.
function startAutoUpdates() {
  if (isDev) return;
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (err) => console.log("[quick-notes] update check failed:", err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.on("window-all-closed", () => {
  // No-op — tray keeps the process alive
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

/* ═══════════════════════════════════════════════════════════ */
/*  IPC HANDLERS                                              */
/* ═══════════════════════════════════════════════════════════ */

ipcMain.handle("notes:load", () => {
  return vault.list();
});

ipcMain.handle("notes:save", (event, notes) => {
  vault.saveAll(notes);
  buildTrayMenu();
  const senderId = windowIdFromSender(event);
  broadcastNotesUpdated(senderId);
});

ipcMain.handle("notes:export", (event) => {
  return exportAllNotes(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle("notes:import", (event) => {
  return importNotes(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.handle("window:getState", (event) => {
  const id = windowIdFromSender(event);
  if (!id) return null;
  return getWindowsState().find((w) => w.id === id) || null;
});

ipcMain.handle("window:setState", (event, partial) => {
  const id = windowIdFromSender(event);
  if (!id) return null;
  const all = getWindowsState();
  const idx = all.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...partial };
  saveWindowsState(all);
  return all[idx];
});

ipcMain.handle("window:spawn", (_event, opts) => {
  return spawnNewWindow(opts || {});
});

ipcMain.handle("window:close", (event) => {
  const id = windowIdFromSender(event);
  if (id) closeWindowById(id);
});

ipcMain.handle("window:setPosition", (event, pos) => {
  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw || bw.isDestroyed()) return;
  if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return;
  bw.setPosition(Math.round(pos.x), Math.round(pos.y), false);
});

ipcMain.on("window:moveBy", (event, delta) => {
  const bw = BrowserWindow.fromWebContents(event.sender);
  if (!bw || bw.isDestroyed()) return;
  if (!delta || typeof delta.dx !== "number" || typeof delta.dy !== "number") return;
  const [x, y] = bw.getPosition();
  bw.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy), false);
});

ipcMain.handle("window:getCursorPoint", () => {
  return screen.getCursorScreenPoint();
});

ipcMain.handle("window:getBounds", (event) => {
  const bw = BrowserWindow.fromWebContents(event.sender);
  return bw ? bw.getBounds() : null;
});

ipcMain.handle("image:save", (_event, dataUrl) => {
  const match = dataUrl.match(/^data:image\/([\w+]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data");
  const rawExt = match[1].replace("+xml", "");
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  const buffer = Buffer.from(match[2], "base64");
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const imagesDir = vault.imagesDir;
  fs.writeFileSync(path.join(imagesDir, filename), buffer);
  return `qn-image://${filename}`;
});

ipcMain.on("notes:changed", () => {
  buildTrayMenu();
});

ipcMain.handle("image:open", (_event, src) => {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const w = Math.round(width * 0.6);
  const h = Math.round(height * 0.6);

  const win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 300,
    minHeight: 200,
    frame: false,
    titleBarStyle: "hiddenInset",
    // centred in the 38px title bar: (38 - 12) / 2
    trafficLightPosition: { x: 13, y: 13 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#191919",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const escaped = String(src).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #191919; user-select: none; }
  .titlebar {
    -webkit-app-region: drag;
    position: fixed; top: 0; left: 0; right: 0; z-index: 10;
    height: 40px; display: flex; align-items: center; justify-content: center;
    background: rgba(25,25,25,0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    padding: 0 52px;
  }
  .titlebar span {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; font-weight: 600;
    color: rgba(255,255,255,0.5);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .viewer {
    position: absolute; top: 40px; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  img { max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: 0 0; cursor: grab; transition: none; }
  img.grabbing { cursor: grabbing; }
</style></head><body>
<div class="titlebar"><span>Image Preview</span></div>
<div class="viewer" id="v"><img id="img" src="${escaped}" draggable="false" /></div>
<script>
  var img = document.getElementById('img');
  var viewer = document.getElementById('v');
  var scale = 1, tx = 0, ty = 0;
  var dragging = false, lastX = 0, lastY = 0;

  function apply() {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }

  function resetView() {
    scale = 1; tx = 0; ty = 0;
    img.style.transformOrigin = '0 0';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.transform = 'none';
  }

  function enterFreeMode() {
    if (scale === 1 && img.style.maxWidth === '100%') {
      var rect = img.getBoundingClientRect();
      tx = rect.left; ty = rect.top;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
    }
  }

  viewer.addEventListener('wheel', function(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      enterFreeMode();
      var factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      var next = scale * factor;
      if (next < 0.1) next = 0.1;
      if (next > 20) next = 20;
      var rect = viewer.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      tx = mx - (mx - tx) * (next / scale);
      ty = my - (my - ty) * (next / scale);
      scale = next;
    } else {
      if (scale > 1) {
        enterFreeMode();
        tx -= e.deltaX;
        ty -= e.deltaY;
      }
    }
    apply();
  }, { passive: false });

  img.addEventListener('pointerdown', function(e) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    img.classList.add('grabbing');
    img.setPointerCapture(e.pointerId);
  });
  img.addEventListener('pointermove', function(e) {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    apply();
  });
  img.addEventListener('pointerup', function(e) {
    dragging = false;
    img.classList.remove('grabbing');
    img.releasePointerCapture(e.pointerId);
  });

  viewer.addEventListener('dblclick', function() { resetView(); });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.close();
  });
</script></body></html>`;

  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => win.show());
});
