import React, { useEffect, useMemo, useState } from 'react';
import { useOverlay } from '../context/OverlayContext.jsx';
import { photoForKey, getActiveProfile, loadGameFromDisk } from '../services/photoMappingStore.js';

/**
 * StreamOverlay
 * Read-only overlay for stream use. Shows compact lists of:
 *  - Gift mappings (e.g., Rose = W 1s)
 *  - Like triggers (e.g., 100 Likes = SHIFT 0.5s)
 *
 * Photo rendering:
 *  - If a photo is mapped for a key, render a small image instead of the letter.
 *  - Otherwise render the key as text.
 *
 * Props:
 *  - mapping: object of { giftNameLower: { key, durationSec, cooldownMs? } }
 *  - likeTriggers: array of { threshold, key, durationMs }
 */
export default function StreamOverlay({ mapping, likeTriggers, onCloseOverride, transparentBackground }) {
  const { toggleOverlay } = useOverlay();
  const closeOverlay = onCloseOverride || toggleOverlay;

  // Accept live updates from host window via BroadcastChannel
  const [liveMapping, setLiveMapping] = useState(mapping || {});
  const [liveTriggers, setLiveTriggers] = useState(Array.isArray(likeTriggers) ? likeTriggers : []);
  const [liveTotalLikes, setLiveTotalLikes] = useState(0);
  useEffect(() => setLiveMapping(mapping || {}), [mapping]);
  useEffect(() => setLiveTriggers(Array.isArray(likeTriggers) ? likeTriggers : []), [likeTriggers]);
  useEffect(() => {
    try {
      const bc = new BroadcastChannel('ttlrl-overlay');
      // Ask the host for current state in case we opened mid-session
      bc.postMessage({ type: 'request-state' });
      bc.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === 'mapping' && m.mapping) setLiveMapping(m.mapping);
        if (m.type === 'likeTriggers' && Array.isArray(m.likeTriggers)) setLiveTriggers(m.likeTriggers);
        if (m.type === 'totalLikes' && typeof m.totalLikes === 'number') setLiveTotalLikes(m.totalLikes);
        if (m.type === 'photoMapUpdated') {
          const name = String(m.profile || m.gameName || '').trim();
          // Reload photo-map.json so photoForKey() reflects latest images
          const target = name || null;
          Promise.resolve(getActiveProfile())
            .then((active) => loadGameFromDisk(target || active))
            .catch(() => {});
        }
      };
      return () => bc.close();
    } catch {}
  }, []);

  // Initial load of photo-map.json for the active profile so key thumbnails resolve
  useEffect(() => {
    (async () => {
      try {
        const active = await getActiveProfile();
        await loadGameFromDisk(active);
      } catch {}
    })();
  }, []);

  // Convert mapping object into stable rows for display
  const giftRows = useMemo(() => {
    if (!mapping) return [];
    return Object.entries(liveMapping).map(([giftKey, cfg]) => {
      const label = giftKey; // already lowercased in app state
      const key = (cfg?.key || '').toUpperCase();
      const durationSec = typeof cfg?.durationSec === 'number' ? cfg.durationSec : 1;
      return { label, key, durationSec };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }, [liveMapping]);

  // Convert like triggers into rows
  const triggerRows = useMemo(() => {
    if (!Array.isArray(liveTriggers)) return [];
    return liveTriggers.map((t) => ({
      threshold: Number(t.threshold) || 0,
      key: String(t.key || '').toUpperCase(),
      durationSec: (Number(t.durationMs) || 0) / 1000,
    })).sort((a, b) => a.threshold - b.threshold);
  }, [liveTriggers]);

  function computeProgress(threshold) {
    if (!threshold) return { percent: 0, likesUntilNext: 0 };
    const current = liveTotalLikes % threshold;
    const percent = Math.min(100, Math.max(0, (current / threshold) * 100));
    const likesUntilNext = threshold - current || threshold;
    return { percent, likesUntilNext };
  }

  function toImageSrc(p) {
    if (!p) return null;
    if (/^https?:\/\//i.test(p)) return p;
    let normalized = String(p).replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    return encodeURI('file://' + normalized);
  }

  function KeyThumb({ keyName }) {
    const [src, setSrc] = useState(null);
    const [failed, setFailed] = useState(false);
    const [refreshToken, setRefreshToken] = useState(0);

    useEffect(() => {
      async function resolveAndLoad() {
        let p = photoForKey(keyName);
        if (!p) {
          try {
            const active = await getActiveProfile();
            await loadGameFromDisk(active);
            p = photoForKey(keyName);
          } catch {}
        }
        if (!p) {
          setSrc(null);
          setFailed(false);
          return;
        }
        const url = toImageSrc(p);
        setSrc(url);
        setFailed(false);
        // If file:// fails (dev server security), request data URL via Electron bridge
        const img = new Image();
        img.onload = () => {};
        img.onerror = async () => {
          try {
            const bridge = (typeof window !== 'undefined' && window.photoMap) ? window.photoMap : null;
            if (bridge && bridge.readFileAsDataUrl) {
              const dataUrl = await bridge.readFileAsDataUrl(p);
              if (dataUrl) {
                setSrc(dataUrl);
                setFailed(false);
                return;
              }
            }
            setFailed(true);
          } catch {
            setFailed(true);
          }
        };
        img.src = url;
      }
      resolveAndLoad();
    }, [keyName, refreshToken]);

    if (src && !failed) {
      return (
        <div className="w-20 h-20 flex items-center justify-center">
          <img src={src} alt={keyName} className="w-20 h-20 object-contain rounded-md border border-gray-500 bg-black/30" />
        </div>
      );
    }
    return (
      <div className="w-20 h-20 flex items-center justify-center">
        <span className="font-semibold leading-none text-xl">{keyName}</span>
      </div>
    );
  }

  function renderKeyCell(key) {
    return <KeyThumb keyName={key} />;
  }

  return (
    <div className="fixed inset-0 z-[1000] pointer-events-auto">
      {/* Optional background dimmer */}
      {!transparentBackground && (
        <div className="absolute inset-0 bg-black/70" onClick={closeOverlay} />
      )}

      {/* Foreground panel */}
      <div className="absolute inset-0 flex items-start justify-center p-4 sm:p-8">
        <div className="w-full max-w-3xl bg-gray-900/95 text-white rounded-xl border border-gray-700 shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 app-drag select-none">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v12a1 1 0 01-1 1H9l-4 4v-4H4a1 1 0 01-1-1V4z" />
              </svg>
              <h2 className="text-lg font-semibold">Stream Overlay</h2>
            </div>
            <button
              className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-600 app-no-drag"
              onClick={closeOverlay}
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Content */}
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Gifts section */}
            <div>
              <h3 className="text-sm uppercase tracking-wide text-gray-400 mb-2">Gifts</h3>
              <div className="space-y-2 max-h-[50vh] overflow-auto pr-1">
                {giftRows.length === 0 && (
                  <div className="text-gray-500 text-sm">No gift mappings yet</div>
                )}
                {giftRows.map(({ label, key, durationSec }) => (
                  <div key={`gift-${label}`} className="flex items-center bg-gray-800/60 rounded-lg px-3 py-2 border border-gray-700">
                    <div className="flex items-center gap-2 capitalize">
                      <span className="text-gray-300">{label}</span>
                      <span className="text-gray-400">=</span>
                      {renderKeyCell(key)}
                      <span className="text-gray-300">{Math.max(0.1, Number(durationSec) || 1)}s</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Like Triggers section */}
            <div>
              <h3 className="text-sm uppercase tracking-wide text-gray-400 mb-2">Like Triggers</h3>
              <div className="space-y-2 max-h-[50vh] overflow-auto pr-1">
                {triggerRows.length === 0 && (
                  <div className="text-gray-500 text-sm">No like triggers yet</div>
                )}
                {triggerRows.map(({ threshold, key, durationSec }) => {
                  const { percent, likesUntilNext } = computeProgress(threshold);
                  return (
                    <div key={`trigger-${threshold}-${key}`} className="bg-gray-800/60 rounded-lg px-3 py-2 border border-gray-700">
                      <div className="flex items-center gap-2">
                        <span className="text-tiktok-red text-lg leading-none" aria-label={`${threshold} likes`}>❤️</span>
                        <span className="text-tiktok-red font-semibold">{threshold.toLocaleString()}</span>
                        <span className="text-gray-400">=</span>
                        {renderKeyCell(key)}
                        <span className="text-gray-300">{Math.max(0.1, Number(durationSec) || 0)}s</span>
                        <span className="ml-auto text-xs text-gray-400">{likesUntilNext} more</span>
                      </div>
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                          <span>Progress to next trigger</span>
                          <span>{Math.round(percent)}%</span>
                        </div>
                        <div className="w-full bg-gray-700 rounded-full h-1.5">
                          <div className="bg-tiktok-cyan h-1.5 rounded-full transition-all duration-300" style={{ width: `${percent}%` }}></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


