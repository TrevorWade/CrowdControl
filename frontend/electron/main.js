const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const { execFile } = require('child_process');
// Optional: window enumeration (Windows-only usage). Keep import resilient.
let windowManager = null;
try {
  ({ windowManager } = require('node-window-manager'));
} catch {}

// Keep a global reference of the window object
// If you don't, the window will be closed automatically when the JavaScript object is garbage collected
let mainWindow;
let overlayWindow = null;
// Track focus watch state to avoid multiple concurrent intervals
let _focusWatchTimer = null;
let _focusWatchTargetHwnd = null;

function startBackend() {
  const port = Number(process.env.WS_PORT || 5178);
  const tester = net.createServer();

  const start = () => {
    try {
      const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
      const backendEntry = isDev
        ? path.join(__dirname, '../../backend/index.js')
        : path.join(process.resourcesPath, 'backend', 'index.js');
      require(backendEntry);
      console.log('Backend started from:', backendEntry);
    } catch (err) {
      console.error('Failed to start backend:', err);
    }
  };

  tester.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log(`Backend port ${port} already in use. Skipping backend start.`);
    } else {
      console.warn('Port check error; attempting to start backend anyway:', err?.message || err);
      start();
    }
  });

  tester.once('listening', () => {
    tester.close(() => start());
  });

  try {
    tester.listen(port, '0.0.0.0');
  } catch (e) {
    console.warn('Immediate port listen failed; attempting to start backend anyway:', e.message);
    start();
  }
}

/**
 * Windows window listing and focus watch helpers.
 * These are guarded by process.platform === 'win32' and optional module availability.
 */
async function listWindowsWin32() {
  // Guard: platform/module
  if (process.platform !== 'win32') {
    return [];
  }
  if (!windowManager) {
    try { console.warn('[windows] node-window-manager not available; falling back to PowerShell'); } catch {}
    const psItems = await listWindowsViaPowerShell();
    return await groupAttachAndSort(psItems);
  }

  // Enumerate ALL top-level windows; do minimal filtering only for safety
  let raw = [];
  try {
    raw = windowManager.getWindows() || [];
  } catch {
    raw = [];
  }

  const shaped = raw.map((w) => {
    let title = '';
    try { title = w.getTitle() || ''; } catch {}
    let owner = null;
    try { owner = w.getOwner(); } catch {}
    let pid = 0;
    try { pid = Number(w.getProcessId() || 0); } catch {}

    // Fallbacks to ensure every item is presentable
    const appName = owner && owner.name ? String(owner.name) : '';
    const usedTitle = title || appName || 'Untitled window';
    const exePath = owner && owner.path ? String(owner.path) : '';

    return {
      hwnd: w && typeof w.handle !== 'undefined' ? Number(w.handle) : 0,
      title: usedTitle,
      appName,
      processId: pid,
      exePath,
    };
  });

  // Process native items, falling back to PowerShell if needed
  let results = await groupAttachAndSort(shaped);
  if (!results || results.length === 0) {
    const psItems = await listWindowsViaPowerShell();
    results = await groupAttachAndSort(psItems);
  }
  return results;
}

/**
 * Fallback enumerator using PowerShell to list processes with visible main windows.
 */
function listWindowsViaPowerShell() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const ps = 'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ' +
      'Select-Object Id,ProcessName,MainWindowTitle,Path,MainWindowHandle | ConvertTo-Json -Depth 3';
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        try { console.warn('[windows] PowerShell enumeration failed', err && err.message); } catch {}
        return resolve([]);
      }
      try {
        const parsed = JSON.parse(stdout);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const items = arr.map((p) => ({
          hwnd: Number(p.MainWindowHandle || 0),
          title: String(p.MainWindowTitle || '').trim() || String(p.ProcessName || ''),
          appName: String(p.ProcessName || ''),
          processId: Number(p.Id || 0),
          exePath: String(p.Path || ''),
        })).filter((x) => x && x.hwnd && x.hwnd > 0);
        resolve(items);
      } catch (e) {
        try { console.warn('[windows] PowerShell JSON parse failed', e && e.message); } catch {}
        resolve([]);
      }
    });
  });
}

/**
 * Apply blacklist/filter, group by executable, attach icons best-effort, and sort.
 */
