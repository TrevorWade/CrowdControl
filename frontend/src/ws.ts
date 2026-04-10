// WebSocket client with authentication support and auto-retry.
//
// Authentication flow (Step 1.1):
//   1. Socket opens → send { type: 'auth', token }
//   2. Backend validates token → responds { type: 'auth-ok' } then { type: 'init' }
//   3. All subsequent messages flow normally to app listeners.

export type Mapping = Record<string, { key: string; durationMs: number }>;

type Listener = (msg: unknown) => void;

let socket: WebSocket | null = null;
let _authenticated = false;
let _authFailed = false;        // stop reconnect loop on bad token
let _retryTimer: ReturnType<typeof setTimeout> | null = null; // pending reconnect handle
const listeners: Listener[] = [];

// ── Token resolution ─────────────────────────────────────────────────────────
// The token comes only from the Electron IPC bridge (window.electronAuth).
// In non-Electron environments the token is null and auth will fail gracefully.

let _cachedToken: string | null | undefined = undefined;

async function fetchToken(): Promise<string | null> {
  if (_cachedToken !== undefined) return _cachedToken;

  console.log('[WS-Auth] Resolving token via Electron IPC...');

  // Try Electron IPC with a 2-second timeout to prevent connection hang
  const ipcPromise = (async (): Promise<string | null> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).electronAuth;
      if (api && typeof api.getWsToken === 'function') {
        const t = await api.getWsToken();
        if (typeof t === 'string' && t.length > 0) {
          console.log('[WS-Auth] ✅ Token acquired via Electron IPC');
          return t;
        }
      }
    } catch (e) {
      console.warn('[WS-Auth] IPC call failed:', e);
    }
    return null;
  })();

  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));

  _cachedToken = await Promise.race([ipcPromise, timeoutPromise]);

  if (!_cachedToken) {
    console.warn('[WS-Auth] No token available. Not running inside Electron?');
    _cachedToken = null;
  }

  return _cachedToken;
}
// ─────────────────────────────────────────────────────────────────────────────

export function connect(onMessage: Listener): void {
  // Guard: deduplicate — Strict Mode double-invokes connect() in dev;
  // the same listener reference must never appear twice in the array.
  if (!listeners.includes(onMessage)) {
    listeners.push(onMessage);
  }
  openSocket();
}

/**
 * Remove a listener registered with connect().
 * When the last listener is removed the socket is closed and all timers are
 * cancelled so nothing lingers after the component unmounts.
 */
export function disconnect(onMessage: Listener): void {
  const idx = listeners.indexOf(onMessage);
  if (idx !== -1) listeners.splice(idx, 1);

  // If no consumers remain, tear down the connection entirely.
  if (listeners.length === 0) {
    if (_retryTimer !== null) {
      clearTimeout(_retryTimer);
      _retryTimer = null;
    }
    if (socket) {
      // Remove the onclose handler first so it doesn't schedule another retry.
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      socket = null;
    }
    _authenticated = false;
    // Leave _authFailed as-is — a bad token won't magically become valid.
    console.log('[WS] All listeners removed; socket closed.');
  }
}

function openSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (_authFailed) {
    console.error('[WS] Reconnect blocked: auth previously failed (token mismatch).');
    return;
  }

  _authenticated = false;
  socket = new WebSocket('ws://localhost:5178');

  socket.onopen = async () => {
    console.log('[WS] Socket open – fetching token and authenticating...');
    const token = await fetchToken();
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'auth', token: token ?? '' }));
        console.log('[WS] Auth frame sent.');
      }
    } catch (e) {
      console.error('[WS] Failed to send auth frame:', e);
    }
  };

  socket.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>;

      if (msg.type === 'auth-ok') {
        _authenticated = true;
        console.log('[WS] ✅ Authenticated successfully');
        return;
      }
      if (msg.type === 'auth-error') {
        _authFailed = true;
        console.error('[WS] ❌ Auth rejected by server:', msg.error);
        socket?.close();
        return;
      }

      if (_authenticated) {
        listeners.forEach((l) => l(msg));
      } else {
        console.warn('[WS] Message received before auth complete; ignoring:', msg.type);
      }
    } catch (e) {
      console.error('[WS] Parse error:', e);
    }
  };

  socket.onclose = (ev) => {
    _authenticated = false;
    if (_authFailed) return; // do not loop on auth rejection
    if (listeners.length === 0) return; // component unmounted — skip retry
    console.log(`[WS] Connection closed (code ${ev.code}). Retrying in 2 s...`);
    _retryTimer = setTimeout(openSocket, 2000);
  };

  socket.onerror = (err) => {
    console.error('[WS] Socket error:', err);
  };
}

export function send(msg: unknown): void {
  if (socket?.readyState === WebSocket.OPEN && _authenticated) {
    socket.send(JSON.stringify(msg));
  }
}

export function setTargetWindow(keyword: string): void {
  send({ type: 'set-target-window', keyword });
}
