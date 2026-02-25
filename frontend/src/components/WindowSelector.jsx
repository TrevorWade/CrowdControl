import { useEffect, useMemo, useState } from 'react';

/**
 * WindowSelector
 * - Lists open top-level windows (Windows-only; returns empty elsewhere)
 * - Lets user pick a target window by HWND
 * - Shows a small focus badge reflecting whether the selected window is focused
 *
 * Usage:
 *   <WindowSelector onSelect={(selection) => { ... }} />
 *
 * onSelect receives:
 *   {
 *     hwnd: number,
 *     title: string,
 *     appName: string,
 *     processId: number,
 *     exePath: string,
 *     iconDataUrl?: string
 *   }
 *
 * Manual test:
 *  - Open Notepad, Chrome, Terminal
 *  - Open the dropdown; Notepad/Chrome/Terminal should be listed with titles
 *  - Select Notepad; toggle focus between apps, "Focused" should reflect foreground app
 *  - Close a listed app and press Refresh; it should disappear
 */
export default function WindowSelector({ onSelect }) {
  const [items, setItems] = useState([]);
  const [selectedHwnd, setSelectedHwnd] = useState(() => {
    const saved = localStorage.getItem('ttlrl_selected_hwnd');
    return saved ? Number(saved) : 0;
  });
  const [isFocused, setIsFocused] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const hasApi = typeof window !== 'undefined' && window.windowsAPI && typeof window.windowsAPI.list === 'function';

  const refresh = async () => {
    if (!hasApi) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await window.windowsAPI.list();
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist selection
  useEffect(() => {
    if (selectedHwnd) {
      localStorage.setItem('ttlrl_selected_hwnd', String(selectedHwnd));
    } else {
      localStorage.removeItem('ttlrl_selected_hwnd');
    }
  }, [selectedHwnd]);

  // Focus watcher
  useEffect(() => {
    if (!hasApi || !selectedHwnd) return;
    const stop = window.windowsAPI.watchFocus(selectedHwnd, (p) => {
      setIsFocused(Boolean(p && p.isFocused));
    });
    return () => {
      try { stop && stop(); } catch {}
    };
  }, [hasApi, selectedHwnd]);

  const filtered = useMemo(() => {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return items;
    return (items || []).filter((w) => {
      const t = (w.title || '').toLowerCase();
      const a = (w.appName || '').toLowerCase();
      return t.includes(q) || a.includes(q);
    });
  }, [query, items]);

  const selectedItem = useMemo(() => {
    return (items || []).find((w) => Number(w.hwnd) === Number(selectedHwnd)) || null;
  }, [items, selectedHwnd]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-300 font-medium">Open Windows</div>
        <button
          onClick={refresh}
          className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded"
          title="Refresh the list"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <input
        className="w-full bg-gray-800 border border-gray-600 px-3 py-2 rounded text-white text-sm placeholder-gray-400 focus:border-tiktok-cyan focus:outline-none"
        placeholder="Filter by title or app name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <select
        className="w-full bg-gray-800 border border-gray-600 px-3 py-2 rounded text-white text-sm focus:border-tiktok-cyan focus:outline-none"
        value={selectedHwnd || ''}
        onChange={(e) => {
          const hwnd = Number(e.target.value);
          setSelectedHwnd(hwnd);
          const picked = (items || []).find((w) => Number(w.hwnd) === hwnd) || null;
          try { onSelect && onSelect(picked || null); } catch {}
        }}
      >
        <option value="" disabled>
          Select a window…
        </option>
        {filtered.map((w) => {
          const label = `${w.appName || 'Unknown app'}${w.title ? ' — ' + w.title : ''}`;
          return (
            <option key={w.hwnd} value={w.hwnd}>
              {label}
            </option>
          );
        })}
      </select>

      {!!selectedHwnd && (
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${isFocused ? 'bg-green-400' : 'bg-gray-500'}`}
            title={isFocused ? 'Selected window is focused' : 'Selected window is not focused'}
          ></span>
          <span className="text-xs text-gray-400">
            {isFocused ? 'Focused' : 'Not focused'}
          </span>
        </div>
      )}
    </div>
  );
}


