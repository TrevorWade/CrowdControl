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
// WS authentication token — populated once the backend module is required.
// Falls back to WS_TOKEN env var for the edge-case where the backend was
// started externally (port already in use) and the same env var was set there.
let _wsToken = (process.env.WS_TOKEN && process.env.WS_TOKEN.trim()) ? process.env.WS_TOKEN.trim() : null;

function startBackend() {
  const port = Number(process.env.WS_PORT || 5178);
  const tester = net.createServer();

  const start = () => {
    try {
      const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
      const backendEntry = isDev
        ? path.join(__dirname, '../../backend/index.js')
        : path.join(process.resourcesPath, 'backend', 'index.js');
      const backendModule = require(backendEntry);
      // Capture the WS auth token exported by the backend module so we can
      // forward it to the renderer via secure IPC (auth:getWsToken).
      if (backendModule && typeof backendModule.WS_TOKEN === 'string') {
        _wsToken = backendModule.WS_TOKEN;
        console.log('[Auth] WS token acquired from backend module');
      }
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
  // In development, prefer the port from env, otherwise default to 5173.
  const vitePort = process.env.VITE_PORT || '5173';
  const devServerUrl = `http://localhost:${vitePort}`;
  console.log(`[Electron] Development mode: loading from ${devServerUrl}`);
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

  // Handle external links (open in default browser).
  // Security: only allow http / https URLs to reach the OS shell.
  // Any other scheme (javascript:, file:, data:, …) is silently denied.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      } else {
        console.warn(`[Security] Blocked shell.openExternal for disallowed protocol: ${parsed.protocol} (url: ${url})`);
      }
    } catch (e) {
      console.warn(`[Security] Blocked shell.openExternal for unparseable URL: ${url}`);
    }
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
  // Expose the WS auth token to the renderer over a secure, sandboxed IPC channel.
  // The preload script forwards this to window.electronAuth.getWsToken().
  ipcMain.handle('auth:getWsToken', () => _wsToken);
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

  // Register TikTok Login IPC handler
  registerTikTokIpc();
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

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      
      // Senior Dev Fix: Allow OAuth popups for Google/Apple/TikTok login flows
      // These usually need a new window to complete the authentication
      const isAuthPopup = [
        'accounts.google.com',
        'appleid.apple.com',
        'www.tiktok.com'
      ].some(domain => parsed.hostname.includes(domain));

      if (isAuthPopup) {
        // Allow the window to open as a popup within Electron
        return { action: 'allow', overrideBrowserWindowOptions: {
          width: 500,
          height: 600,
          autoHideMenuBar: true,
        }};
      }

      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      } else {
        console.warn(`[Security] Blocked shell.openExternal (web-contents-created) for disallowed protocol: ${parsed.protocol} (url: ${url})`);
      }
    } catch (e) {
      console.warn(`[Security] Blocked shell.openExternal (web-contents-created) for unparseable URL: ${url}`);
    }
    return { action: 'deny' };
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

/**
 * Path-containment guard (H-4 / H-5 fix).
 *
 * Resolves `target` to an absolute path and asserts that it starts with
 * `base` followed by the platform separator.  Throws a descriptive Error
 * on failure so IPC handlers can catch it and return null / {} safely.
 *
 * @param {string} target - The path to validate (may be relative or absolute).
 * @param {string} base   - The root that target must reside under.
 */
function assertUnderBaseDir(target, base) {
  const resolvedTarget = path.resolve(target);
  const resolvedBase   = path.resolve(base);
  // Ensure comparison is case-insensitive on Windows
  const normalTarget = resolvedTarget.toLowerCase();
  const normalBase   = resolvedBase.toLowerCase();
  // The target must start with base + sep to avoid sibling-directory bypass
  // (e.g. /photos-extra would start with /photos but isn't /photos/).
  if (!normalTarget.startsWith(normalBase + path.sep) && normalTarget !== normalBase) {
    throw new Error(
      `[Security] Path traversal blocked: "${resolvedTarget}" is not inside "${resolvedBase}"`
    );
  }
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
    const base = getPhotosBaseDir();
    const dir = path.join(base, safeName);
    // Path-containment guard: ensure the resolved directory is inside base
    assertUnderBaseDir(dir, base);
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
    const base = getPhotosBaseDir();
    const file = path.join(base, safeName, 'photo-map.json');
    // Path-containment guard
    assertUnderBaseDir(file, base);
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

  // Utility: read an image file and return a data URL (base64).
  // Security (H-4): resolve the caller-supplied path and assert it lives
  // inside getPhotosBaseDir() before doing any filesystem I/O.
  ipcMain.handle('photoMap:readFileDataUrl', async (event, absPath) => {
    try {
      if (!absPath) throw new Error('No path provided');
      const resolved = path.resolve(String(absPath));
      const base = getPhotosBaseDir();
      assertUnderBaseDir(resolved, base);
      const buf = await fsp.readFile(resolved);
      // Best-effort mime detection by extension
      const ext = resolved.toLowerCase();
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

  // Step 1 — Replace characters illegal in Windows/macOS/Linux paths with '_'
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_');

  // Step 2 — Split on any path separator (/ or \) and take the last segment.
  //           This drops any leading directory components a caller may have
  //           smuggled in (e.g. "../../AppData/Roaming/evil" → "evil" after
  //           character replacement would still have traversal intent).
  const segments = cleaned.split(/[\\/]+/);
  const lastSegment = segments[segments.length - 1] || '';

  // Step 3 — Reject '..' outright (after replacement it would appear as '__'
  //           but guard the pre-replacement form too for belt-and-suspenders).
  if (!lastSegment || lastSegment === '..' || raw.split(/[\\/]+/).some((s) => s === '..')) {
    console.warn(`[Security] sanitizeGameName rejected traversal attempt: "${raw}"`);
    return 'default';
  }

  return lastSegment || 'default';
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

  // Security: block any attempt by overlay renderer to open a new browser window.
  // Use the same http/https-only allowlist as mainWindow.
  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      } else {
        console.warn(`[Security] Blocked shell.openExternal (overlay) for disallowed protocol: ${parsed.protocol} (url: ${url})`);
      }
    } catch (e) {
      console.warn(`[Security] Blocked shell.openExternal (overlay) for unparseable URL: ${url}`);
    }
    return { action: 'deny' };
  });

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
/**
 * TikTok Login and Session Management
 */
