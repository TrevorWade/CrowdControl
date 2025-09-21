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
