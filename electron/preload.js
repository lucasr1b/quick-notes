const { contextBridge, ipcRenderer } = require("electron");

function getWindowIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("winId");
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld("electronAPI", {
  // Notes persistence
  loadNotes: () => ipcRenderer.invoke("notes:load"),
  saveNotes: (notes) => ipcRenderer.invoke("notes:save", notes),

  // Per-window state
  getWindowId: () => getWindowIdFromUrl(),
  getWindowState: () => ipcRenderer.invoke("window:getState"),
  setWindowState: (partial) => ipcRenderer.invoke("window:setState", partial),
  spawnWindow: (opts) => ipcRenderer.invoke("window:spawn", opts),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  setWindowPosition: (pos) => ipcRenderer.invoke("window:setPosition", pos),
  moveWindowBy: (delta) => ipcRenderer.send("window:moveBy", delta),
  getCursorPoint: () => ipcRenderer.invoke("window:getCursorPoint"),
  getWindowBounds: () => ipcRenderer.invoke("window:getBounds"),

  // Legacy alias (kept so older renderer code still compiles)
  closeNotesWindow: () => ipcRenderer.invoke("window:close"),

  // Tray → renderer events
  onNoteCreated: (callback) => {
    const handler = (_event, noteId) => callback(noteId);
    ipcRenderer.on("notes:created", handler);
    return () => ipcRenderer.removeListener("notes:created", handler);
  },
  onJumpToNote: (callback) => {
    const handler = (_event, noteId) => callback(noteId);
    ipcRenderer.on("notes:jump-to", handler);
    return () => ipcRenderer.removeListener("notes:jump-to", handler);
  },
  onNotesUpdated: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("notes:updated", handler);
    return () => ipcRenderer.removeListener("notes:updated", handler);
  },

  // Images
  saveImage: (dataUrl) => ipcRenderer.invoke("image:save", dataUrl),
  openImage: (src) => ipcRenderer.invoke("image:open", src),

  // Renderer → main notifications
  notifyNotesChanged: () => ipcRenderer.send("notes:changed"),
});