function registerTikTokIpc() {
  ipcMain.handle('tiktok:startLogin', async () => {
    const { session } = require('electron');
    const loginWin = new BrowserWindow({
      width: 500,
      height: 800,
      title: 'TikTok Login',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:tiktok_login',
        // Enable essential features for OAuth flows
        domStorageEnabled: true,
        databaseEnabled: true,
      }
    });

    // Set a modern Chrome User-Agent to avoid Google/TikTok security blocks
    // Google OAuth often blocks the default Electron User-Agent
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
    loginWin.webContents.setUserAgent(userAgent);

    loginWin.loadURL('https://www.tiktok.com/login', { userAgent });

    return new Promise((resolve) => {
      let isResolved = false;

      const poll = setInterval(async () => {
        if (loginWin.isDestroyed()) {
          clearInterval(poll);
          if (!isResolved) {
            isResolved = true;
            resolve({ success: false, error: 'Window closed before login' });
          }
          return;
        }

        try {
          // TikTok session requires both 'sessionid' and 'tt-target-idc'
          // Extract both to satisfy the tiktok-live-connector requirements
          const cookies = await loginWin.webContents.session.cookies.get({
            url: 'https://www.tiktok.com'
          });

          const sid = cookies.find(c => c.name === 'sessionid')?.value;
          const idc = cookies.find(c => c.name === 'tt-target-idc')?.value;

          if (sid && idc) {
            console.log('[TikTok] sessionid and idc detected!');
            clearInterval(poll);
            
            await persistTikTokSession(sid, idc);
            
            isResolved = true;
            loginWin.close();
            resolve({ success: true, sessionId: sid });
          }
        } catch (err) {
          console.error('[TikTok] Cookie polling error:', err);
        }
      }, 2000);

      loginWin.on('closed', () => {
        clearInterval(poll);
        if (!isResolved) {
          isResolved = true;
          resolve({ success: false, error: 'Login window closed' });
        }
      });
    });
  });
}

async function persistTikTokSession(sessionId, targetIdc) {
  try {
    const repoRoot = findRepoRoot([__dirname, path.join(__dirname, '..'), path.join(__dirname, '..', '..')]);
    if (!repoRoot) {
      console.warn('[TikTok] Repo root not found, cannot persist to .env');
      process.env.TIKTOK_SESSION_ID = sessionId;
      process.env.TIKTOK_TARGET_IDC = targetIdc;
      return;
    }

    const envPath = path.join(repoRoot, 'backend', '.env');
    let content = '';
    try {
      if (fs.existsSync(envPath)) {
        content = await fsp.readFile(envPath, 'utf8');
      }
    } catch (e) {}

    let lines = content.split('\n');
    let sidFound = false;
    let idcFound = false;

    lines = lines.map(line => {
      if (line.startsWith('TIKTOK_SESSION_ID=')) {
        sidFound = true;
        return `TIKTOK_SESSION_ID=${sessionId}`;
      }
      if (line.startsWith('TIKTOK_TARGET_IDC=')) {
        idcFound = true;
        return `TIKTOK_TARGET_IDC=${targetIdc}`;
      }
      return line;
    });

    if (!sidFound) {
      lines.push(`TIKTOK_SESSION_ID=${sessionId}`);
    }
    if (!idcFound) {
      lines.push(`TIKTOK_TARGET_IDC=${targetIdc}`);
    }

    await fsp.writeFile(envPath, lines.join('\n'), 'utf8');
    console.log('[TikTok] Persisted session information to:', envPath);
    
    // Also update current process env for immediate use
    process.env.TIKTOK_SESSION_ID = sessionId;
    process.env.TIKTOK_TARGET_IDC = targetIdc;
  } catch (err) {
    console.error('[TikTok] Failed to persist session:', err);
  }
}