async function groupAttachAndSort(items) {
  // Basic blacklist of noisy system helpers not useful to users
  const blacklist = new Set([
    'Microsoft Text Input Application',
    'Program Manager',
  ]);

  // Filter out items without a valid handle or app name in blacklist
  const filtered = (items || []).filter((x) => {
    if (!x || !x.hwnd || x.hwnd <= 0) return false;
    if (x.appName && blacklist.has(x.appName)) return false;
    return true;
  });

  // Group by executable path to present one entry per app (like Chrome, Cursor, Spotify)
  const byExe = new Map();
  for (const x of filtered) {
    const key = x.exePath || `${x.appName}:${x.processId}`;
    const prev = byExe.get(key);
    if (!prev) {
      byExe.set(key, x);
    } else {
      // Prefer one with a non-generic title (longer)
      const prevLen = (prev.title || '').length;
      const curLen = (x.title || '').length;
      if (curLen > prevLen) byExe.set(key, x);
    }
  }

  // Attach icons best-effort; do not block on failures
  const results = [];
  for (const x of byExe.values()) {
    let iconDataUrl;
    if (x.exePath) {
      try {
        const icon = await app.getFileIcon(x.exePath, { size: 'small' });
        if (icon && typeof icon.toDataURL === 'function') {
          iconDataUrl = icon.toDataURL();
        }
      } catch {}
    }
    results.push({ ...x, iconDataUrl });
  }

  // Sort nicely by appName then title
  results.sort((a, b) => {
    const an = (a.appName || '').toLowerCase();
    const bn = (b.appName || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    const at = (a.title || '').toLowerCase();
    const bt = (b.title || '').toLowerCase();
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  return results;
}

function getActiveHwndWin32() {
  if (process.platform !== 'win32' || !windowManager) return undefined;
  try {
    const active = windowManager.getActiveWindow();
    return active ? active.handle : undefined;
  } catch {
    return undefined;
  }
}

function startFocusWatchWin32(targetHwnd, onChange) {
  stopFocusWatchWin32();
  if (process.platform !== 'win32' || !windowManager) return;
  _focusWatchTargetHwnd = Number(targetHwnd);
  let last;
  _focusWatchTimer = setInterval(() => {
    let isFocused = false;
    try { isFocused = getActiveHwndWin32() === _focusWatchTargetHwnd; } catch { isFocused = false; }
    if (isFocused !== last) {
      last = isFocused;
      try { onChange(Boolean(isFocused)); } catch {}
    }
  }, 800);
}

function stopFocusWatchWin32() {
  if (_focusWatchTimer) {
    clearInterval(_focusWatchTimer);
    _focusWatchTimer = null;
  }
  _focusWatchTargetHwnd = null;
}

function createWindow() {
  // Create the browser window with modern settings
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'assets/icon.ico'), // Your custom icon
    webPreferences: {
      nodeIntegration: false, // Security: don't allow Node.js in renderer
      contextIsolation: true, // Security: isolate context
      enableRemoteModule: false, // Security: disable remote module
      webSecurity: true, // Security: enable web security
      allowRunningInsecureContent: false, // Security: don't allow insecure content
      preload: path.join(__dirname, 'preload.js')
    },
    // Modern window appearance
    titleBarStyle: 'default',
    show: false, // Don't show until ready
    backgroundColor: '#ffffff' // Set background color to prevent white flash
  });

  // Load your app based on environment
  // In development, always load from Vite dev server
  // In production, load from built files
  const devServerUrl = 'http://localhost:5173';
  const loadProduction = () => {
    const indexPath = path.join(__dirname, '../dist/index.html');
    console.log('Loading from:', indexPath);
    mainWindow.loadFile(indexPath);
  };

  if (!app.isPackaged) {
    // Try dev server first; if it fails, fall back to built files
    mainWindow.webContents.once('did-fail-load', () => {
      console.warn('Dev server not available. Falling back to built files.');
      loadProduction();
    });
    mainWindow.loadURL(devServerUrl).catch(() => {
      // Safety: in case promise rejects before did-fail-load fires
      loadProduction();
    });
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    loadProduction();
  }

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window closed event
  mainWindow.on('closed', () => {
    // Dereference the window object
    mainWindow = null;
  });

  // Handle external links (open in default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// This method will be called when Electron has finished initialization
// and is ready to create browser windows
app.whenReady().then(() => {
  startBackend();
  createWindow();
  // Register photo mapping IPC handlers
  registerPhotoMapIpc();
  // Register Windows window enumeration and focus watcher IPC (safe on other OSes)
  registerWindowsIpc();
  try {
    autoUpdater.autoDownload = false; // manual download via menu

    autoUpdater.on('update-available', () => {
      const response = dialog.showMessageBoxSync({
        type: 'info',
        buttons: ['Download', 'Cancel'],
        title: 'Update available',
        message: 'A new version is available. Download now?'
      });
      if (response === 0) {
        autoUpdater.downloadUpdate();
      }
    });

    autoUpdater.on('update-downloaded', () => {
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Restart now', 'Later'],
        title: 'Update ready',
        message: 'A new version has been downloaded. Restart to apply?',
        defaultId: 0,
        cancelId: 1
      });
      if (choice === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  } catch (e) {
    console.error('Auto-update initialization failed:', e);
  }

  // Application menu with Check for Updates
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Check for Updates',
          click: async () => {
            try {
              const result = await autoUpdater.checkForUpdates();
              if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                dialog.showMessageBox({
                  type: 'info',
                  message: 'You are on the latest version.'
                });
              }
            } catch (err) {
              dialog.showMessageBox({
                type: 'error',
                message: 'Failed to check for updates. Please try again later.'
              });
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  // On macOS it's common for applications to stay open even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS it's common to re-create a window when the dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

  // Security: prevent new window creation
  app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (event, navigationUrl) => {
      event.preventDefault();
      shell.openExternal(navigationUrl);
    });
  });

// Handle app ready state
app.on('ready', () => {
  console.log('CrowdControl is ready!');
});

/**
 * IPC for window listing and focus watching (Windows-only behavior).
 * Returns empty/no-op on non-Windows to keep app portable.
 */
function registerWindowsIpc() {
  // List open top-level windows
  ipcMain.handle('windows:list', async () => {
    if (process.platform !== 'win32') return [];
    return await listWindowsWin32();
  });

  // Start focus watcher for a specific hwnd; emits 'windows:focus' events
  ipcMain.on('windows:watchFocus', (e, hwnd) => {
    if (process.platform !== 'win32') return;
    startFocusWatchWin32(Number(hwnd), (isFocused) => {
      try {
        e.sender.send('windows:focus', { hwnd: Number(hwnd), isFocused: Boolean(isFocused) });
      } catch {}
    });
  });

  // Stop focus watcher
  ipcMain.on('windows:stopWatchFocus', () => {
    stopFocusWatchWin32();
  });
}

// IPC implementation for photo mapping operations
function registerPhotoMapIpc() {
  // Ensure per-game folder under userData/photos/<GameName>
  ipcMain.handle('photoMap:createGameFolder', async (event, gameName) => {
    const safeName = sanitizeGameName(gameName);
    const base = getPhotosBaseDir();
    const folder = path.join(base, safeName);
    await fsp.mkdir(folder, { recursive: true });
    console.log('[photoMap] ensure folder:', folder);
    return folder;
  });

  // Open folder in system file explorer
  ipcMain.handle('photoMap:openFolder', async (event, folderPath) => {
    if (!folderPath) throw new Error('No folder path provided');
    await shell.openPath(folderPath);
    return true;
  });

  // Return absolute photos base directory used by the app
  ipcMain.handle('photoMap:getBaseDir', async () => {
    return getPhotosBaseDir();
  });

  // List available profiles (folders) under the photos base
  ipcMain.handle('photoMap:listProfiles', async () => {
    const base = getPhotosBaseDir();
    try {
      const entries = await fsp.readdir(base, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => !name.startsWith('_'));
    } catch (e) {
      // If directory doesn't exist yet, return empty list
      return [];
    }
  });

  // Persist and retrieve active profile name across sessions
  ipcMain.handle('photoMap:getActiveProfile', async () => {
    const state = await readProfilesState();
    return state.active || 'default';
  });

  ipcMain.handle('photoMap:setActiveProfile', async (event, gameName) => {
    const safe = sanitizeGameName(gameName);
    await writeProfilesState({ active: safe });
    return safe;
  });

  // Show image file picker and return selected absolute path
  ipcMain.handle('photoMap:selectImage', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      ],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // Save mapping JSON to <userData>/photos/<GameName>/photo-map.json
  ipcMain.handle('photoMap:saveMapping', async (event, payload) => {
    const { gameName, map } = payload || {};
    const safeName = sanitizeGameName(gameName);
    const dir = path.join(getPhotosBaseDir(), safeName);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'photo-map.json');
    const json = JSON.stringify({ gameName: safeName, keys: map || {} }, null, 2);
    await fsp.writeFile(file, json, 'utf-8');
    console.log('[photoMap] saved mapping:', file);
    return file;
  });

  // Load mapping JSON from <userData>/photos/<GameName>/photo-map.json
  ipcMain.handle('photoMap:loadMapping', async (event, gameName) => {
    const safeName = sanitizeGameName(gameName);
    const file = path.join(getPhotosBaseDir(), safeName, 'photo-map.json');
    try {
      const buf = await fsp.readFile(file, 'utf-8');
      const data = JSON.parse(buf);
      return (data && data.keys) || {};
    } catch (e) {
      // If file not found, return empty mapping
      console.warn('[photoMap] load mapping not found, returning empty:', file);
      return {};
    }
  });

  // Utility: read an image file and return a data URL (base64)
  ipcMain.handle('photoMap:readFileDataUrl', async (event, absPath) => {
    try {
      if (!absPath) throw new Error('No path provided');
      const buf = await fsp.readFile(String(absPath));
      // Best-effort mime detection by extension
      const ext = String(absPath).toLowerCase();
      const mime = ext.endsWith('.png') ? 'image/png'
        : ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg'
        : ext.endsWith('.gif') ? 'image/gif'
        : ext.endsWith('.webp') ? 'image/webp'
        : 'application/octet-stream';
      const b64 = buf.toString('base64');
      return `data:${mime};base64,${b64}`;
    } catch (e) {
      console.warn('[photoMap] readFileDataUrl failed:', e.message);
      return null;
    }
  });

  // Open overlay window on demand
  ipcMain.handle('overlay:open', async () => {
    createOverlayWindow();
    return true;
  });
}

function sanitizeGameName(name) {
  const raw = String(name || '').trim();
  // Replace characters illegal in Windows/macOS/Linux paths with '_'
  return raw.replace(/[\\/:*?"<>|]/g, '_') || 'default';
}

// Create a frameless overlay window that stays on top
function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus();
    return overlayWindow;
  }
  overlayWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    fullscreenable: false,
    resizable: true,
    movable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Only show once content is ready to avoid white flash
  const reveal = () => { try { if (!overlayWindow.isDestroyed()) overlayWindow.show(); } catch {} };
  overlayWindow.once('ready-to-show', reveal);
  overlayWindow.webContents.once('did-finish-load', reveal);

  // Make overlay yield to other windows when it loses focus
  overlayWindow.on('blur', () => {
    try { overlayWindow.setAlwaysOnTop(false); } catch {}
  });
  overlayWindow.on('focus', () => {
    try { overlayWindow.setAlwaysOnTop(true); } catch {}
  });

  // In dev, try Vite server first and gracefully fall back to built files
  const loadOverlayProduction = () => {
    const indexPath = path.join(__dirname, '../dist/index.html');
    overlayWindow.loadFile(indexPath, { hash: 'overlay' });
  };

  if (!app.isPackaged) {
    const devServerUrl = 'http://localhost:5173#overlay';
    overlayWindow.webContents.once('did-fail-load', () => {
      try { console.warn('Overlay dev server not available. Falling back to built files.'); } catch {}
      loadOverlayProduction();
    });
    overlayWindow.loadURL(devServerUrl).catch(() => {
      // Safety: in case the promise rejects before did-fail-load fires
      loadOverlayProduction();
    });
  } else {
    loadOverlayProduction();
  }

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  return overlayWindow;
}

function getPhotosBaseDir() {
  // Preferred: <repo>/photos where <repo> is the ttl_rl root
  const candidates = uniquePaths([
    process.cwd(),
    __dirname,
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
  ]);

  const repoRoot = findRepoRoot(candidates);
  if (repoRoot) {
    const photos = path.join(repoRoot, 'photos');
    return photos;
  }

  // Fallback: userData/photos when repo root cannot be determined (e.g., packaged build)
  return path.join(app.getPath('userData'), 'photos');
}

function findRepoRoot(starts) {
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      try {
        // Heuristics for repo root: has package.json AND a frontend folder
        const pkg = path.join(dir, 'package.json');
        const fe = path.join(dir, 'frontend');
        if (fs.existsSync(pkg) && fs.existsSync(fe)) {
          return dir;
        }
      } catch {}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function uniquePaths(pathsArr) {
  const seen = new Set();
  const out = [];
  for (const p of pathsArr) {
    const key = path.resolve(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// Profiles state helpers (stored at <base>/_profiles.json)
function getProfilesFilePath() {
  return path.join(getPhotosBaseDir(), '_profiles.json');
}

async function readProfilesState() {
  const file = getProfilesFilePath();
  try {
    const buf = await fsp.readFile(file, 'utf-8');
    return JSON.parse(buf) || {};
  } catch {
    return {};
  }
}

async function writeProfilesState(state) {
  const file = getProfilesFilePath();
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const data = JSON.stringify({ active: state && state.active ? String(state.active) : 'default' }, null, 2);
  await fsp.writeFile(file, data, 'utf-8');
  return true;
}
