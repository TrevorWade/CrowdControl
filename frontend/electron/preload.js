const { contextBridge, ipcRenderer } = require('electron');

// Securely expose limited APIs to the renderer for photo mapping operations.
contextBridge.exposeInMainWorld('photoMap', {
  createGameFolder: (gameName) => ipcRenderer.invoke('photoMap:createGameFolder', gameName),
  openFolder: (folderPath) => ipcRenderer.invoke('photoMap:openFolder', folderPath),
  getBaseDir: () => ipcRenderer.invoke('photoMap:getBaseDir'),
  listProfiles: () => ipcRenderer.invoke('photoMap:listProfiles'),
  getActiveProfile: () => ipcRenderer.invoke('photoMap:getActiveProfile'),
  setActiveProfile: (gameName) => ipcRenderer.invoke('photoMap:setActiveProfile', gameName),
  selectImage: () => ipcRenderer.invoke('photoMap:selectImage'),
  saveMapping: (gameName, map) => ipcRenderer.invoke('photoMap:saveMapping', { gameName, map }),
  loadMapping: (gameName) => ipcRenderer.invoke('photoMap:loadMapping', gameName),
  // Read a local image file as a data URL for safe rendering when dev server origin blocks file://
  readFileAsDataUrl: (absPath) => ipcRenderer.invoke('photoMap:readFileDataUrl', absPath),
  // Open the overlay in a separate window
  openOverlayWindow: () => ipcRenderer.invoke('overlay:open'),
});


// Windows-only window enumeration and focus watch (no-op gracefully on other OSes)
contextBridge.exposeInMainWorld('windowsAPI', {
  /**
   * Returns an array of { hwnd, title, appName, processId, exePath, iconDataUrl? } on Windows.
   * Returns [] on other platforms or on error.
   */
  list: async () => {
    try {
      return (await ipcRenderer.invoke('windows:list')) || [];
    } catch {
      return [];
    }
  },
  /**
   * Start watching focus for a specific hwnd. Returns an unsubscribe function.
   * The callback receives { hwnd, isFocused } events.
   * No-op on non-Windows.
   */
  watchFocus: (hwnd, cb) => {
    try {
      const listener = (_e, payload) => {
        try { cb && cb(payload); } catch {}
      };
      ipcRenderer.on('windows:focus', listener);
      ipcRenderer.send('windows:watchFocus', Number(hwnd));
      return () => {
        try { ipcRenderer.removeListener('windows:focus', listener); } catch {}
        try { ipcRenderer.send('windows:stopWatchFocus'); } catch {}
      };
    } catch {
      // Fallback unsubscribe
      return () => {};
    }
  },
});

