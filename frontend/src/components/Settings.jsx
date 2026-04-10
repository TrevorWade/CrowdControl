import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import PhotoMappingSettings from './PhotoMappingSettings.jsx';

/**
 * Settings component for configuring gift stacking behavior
 * Features: Stacking mode selection, global toggle, real-time updates
 */
export default function Settings({
  isOpen,
  onClose,
  stackingEnabled,
  onStackingModeChange
}) {
  const [localStackingEnabled, setLocalStackingEnabled] = useState(stackingEnabled);
  const [selectedMode, setSelectedMode] = useState('cumulative_hold');

  // Sync with props
  useEffect(() => {
    setLocalStackingEnabled(stackingEnabled);
  }, [stackingEnabled]);

  const handleStackingToggle = (enabled) => {
    setLocalStackingEnabled(enabled);
    onStackingModeChange?.({
      type: 'set-stacking-mode',
      enabled: enabled
    });
  };

  const handleModeSelect = (mode) => {
    setSelectedMode(mode);
    // Note: Mode selection would be implemented per gift in the mapping modal
  };

  if (!isOpen) return null;

  const stackingModes = [
    {
      id: 'cumulative_hold',
      title: 'Cumulative Hold',
      description: 'Hold key for total duration of all stacked gifts',
      example: '5 Roses → Hold W for 5 seconds total',
      recommended: true,
      icon: '🎯'
    },
    {
      id: 'sequential',
      title: 'Sequential',
      description: 'Press key multiple times with delays between each',
      example: '5 Roses → Press W 5 times with 50ms delays',
      recommended: false,
      icon: '🔄'
    },
    {
      id: 'batch',
      title: 'Batch',
      description: 'Send all key presses in rapid succession',
      example: '5 Roses → Press W 5 times rapidly',
      recommended: false,
      icon: '⚡'
    }
  ];

  // Render the modal at the document body level so it's not constrained by parent stacking contexts
  return createPortal(
    // Overlay wrapper captures clicks outside the modal to close settings
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-8"
      onClick={(e) => {
        // Close only when the click is on the overlay itself (outside modal)
        if (e.target === e.currentTarget) {
          onClose?.();
        }
      }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      ></div>

      {/* Modal */}
      <div className="relative w-full max-w-2xl bg-tiktok-black border border-tiktok-gray rounded-xl shadow-2xl animate-fadeInUp max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-tiktok-gray">
          <div>
            <h2 className="text-xl font-semibold text-tiktok-white">
              Settings
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Configure gift stacking behavior
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-gray-700 hover:bg-gray-600 transition-colors flex items-center justify-center"
          >
            <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Global Stacking Toggle */}
          <div className="flex items-center justify-between p-4 bg-tiktok-gray/30 rounded-lg border border-tiktok-gray">
            <div>
              <h3 className="text-tiktok-white font-medium">Enable Gift Stacking</h3>
              <p className="text-sm text-gray-400 mt-1">
                When multiple gifts of the same type are received, accumulate them before triggering
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={localStackingEnabled}
                onChange={(e) => handleStackingToggle(e.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-tiktok-cyan/25 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-tiktok-cyan"></div>
            </label>
          </div>

          {/* Stacking Modes */}
          <div>
            <h3 className="text-lg font-medium text-tiktok-white mb-4">Stacking Modes</h3>
            <p className="text-sm text-gray-400 mb-4">
              Choose how multiple gifts of the same type should be processed. This can be configured per gift in the mapping settings.
            </p>

            <div className="space-y-4">
              {stackingModes.map((mode) => (
                <div
                  key={mode.id}
                  className={`p-4 rounded-lg border transition-all cursor-pointer ${
                    selectedMode === mode.id
                      ? 'border-tiktok-cyan bg-tiktok-cyan/10'
                      : 'border-tiktok-gray bg-tiktok-gray/20 hover:border-tiktok-gray/50'
                  }`}
                  onClick={() => handleModeSelect(mode.id)}
                >
                  <div className="flex items-start gap-4">
                    <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center text-xl">
                      {mode.icon}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-tiktok-white font-medium">{mode.title}</h4>
                        {mode.recommended && (
                          <span className="px-2 py-1 bg-tiktok-cyan/20 text-tiktok-cyan text-xs rounded-full">
                            Recommended
                          </span>
                        )}
                        {selectedMode === mode.id && (
                          <span className="px-2 py-1 bg-tiktok-cyan text-white text-xs rounded-full">
                            Selected
                          </span>
                        )}
                      </div>
                      <p className="text-gray-300 text-sm mb-2">{mode.description}</p>
                      <div className="text-xs text-gray-500 bg-gray-800/50 px-3 py-2 rounded border-l-2 border-tiktok-cyan">
                        <strong>Example:</strong> {mode.example}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* TikTok Account Connection */}
          <div className="p-4 bg-tiktok-gray/30 rounded-lg border border-tiktok-gray">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-tiktok-white font-medium">TikTok Account</h3>
                <p className="text-sm text-gray-400 mt-1">
                  Connect your account to avoid connection blocks
                </p>
              </div>
              <div className="p-2 bg-tiktok-red/10 rounded-lg">
                <svg className="w-6 h-6 text-tiktok-red" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
                </svg>
              </div>
            </div>
            
            <button
              onClick={async () => {
                if (window.tiktokAPI) {
                  try {
                    const result = await window.tiktokAPI.startLogin();
                    if (result.success) {
                      alert('Successfully connected TikTok account!');
                    } else if (result.error !== 'Login window closed') {
                      alert(`Login failed: ${result.error}`);
                    }
                  } catch (err) {
                    alert(`Error: ${err.message}`);
                  }
                }
              }}
              className="w-full py-3 bg-tiktok-red hover:bg-tiktok-red-dark text-white font-bold rounded-lg transition-all flex items-center justify-center gap-2 shadow-lg shadow-tiktok-red/20"
            >
              <span>Connect TikTok Account</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            <p className="text-[10px] text-gray-500 mt-2 text-center uppercase tracking-widest font-bold">
              Automated session extraction enabled
            </p>
          </div>

          {/* Photo Mapping Section */}
          <PhotoMappingSettings />

          {/* Help Section */}
          <div className="p-4 bg-blue-900/20 border border-blue-700/50 rounded-lg">
            <h4 className="text-blue-300 font-medium mb-2">💡 How It Works</h4>
            <ul className="text-sm text-blue-200 space-y-1">
              <li>• <strong>Stacking Window:</strong> Gifts received within 2 seconds of each other are stacked</li>
              <li>• <strong>Per-Gift Config:</strong> Each gift mapping can have its own stacking settings</li>
              <li>• <strong>Real-time:</strong> Stacking status is shown in the live feed</li>
              <li>• <strong>Flexible:</strong> Disable stacking for any gift that should trigger immediately</li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-tiktok-gray">
          <div className="text-xs text-gray-500">
            Changes apply immediately
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
