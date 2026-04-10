import { useState } from 'react';
import CompactTikTokConnection from './CompactTikTokConnection';
import CompactTargetWindow from './CompactTargetWindow';
import Settings from './Settings';

/**
 * Header component with TikTok-style branding and navigation
 * Features: Logo, title, compact connection, and settings/help icons
 */
export default function Header({
  connectionStatus,
  connectedUsername,
  connectionError,
  isLive,
  onConnectionChange,
  stackingEnabled,
  onStackingModeChange,
  targetWindowKeyword
}) {
  const [showSettings, setShowSettings] = useState(false);
  return (
    <header className="bg-tiktok-black border-b border-tiktok-gray px-6 py-4 relative z-50">
      <div className="flex items-center justify-between">
        {/* Logo and title */}
        <div className="flex items-center gap-4">
          {/* TikTok-style note icon */}
          <div className="w-8 h-8 bg-tiktok-red rounded-lg flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-tiktok-white">
            CrowdControl
          </h1>
        </div>
        
        {/* TikTok Connection and Settings */}
        <div className="flex items-center gap-3">
          {/* Compact TikTok Connection */}
          <CompactTikTokConnection
            connectionStatus={connectionStatus}
            username={connectedUsername}
            connectionError={connectionError}
            isLive={isLive}
            onConnectionChange={onConnectionChange}
          />
          {/* Target Window control */}
          <CompactTargetWindow initialKeyword={targetWindowKeyword} />
          
          {/* Settings and help icons */}
          <button
            onClick={() => setShowSettings(true)}
            className="w-8 h-8 rounded-full bg-tiktok-gray hover:bg-tiktok-cyan/20 transition-colors flex items-center justify-center"
          >
            <svg className="w-5 h-5 text-tiktok-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button className="w-8 h-8 rounded-full bg-tiktok-gray hover:bg-tiktok-cyan/20 transition-colors flex items-center justify-center">
            <svg className="w-5 h-5 text-tiktok-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Settings Modal */}
      <Settings
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        stackingEnabled={stackingEnabled}
        onStackingModeChange={onStackingModeChange}
      />
    </header>
  );
}
