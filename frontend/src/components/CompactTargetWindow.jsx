import { useEffect, useRef, useState } from 'react';
import { send } from '../ws';
import WindowSelector from './WindowSelector.jsx';

/**
 * CompactTargetWindow: header control to set the target window keyword at runtime
 */
export default function CompactTargetWindow({ initialKeyword = '' }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const wrapperRef = useRef(null);
  const [keyword, setKeyword] = useState(() => {
    return localStorage.getItem('ttlrl_target_window') || initialKeyword || '';
  });

  useEffect(() => {
    if (initialKeyword && !keyword) setKeyword(initialKeyword);
  }, [initialKeyword]);

  useEffect(() => {
    localStorage.setItem('ttlrl_target_window', keyword || '');
  }, [keyword]);

  // Close on outside click anywhere on the page
  useEffect(() => {
    if (!isExpanded) return;
    const onDocClick = (e) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target)) {
        setIsExpanded(false);
      }
    };
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [isExpanded]);

  const apply = () => {
    const k = String(keyword || '').trim();
    send({ type: 'set-target-window', keyword: k });
    setIsExpanded(false);
  };

  const clear = () => {
    setKeyword('');
    send({ type: 'set-target-window', keyword: '' });
    setIsExpanded(false);
  };

  const badgeColor = keyword ? 'bg-green-400' : 'bg-gray-500';
  const title = keyword ? `Target window: "${keyword}"` : 'No target window set';

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 px-3 py-2 bg-tiktok-gray/50 hover:bg-tiktok-gray/80 rounded-lg transition-colors border border-gray-600"
        title={title}
      >
        <div className={`w-2 h-2 rounded-full ${badgeColor}`}></div>
        <span className="text-gray-300 text-sm">Target</span>
        <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      </button>

      {isExpanded && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-tiktok-black border border-tiktok-gray rounded-lg shadow-xl p-4 z-50">
          <div className="mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-tiktok-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0-6C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
            </svg>
            <h3 className="text-white font-medium">Set Target Window</h3>
          </div>

          <div className="text-xs text-gray-400 mb-2">
            Enter part of the game window title or process name. We'll focus it before sending keys.
          </div>

          {/* Windows-only helper: dropdown of open windows (like OBS) */}
          <div className="mb-3">
            <WindowSelector
              onSelect={(w) => {
                // If user selects a window, pre-fill keyword with appName or title for compatibility
                if (w && (w.appName || w.title)) {
                  setKeyword(w.appName || w.title || '');
                }
              }}
            />
          </div>

          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              placeholder="e.g. rocket league, chrome, valorant"
              className="flex-1 min-w-0 bg-gray-800 border border-gray-600 px-3 py-2 rounded text-white text-sm placeholder-gray-400 focus:border-tiktok-cyan focus:outline-none"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <button
              onClick={apply}
              className="px-3 py-2 bg-tiktok-cyan hover:bg-tiktok-cyan/80 text-black text-sm font-medium rounded"
            >
              Apply
            </button>
            <button
              onClick={clear}
              className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded"
            >
              Clear
            </button>
          </div>

          {keyword && (
            <div className="mt-2 text-xs text-gray-400">
              Current: <span className="text-gray-200">"{keyword}"</span>
            </div>
          )}
        </div>
      )}

      {/* Backdrop no longer required for closing, but keep to block interactions under header */}
      {isExpanded && (
        <div className="fixed inset-0 z-40"></div>
      )}
    </div>
  );
}


