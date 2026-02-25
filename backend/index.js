// Loads environment variables from .env (optional)
try {
  require('dotenv').config();
} catch (e) {
  console.warn('dotenv not found; continuing without .env file');
}

const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const sender = require('node-key-sender');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// HTTP server removed: no static gift catalog or fallback endpoints
const injectionMode = String(process.env.INJECTION_MODE || 'nodesender').toLowerCase();
let currentInjectionMode = injectionMode; // can be changed at runtime via WS
// Optional focus guard to avoid sending keys to the wrong window (runtime-settable)
let targetWindowKeyword = (process.env.TARGET_WINDOW_KEYWORD || '').toLowerCase();

// In-memory mapping: { [giftNameLower]: { key: 'a', durationMs: 500 } }
let giftToAction = {};
let isPaused = false;
// Track last execution time per gift (lowercased)
const lastFiredAtByGift = {};
// Track total likes count
let totalLikes = 0;

// Gift stacking configuration
const GIFT_STACKING_WINDOW_MS = 2000; // 2 seconds to accumulate gifts
let giftStackingEnabled = true; // Global toggle

// Stacking state: { [giftNameLower]: { count, lastReceived, timeoutId } }
let giftStacks = {};

// Dynamic gift catalog collected from live events
let dynamicGiftCatalog = new Map(); // giftName -> { id, name, imageUrl, diamondCount, lastSeen }
// Track in-progress streak counts to compute accurate deltas for streakable gifts
const streakLastCountByPair = new Map(); // `${sender}|${gift}` -> last repeatCount

// Global action queue to ensure sequential execution of gift actions
let giftActionQueue = Promise.resolve();

// 1) WebSocket server for frontend ↔ backend sync
const port = Number(process.env.WS_PORT || 5178);
const wss = new WebSocketServer({ port }, () => {
  console.log(`WS listening on ws://localhost:${port}`);
});

// Broadcast helper
function broadcast(payload) {
  const message = JSON.stringify(payload);
  const clientCount = wss.clients.size;
  console.log(`📡 Broadcasting to ${clientCount} clients:`, payload.type);

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
      console.log(`✅ Sent to client ${client._id || 'unknown'}`);
    } else {
      console.log(`❌ Client ${client._id || 'unknown'} not ready (state: ${client.readyState})`);
    }
  });
}

// Return { ok: boolean, title?: string, owner?: string }
async function checkTargetWindowFocused() {
  if (!targetWindowKeyword) return { ok: true };
  try {
    const mod = await import('active-win');
    const activeWindow = mod.default || mod;
    const info = await activeWindow();
    const title = String(info?.title || '');
    const owner = String(info?.owner?.name || '');
    const haystack = `${title} ${owner}`.toLowerCase();
    const ok = haystack.includes(targetWindowKeyword);
    return { ok, title, owner };
  } catch (err) {
    // If detection fails, don't block macros; just log once
    console.warn('Focus check failed; proceeding without guard');
    return { ok: true };
  }
}

// Handle messages from frontend (mapping updates, pause toggle, test events)
wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket client connected');

  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'init',
    mapping: giftToAction,
    paused: isPaused,
    injectionMode: currentInjectionMode,
    stackingEnabled: giftStackingEnabled,
    totalLikes,
    connectionStatus,
    username,
    connectionError,
    isLive,
    targetWindowKeyword
  }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log(`📨 Received WebSocket message: ${msg.type}`);

      if (msg.type === 'update-mapping') {
        // Entire mapping replaces current one
        giftToAction = msg.mapping || {};
        broadcast({ type: 'mapping-updated', mapping: giftToAction });
      }

      if (msg.type === 'toggle-pause') {
        isPaused = !!msg.paused;
        broadcast({ type: 'pause-updated', paused: isPaused });
      }

      if (msg.type === 'test-gift') {
        // For Test Mode: simulate receiving a gift by name
        const giftName = String(msg.giftName || '').toLowerCase();
        const delayMs = Number(msg.delayMs || 0);
        const countInc = Math.max(1, Number(msg.countInc || 1));
        if (delayMs > 0) {
          console.log(`[TEST] Simulate gift: ${giftName} in ${delayMs}ms`);
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          console.log(`[TEST] Simulate gift: ${giftName}`);
        }
        giftActionQueue = giftActionQueue
          .then(() => handleGiftByName(giftName, 'TestUser', countInc))
          .catch((err) => console.error('Test gift action error:', err));
      }

      if (msg.type === 'test-like-trigger') {
        // Test a like trigger by simulating like events to reach the threshold
        const triggerKey = msg.triggerKey?.trim();
        const targetLikes = parseInt(msg.targetLikes);

        if (triggerKey && targetLikes > 0) {
          console.log(`🧪 Testing like trigger: every ${targetLikes} likes → "${triggerKey}"`);

          // Don't modify the actual totalLikes - just test the trigger
          // Calculate how many likes needed to trigger
          const currentLikes = totalLikes;
          const likesNeeded = targetLikes - (currentLikes % targetLikes);
          const testLikes = likesNeeded === 0 ? targetLikes : likesNeeded;

          console.log(`🧪 Simulated +${testLikes} likes (${currentLikes} → ${currentLikes + testLikes}) - TEST ONLY`);

          // Execute the key action if not paused (without updating totalLikes)
          if (!isPaused) {
            console.log(`⏰ Waiting 3000ms before executing like trigger test...`);
            setTimeout(async () => {
              // Use the same key injection logic as gifts
              const key = String(triggerKey).toLowerCase();
              const durationMs = 1000; // 1 second duration for test

              // Focus guard
              const focus = await checkTargetWindowFocused();
              if (!focus.ok) {
                console.log('Target window not focused; skipping like key trigger test');
                return;
              }

              console.log(`Like trigger test: Press key "${key}" for ${durationMs}ms (mode=${currentInjectionMode})`);

              if (currentInjectionMode === 'autohotkey') {
                const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
                const ahkKey = mapKeyToAhk(key);
                const titleMatch = targetWindowKeyword;

                const v2script = buildAhkHoldScriptV2(ahkKey, durationMs, titleMatch);
                const v1script = buildAhkHoldScriptV1(ahkKey, durationMs, titleMatch);

                const tmpV2 = path.join(os.tmpdir(), `ttlrl_like_test_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
                fs.writeFileSync(tmpV2, v2script, 'utf8');
                const v2ok = await runAhk(ahkPath, tmpV2);
                try { fs.unlinkSync(tmpV2); } catch { }
                if (!v2ok) {
                  const tmpV1 = path.join(os.tmpdir(), `ttlrl_like_test_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
                  fs.writeFileSync(tmpV1, v1script, 'utf8');
                  await runAhk(ahkPath, tmpV1);
                  try { fs.unlinkSync(tmpV1); } catch { }
                }
              } else {
                // Default to nodesender
                sender.startBatch();
                sender.batchTypeKey(key, 0, sender.BATCH_EVENT_KEY_DOWN);
                sender.batchTypeKey(key, durationMs, sender.BATCH_EVENT_KEY_UP);
                await sender.sendBatch();
              }
            }, 3000);
          }
        }
      }

      if (msg.type === 'set-injection-mode') {
        const mode = String(msg.mode || '').toLowerCase();
        const allowed = ['nodesender', 'nodesender_repeat', 'autohotkey'];
        if (allowed.includes(mode)) {
          currentInjectionMode = mode;
          broadcast({ type: 'injection-mode-updated', mode });
        }
      }

      if (msg.type === 'set-stacking-mode') {
        giftStackingEnabled = !!msg.enabled;
        console.log(`📚 Gift stacking ${giftStackingEnabled ? 'enabled' : 'disabled'}`);
        broadcast({ type: 'stacking-mode-updated', enabled: giftStackingEnabled });

        // Clear all active stacks if stacking is disabled
        if (!giftStackingEnabled) {
          for (const giftName in giftStacks) {
            clearGiftStack(giftName);
          }
        }
      }

      if (msg.type === 'set-target-window') {
        const keyword = String(msg.keyword || '').trim().toLowerCase();
        targetWindowKeyword = keyword;
        console.log(`🎯 Target window keyword set to: "${targetWindowKeyword}"`);
        broadcast({ type: 'target-window-updated', keyword: targetWindowKeyword });
      }

      if (msg.type === 'like-key') {
        // Handle like-triggered key press using same mechanism as gift mappings
        const key = String(msg.key || '').toLowerCase();
        const durationMs = Math.max(0, Number(msg.durationMs || 300));

        if (isPaused) {
          console.log('Paused; ignoring like key trigger');
          return;
        }

        // Focus guard
        const focus = await checkTargetWindowFocused();
        if (!focus.ok) {
          console.log('Target window not focused; skipping like key trigger');
          return;
        }

        try {
          console.log(`Like trigger: Press key "${key}" for ${durationMs}ms (mode=${currentInjectionMode})`);

          // Use exact same key injection logic as gifts
          if (currentInjectionMode === 'autohotkey') {
            const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
            const ahkKey = mapKeyToAhk(key);
            const titleMatch = targetWindowKeyword;

            const v2script = buildAhkHoldScriptV2(ahkKey, durationMs, titleMatch);
            const v1script = buildAhkHoldScriptV1(ahkKey, durationMs, titleMatch);

            const tmpV2 = path.join(os.tmpdir(), `ttlrl_like_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
            fs.writeFileSync(tmpV2, v2script, 'utf8');
            const v2ok = await runAhk(ahkPath, tmpV2);
            try { fs.unlinkSync(tmpV2); } catch { }
            if (!v2ok) {
              const tmpV1 = path.join(os.tmpdir(), `ttlrl_like_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
              fs.writeFileSync(tmpV1, v1script, 'utf8');
              await runAhk(ahkPath, tmpV1);
              try { fs.unlinkSync(tmpV1); } catch { }
            }
          } else {
            // Default to nodesender
            sender.startBatch();
            sender.batchTypeKey(key, 0, sender.BATCH_EVENT_KEY_DOWN);
            sender.batchTypeKey(key, durationMs, sender.BATCH_EVENT_KEY_UP);
            await sender.sendBatch();
          }
        } catch (err) {
          console.error('Like key trigger error:', err);
        }
      }

      if (msg.type === 'connect-tiktok') {
        // Connect to a TikTok username
        const targetUsername = String(msg.username || '').trim();
        if (!targetUsername) {
          console.log('❌ TikTok connection request missing username');
          ws.send(JSON.stringify({
            type: 'connection-error',
            error: 'Username is required'
          }));
          return;
        }

        console.log(`📨 Received TikTok connection request for @${targetUsername}`);
        const success = await connectToTikTok(targetUsername);

        if (success) {
          console.log(`✅ TikTok connection successful for @${targetUsername}`);
          ws.send(JSON.stringify({
            type: 'connection-success',
            username: targetUsername
          }));
        } else {
          console.log(`❌ TikTok connection failed for @${targetUsername}`);
        }
      }

      if (msg.type === 'disconnect-tiktok') {
        // Disconnect from TikTok
        console.log('Disconnect request received');
        await disconnectFromTikTok();
      }

      if (msg.type === 'get-connection-status') {
        // Send current connection status
        ws.send(JSON.stringify({
          type: 'connection-status',
          status: connectionStatus,
          username: username,
          error: connectionError,
          isLive: isLive
        }));
      }

      if (msg.type === 'reset-like-counts') {
        // Reset total likes and all trigger counts
        console.log('🔄 Resetting like counts and trigger counts');
        totalLikes = 0;

        // Broadcast the reset to all clients
        broadcast({
          type: 'like',
          likeCount: 0,
          totalLikes: 0
        });

        // Send success response
        ws.send(JSON.stringify({
          type: 'reset-success',
          message: 'Like counts reset successfully'
        }));
      }
    } catch (e) {
      console.error('Invalid WS message', e);
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
  });

  ws.on('error', (error) => {
    console.error('🔌 WebSocket error:', error);
  });
});

// 2) TikTok Live connector - now dynamic
let username = process.env.TIKTOK_USERNAME || null; // Optional fallback from .env
let tiktok = null;
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
let connectionError = null;
let isLive = false; // Track if the connected user is currently live streaming

// TikTok Connection Management
async function connectToTikTok(targetUsername) {
  try {
    console.log(`🔄 Starting TikTok connection process for @${targetUsername}`);

    // Disconnect existing connection if any
    if (tiktok) {
      try {
        console.log('🔄 Disconnecting existing connection...');
        await tiktok.disconnect();
        console.log('✅ Existing connection disconnected');
      } catch (e) {
        console.log('⚠️ Error disconnecting previous connection:', e.message);
      }
    }

    connectionStatus = 'connecting';
    connectionError = null;
    isLive = false;
    username = targetUsername;

    console.log('📡 Broadcasting connection status: connecting');
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: null,
      isLive: false
    });

    console.log(`🔗 Creating WebcastPushConnection for @${username}...`);

    // Create new connection
    tiktok = new WebcastPushConnection(username, {
      enableExtendedGiftInfo: true,
    });

    console.log('🎧 Setting up TikTok event listeners...');
    // Set up event listeners
    setupTikTokEventListeners();

    console.log('🚀 Attempting to connect to TikTok Live...');
    // Attempt connection
    await tiktok.connect();

    connectionStatus = 'connected';
    isLive = true; // Assume live when connection succeeds
    console.log(`✅ Successfully connected to @${username}`);

    console.log('📡 Broadcasting connection success...');
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: null,
      isLive: true
    });

    return true;

  } catch (error) {
    console.error(`❌ TikTok connection failed for @${targetUsername}:`, error);
    console.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });

    connectionStatus = 'error';
    connectionError = error.message;
    isLive = false;

    console.log('📡 Broadcasting connection error...');
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: connectionError,
      isLive: false
    });

    return false;
  }
}

function setupTikTokEventListeners() {
  if (!tiktok) return;

  // Gift event listener
  tiktok.on('gift', (data) => {
    const giftName = (data?.giftName || '').toLowerCase();
    const displayName = data?.giftName || '';
    const senderName = data?.uniqueId || 'Unknown';
    const imageUrl =
      data?.giftPictureUrl || data?.giftImageUrl || (data?.gift && data.gift.pictureUrl) || null;
    const ts = Date.now();

    // Store gift info in dynamic catalog for real image URLs
    if (displayName && !dynamicGiftCatalog.has(giftName)) {
      const giftInfo = {
        id: data?.giftId || data?.gift?.id || giftName,
        name: displayName,
        imageUrl: imageUrl,
        diamondCount: data?.diamondCount || data?.gift?.diamond_count || 0,
        lastSeen: ts,
        description: `${displayName} - ${data?.diamondCount || 0} diamonds`
      };
      dynamicGiftCatalog.set(giftName, giftInfo);
      console.log(`Added gift to dynamic catalog: ${displayName} with image: ${imageUrl ? 'YES' : 'NO'}`);
    }

    // Compute accurate count increment using streak delta logic
    const giftType = Number(data?.giftType);
    const repeatEnd = Boolean(data?.repeatEnd);
    let countInc = 1;
    if (giftType === 1) {
      const currentCount = Math.max(1, Number(data?.repeatCount || 1));
      const pairKey = `${String(senderName).toLowerCase()}|${giftName}`;
      const prev = streakLastCountByPair.get(pairKey) || 0;
      const delta = currentCount - prev;
      if (delta <= 0) {
        // No new gifts since last event; ignore duplicate/end events
        if (repeatEnd) streakLastCountByPair.delete(pairKey);
        else streakLastCountByPair.set(pairKey, currentCount);
        return;
      }
      countInc = delta;
      if (repeatEnd) {
        streakLastCountByPair.delete(pairKey);
      } else {
        streakLastCountByPair.set(pairKey, currentCount);
      }
    }
    console.log(`Gift received: ${giftName} from ${senderName} (+${countInc})`);
    broadcast({ type: 'gift', giftName, sender: senderName, imageUrl, ts, countInc });

    // Enqueue this gift action to run after prior ones complete
    giftActionQueue = giftActionQueue
      .then(() => handleGiftByName(giftName, senderName, countInc))
      .catch((err) => {
        console.error('Gift action error:', err);
      });
  });

  // Like event listener for tracking total likes
  tiktok.on('like', (data) => {
    const likeCount = Number(data?.likeCount || 1);
    totalLikes += likeCount;
    console.log(`Like received: +${likeCount} (total: ${totalLikes})`);

    // Debug: Log the broadcast message
    const broadcastMsg = { type: 'like', likeCount, totalLikes };
    console.log(`📡 Broadcasting like update:`, broadcastMsg);

    broadcast(broadcastMsg);
  });

  // Connection state events
  tiktok.on('connected', (state) => {
    connectionStatus = 'connected';
    isLive = true;
    console.log('TikTok Live connected!', state);
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: null,
      isLive: true
    });
  });

  tiktok.on('disconnected', () => {
    connectionStatus = 'disconnected';
    isLive = false;
    console.log('TikTok Live disconnected');
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: null,
      isLive: false
    });
  });

  tiktok.on('streamEnd', () => {
    isLive = false;
    console.log('Stream ended');
    broadcast({
      type: 'stream-end',
      connectionStatus,
      username,
      isLive: false
    });
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: null,
      isLive: false
    });
  });

  tiktok.on('error', (error) => {
    connectionStatus = 'error';
    connectionError = error.message;
    isLive = false;
    console.error('TikTok Live error:', error);
    broadcast({
      type: 'connection-status',
      status: connectionStatus,
      username: username,
      error: connectionError,
      isLive: false
    });
  });
}

async function disconnectFromTikTok() {
  if (tiktok) {
    try {
      await tiktok.disconnect();
      connectionStatus = 'disconnected';
      connectionError = null;
      isLive = false;
      console.log('✅ Disconnected from TikTok Live');

      broadcast({
        type: 'connection-status',
        status: connectionStatus,
        username: username,
        error: null,
        isLive: false
      });

    } catch (error) {
      console.error('Error disconnecting:', error);
    }
  }
}

// Auto-connect if username is provided in .env
if (username) {
  console.log(`Auto-connecting to @${username} from .env...`);
  connectToTikTok(username).catch(console.error);
}

// 3) Macro engine

// Gift stacking helper functions
function startGiftStack(giftNameLower, count = 1) {
  if (!giftStackingEnabled) return;

  const action = giftToAction[giftNameLower];
  if (!action || !action.stacking?.enabled) return;

  const stackingConfig = action.stacking;
  const windowMs = stackingConfig.windowMs || GIFT_STACKING_WINDOW_MS;
  const maxStack = stackingConfig.maxStack || 0; // 0 = unlimited

  if (giftStacks[giftNameLower]) {
    // Update existing stack
    const existing = giftStacks[giftNameLower];
    const newCount = existing.count + count;

    // Check max stack limit
    if (maxStack > 0 && newCount > maxStack) {
      console.log(`Stack limit reached for "${giftNameLower}": ${newCount}/${maxStack}, processing immediately`);
      clearTimeout(existing.timeoutId);
      delete giftStacks[giftNameLower];
      processGiftStack(giftNameLower, newCount);
      return;
    }

    existing.count = newCount;
    existing.lastReceived = Date.now();

    // Clear existing timeout and set new one
    clearTimeout(existing.timeoutId);
    existing.timeoutId = setTimeout(() => {
      processGiftStack(giftNameLower);
    }, windowMs);

    console.log(`📚 Stack updated: "${giftNameLower}" (${existing.count})`);
  } else {
    // Create new stack
    const timeoutId = setTimeout(() => {
      processGiftStack(giftNameLower);
    }, windowMs);

    giftStacks[giftNameLower] = {
      count: count,
      lastReceived: Date.now(),
      timeoutId: timeoutId
    };

    console.log(`📚 New stack started: "${giftNameLower}" (${count})`);
  }

  // Broadcast stacking update
  broadcast({
    type: 'gift-stack-update',
    giftName: giftNameLower,
    currentCount: giftStacks[giftNameLower].count,
    maxStack: maxStack,
    stackingWindow: windowMs
  });
}

async function processGiftStack(giftNameLower, overrideCount = null) {
  const stack = giftStacks[giftNameLower];
  if (!stack) return;

  const count = overrideCount || stack.count;
  clearTimeout(stack.timeoutId);
  delete giftStacks[giftNameLower];

  const action = giftToAction[giftNameLower];
  if (!action) return;

  console.log(`🎯 Processing stack: "${giftNameLower}" x${count}`);

  const stackingConfig = action.stacking || {};
  const mode = stackingConfig.mode || 'cumulative_hold'; // Default to cumulative_hold for better UX

  if (mode === 'batch') {
    await processGiftStackBatch(giftNameLower, count, action);
  } else if (mode === 'sequential') {
    await processGiftStackSequential(giftNameLower, count, action);
  } else if (mode === 'cumulative_hold') {
    await processGiftStackCumulativeHold(giftNameLower, count, action);
  } else {
    // Fallback to cumulative hold as default
    await processGiftStackCumulativeHold(giftNameLower, count, action);
  }

  // Broadcast stack completion
  broadcast({
    type: 'gift-stack-complete',
    giftName: giftNameLower,
    processedCount: count
  });
}

async function processGiftStackSequential(giftNameLower, count, action) {
  for (let i = 0; i < count; i++) {
    console.log(`🔄 Processing gift ${i + 1}/${count}: "${giftNameLower}"`);
    await executeGiftAction(giftNameLower, action, `Stack-${i + 1}`);

    // Small delay between actions to prevent overwhelming the system
    if (i < count - 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

async function processGiftStackBatch(giftNameLower, count, action) {
  const key = String(action.key || '').toLowerCase();
  const durationMs = action.durationSec != null ?
    Math.max(0, Number(action.durationSec) * 1000) :
    Number(action.durationMs || 300);

  console.log(`⚡ Batch processing: "${giftNameLower}" x${count} (${key})`);

  if (currentInjectionMode === 'autohotkey') {
    await processGiftStackBatchAhk(giftNameLower, count, key, durationMs);
  } else {
    await processGiftStackBatchNodesender(giftNameLower, count, key, durationMs);
  }

  lastFiredAtByGift[giftNameLower] = Date.now();
}

async function processGiftStackCumulativeHold(giftNameLower, count, action) {
  const key = String(action.key || '').toLowerCase();
  const singleDurationMs = action.durationSec != null ?
    Math.max(0, Number(action.durationSec) * 1000) :
    Number(action.durationMs || 300);
  const totalDurationMs = singleDurationMs * count;

  console.log(`🎯 Cumulative hold: "${giftNameLower}" x${count} (${key}) for ${totalDurationMs}ms total`);

  try {
    // Execute the key hold for the cumulative duration
    if (currentInjectionMode === 'autohotkey') {
      const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
      const ahkKey = mapKeyToAhk(key);
      const titleMatch = targetWindowKeyword;

      const v2script = buildAhkHoldScriptV2(ahkKey, totalDurationMs, titleMatch);
      const v1script = buildAhkHoldScriptV1(ahkKey, totalDurationMs, titleMatch);

      const tmpV2 = path.join(os.tmpdir(), `ttlrl_cumulative_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
      fs.writeFileSync(tmpV2, v2script, 'utf8');
      const v2ok = await runAhk(ahkPath, tmpV2);
      try { fs.unlinkSync(tmpV2); } catch { }
      if (!v2ok) {
        const tmpV1 = path.join(os.tmpdir(), `ttlrl_cumulative_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
        fs.writeFileSync(tmpV1, v1script, 'utf8');
        await runAhk(ahkPath, tmpV1);
        try { fs.unlinkSync(tmpV1); } catch { }
      }
    } else {
      // Default to nodesender - hold for total duration
      sender.startBatch();
      sender.batchTypeKey(key, 0, sender.BATCH_EVENT_KEY_DOWN);
      sender.batchTypeKey(key, totalDurationMs, sender.BATCH_EVENT_KEY_UP);
      await sender.sendBatch();
    }

    lastFiredAtByGift[giftNameLower] = Date.now();
  } catch (err) {
    console.error('Cumulative hold error:', err);
  }
}

async function processGiftStackBatchAhk(giftNameLower, count, key, durationMs) {
  const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
  const ahkKey = mapKeyToAhk(key);
  const titleMatch = targetWindowKeyword;

  // Build a script that presses the key multiple times with minimal delay
  const lines = [];
  lines.push('#SingleInstance Force');
  lines.push('SendMode "Input"');
  lines.push('SetKeyDelay -1, -1');

  if (titleMatch) {
    const safeTitle = escapeAhkString(titleMatch);
    lines.push(`title := "${safeTitle}"`);
    lines.push('h := WinExist(title)');
    lines.push('if (h) {');
    lines.push('  WinActivate "ahk_id " h');
    lines.push('  WinWaitActive "ahk_id " h,,1');
    lines.push('}');
  }

  // Rapid key presses
  const safeKey = sanitizeAhkLabel(ahkKey);
  for (let i = 0; i < count; i++) {
    lines.push(`Send "{${safeKey} down}"`);
    lines.push(`Sleep ${Math.max(1, Math.floor(durationMs))}`);
    lines.push(`Send "{${safeKey} up}"`);
    if (i < count - 1) {
      lines.push('Sleep 10'); // 10ms delay between presses
    }
  }

  lines.push('ExitApp');

  const tmp = path.join(os.tmpdir(), `ttlrl_stack_${Date.now()}_${Math.random().toString(36).slice(2)}.ahk`);
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  await runAhk(ahkPath, tmp);
  try { fs.unlinkSync(tmp); } catch { }
}

async function processGiftStackBatchNodesender(giftNameLower, count, key, durationMs) {
  sender.startBatch();

  for (let i = 0; i < count; i++) {
    const delay = i === 0 ? 0 : 10; // 10ms delay between presses
    sender.batchTypeKey(key, delay, sender.BATCH_EVENT_KEY_DOWN);
    sender.batchTypeKey(key, durationMs, sender.BATCH_EVENT_KEY_UP);
  }

  await sender.sendBatch();
}

function clearGiftStack(giftNameLower) {
  const stack = giftStacks[giftNameLower];
  if (stack) {
    clearTimeout(stack.timeoutId);
    delete giftStacks[giftNameLower];
    console.log(`🗑️ Stack cleared: "${giftNameLower}"`);
  }
}

// Execute a single gift action (extracted from handleGiftByName)
async function executeGiftAction(giftNameLower, action, senderName) {
  const key = String(action.key || '').toLowerCase();
  const durationMs = action.durationSec != null ?
    Math.max(0, Number(action.durationSec) * 1000) :
    Number(action.durationMs || 300);

  const isMouseRight = key === 'right_click' || key === 'mouse_right' || key === 'rmouse';
  const isMouseLeft = key === 'left_click' || key === 'mouse_left' || key === 'lmouse';

  try {
    // Mouse support
    if (isMouseRight || isMouseLeft) {
      const mouseButtonConst = isMouseRight ? sender.BUTTON_RIGHT : sender.BUTTON_LEFT;
      const ahkKey = isMouseRight ? 'RButton' : 'LButton';

      if (currentInjectionMode === 'autohotkey') {
        const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
        const titleMatch = targetWindowKeyword;

        const v2script = buildAhkHoldScriptV2(ahkKey, durationMs, titleMatch);
        const v1script = buildAhkHoldScriptV1(ahkKey, durationMs, titleMatch);

        const tmpV2 = path.join(os.tmpdir(), `ttlrl_mouse_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
        fs.writeFileSync(tmpV2, v2script, 'utf8');
        const v2ok = await runAhk(ahkPath, tmpV2);
        try { fs.unlinkSync(tmpV2); } catch { }
        if (!v2ok) {
          const tmpV1 = path.join(os.tmpdir(), `ttlrl_mouse_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
          fs.writeFileSync(tmpV1, v1script, 'utf8');
          await runAhk(ahkPath, tmpV1);
          try { fs.unlinkSync(tmpV1); } catch { }
        }
        return;
      }

      // nodesender paths
      if (currentInjectionMode === 'nodesender_repeat') {
        const intervalMs = Math.max(5, Number(process.env.REPEAT_INTERVAL_MS || action.repeatIntervalMs || 20));
        const taps = Math.max(1, Math.floor(durationMs / intervalMs));
        sender.startBatch();
        for (let i = 0; i < taps; i++) {
          const wait = i === 0 ? 0 : intervalMs;
          sender.batchMouseClick(mouseButtonConst, wait);
        }
        await sender.sendBatch();
      } else {
        // Single hold click
        sender.startBatch();
        sender.batchPressMouseButton(mouseButtonConst, 0);
        sender.batchReleaseMouseButton(mouseButtonConst, durationMs);
        await sender.sendBatch();
      }
      return;
    }

    // Keyboard support
    if (currentInjectionMode === 'autohotkey') {
      const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
      const ahkKey = mapKeyToAhk(key);
      const titleMatch = targetWindowKeyword;

      const v2script = buildAhkHoldScriptV2(ahkKey, durationMs, titleMatch);
      const v1script = buildAhkHoldScriptV1(ahkKey, durationMs, titleMatch);

      const tmpV2 = path.join(os.tmpdir(), `ttlrl_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
      fs.writeFileSync(tmpV2, v2script, 'utf8');
      const v2ok = await runAhk(ahkPath, tmpV2);
      try { fs.unlinkSync(tmpV2); } catch { }
      if (!v2ok) {
        const tmpV1 = path.join(os.tmpdir(), `ttlrl_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
        fs.writeFileSync(tmpV1, v1script, 'utf8');
        await runAhk(ahkPath, tmpV1);
        try { fs.unlinkSync(tmpV1); } catch { }
      }
    } else {
      sender.startBatch();
      sender.batchTypeKey(key, 0, sender.BATCH_EVENT_KEY_DOWN);
      sender.batchTypeKey(key, durationMs, sender.BATCH_EVENT_KEY_UP);
      await sender.sendBatch();
    }
  } catch (err) {
    console.error('Key press error:', err);
  }
}

async function handleGiftByName(giftNameLower, senderName, countInc = 1) {
  if (isPaused) {
    console.log('Paused; ignoring gift');
    return;
  }
  const action = giftToAction[giftNameLower];
  if (!action) {
    console.log(`No action mapped for gift: ${giftNameLower}`);
    return;
  }

  // Cooldown check (per gift). If cooldownMs is set, ignore gifts arriving sooner than that.
  const cooldownMs = Number(action.cooldownMs || 0);
  if (cooldownMs > 0) {
    const now = Date.now();
    const last = Number(lastFiredAtByGift[giftNameLower] || 0);
    if (now - last < cooldownMs) {
      const waitMs = cooldownMs - (now - last);
      console.log(`Cooldown active for "${giftNameLower}"; ${waitMs}ms remaining`);
      return;
    }
  }

  // Focus guard
  const focus = await checkTargetWindowFocused();
  if (!focus.ok) {
    console.log('Target window not focused; skipping macro');
    broadcast({ type: 'focus-warning', expected: targetWindowKeyword, activeTitle: focus.title, activeOwner: focus.owner });
    return;
  }

  // Check if stacking is enabled for this gift
  const stackingConfig = action.stacking;
  const stackingEnabled = stackingConfig?.enabled && giftStackingEnabled;

  if (stackingEnabled) {
    // Use stacking system
    console.log(`📚 Stacking enabled for "${giftNameLower}", adding to stack (+${countInc})`);
    startGiftStack(giftNameLower, Math.max(1, Number(countInc || 1)));
    return;
  }

  // Original non-stacking logic for backward compatibility
  const key = String(action.key || '').toLowerCase();

  const isMouseRight = key === 'right_click' || key === 'mouse_right' || key === 'rmouse';
  const isMouseLeft = key === 'left_click' || key === 'mouse_left' || key === 'lmouse';

  // If multiple gifts counted in this event, execute multiple times (sequential/batch)
  if (Math.max(1, Number(countInc || 1)) > 1) {
    try {
      // Prefer batch processing for keyboard; for mouse, sequential via executeGiftAction
      const isMouseRight = key === 'right_click' || key === 'mouse_right' || key === 'rmouse';
      const isMouseLeft = key === 'left_click' || key === 'mouse_left' || key === 'lmouse';
      if (!isMouseLeft && !isMouseRight) {
        await processGiftStackBatch(giftNameLower, Math.max(1, Number(countInc || 1)), action);
      } else {
        await processGiftStackSequential(giftNameLower, Math.max(1, Number(countInc || 1)), action);
      }
      lastFiredAtByGift[giftNameLower] = Date.now();
      return;
    } catch (err) {
      console.error('Multi-count gift processing error:', err);
      // Fallback to single execution below
    }
  }

  // Support new durationSec while remaining backward compatible with durationMs
  const durationMs = action.durationSec != null ? Math.max(0, Number(action.durationSec) * 1000) : Number(action.durationMs || 300);

  try {
    if (isMouseRight || isMouseLeft) {
      const mouseButtonConst = isMouseRight ? sender.BUTTON_RIGHT : sender.BUTTON_LEFT;
      const ahkKey = isMouseRight ? 'RButton' : 'LButton';
      const label = isMouseRight ? 'Right-click' : 'Left-click';
      console.log(`${label} for ${durationMs}ms (mode=${currentInjectionMode}) (from ${senderName})`);

      if (currentInjectionMode === 'autohotkey') {
        const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
        const titleMatch = targetWindowKeyword;

        const v2script = buildAhkHoldScriptV2(ahkKey, durationMs, titleMatch);
        const v1script = buildAhkHoldScriptV1(ahkKey, durationMs, titleMatch);

        const tmpV2 = path.join(os.tmpdir(), `ttlrl_mouse_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
        fs.writeFileSync(tmpV2, v2script, 'utf8');
        const v2ok = await runAhk(ahkPath, tmpV2);
        try { fs.unlinkSync(tmpV2); } catch { }
        if (!v2ok) {
          const tmpV1 = path.join(os.tmpdir(), `ttlrl_mouse_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
          fs.writeFileSync(tmpV1, v1script, 'utf8');
          await runAhk(ahkPath, tmpV1);
          try { fs.unlinkSync(tmpV1); } catch { }
        }
        lastFiredAtByGift[giftNameLower] = Date.now();
        return;
      }

      // nodesender paths
      try {
        if (currentInjectionMode === 'nodesender_repeat') {
          // emulate rapid clicks
          const intervalMs = Math.max(5, Number(process.env.REPEAT_INTERVAL_MS || action.repeatIntervalMs || 20));
          const taps = Math.max(1, Math.floor(durationMs / intervalMs));
          sender.startBatch();
          for (let i = 0; i < taps; i++) {
            const wait = i === 0 ? 0 : intervalMs;
            sender.batchMouseClick(mouseButtonConst, wait);
          }
          await sender.sendBatch();
        } else {
          // Single hold click
          sender.startBatch();
          sender.batchPressMouseButton(mouseButtonConst, 0);
          sender.batchReleaseMouseButton(mouseButtonConst, durationMs);
          await sender.sendBatch();
        }
        lastFiredAtByGift[giftNameLower] = Date.now();
      } catch (err) {
        console.error('Mouse right-click error:', err);
      }
      return;
    }

    console.log(`Press key "${key}" for ${durationMs}ms (mode=${currentInjectionMode}) (from ${senderName})`);
    if (currentInjectionMode === 'nutjs') {
      const { keyboard, Key, sleep } = require('@nut-tree/nut-js');
      const map = {
        'enter': Key.Enter,
        'space': Key.Space,
        'w': Key.W,
        'a': Key.A,
        's': Key.S,
        'd': Key.D,
        'up': Key.Up,
        'down': Key.Down,
        'left': Key.Left,
        'right': Key.Right,
      };
      const mapped = map[key];
      if (!mapped) {
        console.warn(`nutjs: unsupported key "${key}"; falling back to node-key-sender`);
      } else {
        await keyboard.pressKey(mapped);
        await sleep(durationMs);
        await keyboard.releaseKey(mapped);
        lastFiredAtByGift[giftNameLower] = Date.now();
        return;
      }
    }

    if (currentInjectionMode === 'autohotkey') {
      const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
      const ahkKey = mapKeyToAhk(key);
      const titleMatch = targetWindowKeyword;

      // Try v2 script first; if it fails, fall back to v1
      const v2script = buildAhkHoldScriptV2(ahkKey, durationMs, titleMatch);
      const v1script = buildAhkHoldScriptV1(ahkKey, durationMs, titleMatch);

      const tmpV2 = path.join(os.tmpdir(), `ttlrl_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
      fs.writeFileSync(tmpV2, v2script, 'utf8');
      const v2ok = await runAhk(ahkPath, tmpV2);
      try { fs.unlinkSync(tmpV2); } catch { }
      if (!v2ok) {
        const tmpV1 = path.join(os.tmpdir(), `ttlrl_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
        fs.writeFileSync(tmpV1, v1script, 'utf8');
        await runAhk(ahkPath, tmpV1);
        try { fs.unlinkSync(tmpV1); } catch { }
      }
      lastFiredAtByGift[giftNameLower] = Date.now();
      return;
    }

    if (currentInjectionMode === 'nodesender_repeat' || String(action.pressMode || '').toLowerCase() === 'repeat') {
      // Build one big batch of rapid key taps spaced by intervalMs
      const intervalMs = Math.max(5, Number(process.env.REPEAT_INTERVAL_MS || action.repeatIntervalMs || 20));
      const taps = Math.max(1, Math.floor(durationMs / intervalMs));
      sender.startBatch();
      for (let i = 0; i < taps; i++) {
        const wait = i === 0 ? 0 : intervalMs;
        sender.batchTypeKey(key, wait, sender.BATCH_EVENT_KEY_PRESS);
      }
      // Safety key up at end
      sender.batchTypeKey(key, 0, sender.BATCH_EVENT_KEY_UP);
      await sender.sendBatch();
      lastFiredAtByGift[giftNameLower] = Date.now();
      return;
    }

    // nodesender hold (default)
    sender.startBatch();
    sender.batchTypeKey(key, 0, sender.BATCH_EVENT_KEY_DOWN);
    sender.batchTypeKey(key, durationMs, sender.BATCH_EVENT_KEY_UP);
    await sender.sendBatch();
    lastFiredAtByGift[giftNameLower] = Date.now();
  } catch (err) {
    console.error('Key press error:', err);
  }
}

// --- Security Sanitization Helpers ---

/**
 * Escapes a string for use inside an AHK double-quoted string literal.
 * In AHK, double quotes are escaped by doubling them ("").
 */
function escapeAhkString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/"/g, '""');
}

/**
 * Sanitizes a key label or window title keyword to prevent escaping the AHK command context.
 * For keys used inside {}, we only allow alphanumeric characters and basic punctuation.
 */
function sanitizeAhkLabel(str) {
  if (typeof str !== 'string') return '';
  // Only allow alphanumeric, space, and a few safe punctuation characters
  return str.replace(/[^a-zA-Z0-9\s_\-\[\]]/g, '');
}

function mapKeyToAhk(key) {
  const simple = {
    'enter': 'Enter',
    'space': 'Space',
    'w': 'w', 'a': 'a', 's': 's', 'd': 'd',
    'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    // Mouse buttons
    // Mouse left/right aliases
    'left_click': 'LButton',
    'mouse_left': 'LButton',
    'right_click': 'RButton',
    'mouse_right': 'RButton',
  };
  const mapped = simple[key] || key;
  return sanitizeAhkLabel(mapped);
}

function buildAhkHoldScriptV1(ahkKey, durationMs, titleKeyword) {
  const safeKey = sanitizeAhkLabel(ahkKey);
  const safeTitle = escapeAhkString(titleKeyword);
  const lines = [];
  lines.push('SetTitleMatchMode, 2');
  lines.push('SendMode, Input');
  lines.push('SetKeyDelay, -1, -1');
  if (titleKeyword) {
    lines.push(`title := "${safeTitle}"`);
    lines.push('IfWinExist, %title%');
    lines.push('{');
    lines.push('  WinActivate, %title%');
    lines.push('  WinWaitActive, %title%,,1');
    lines.push('}');
  }
  lines.push(`Send, {${safeKey} down}`);
  lines.push(`Sleep, ${Math.max(0, Math.floor(durationMs))}`);
  lines.push(`Send, {${safeKey} up}`);
  lines.push('ExitApp');
  return lines.join('\n');
}

function buildAhkHoldScriptV2(ahkKey, durationMs, titleKeyword) {
  const safeKey = sanitizeAhkLabel(ahkKey);
  const safeTitle = escapeAhkString(titleKeyword);
  const lines = [];
  lines.push('#SingleInstance Force');
  lines.push('SendMode "Input"');
  lines.push('SetKeyDelay -1, -1');
  if (titleKeyword) {
    lines.push(`title := "${safeTitle}"`);
    lines.push('h := WinExist(title)');
    lines.push('if (h) {');
    lines.push('  WinActivate "ahk_id " h');
    lines.push('  WinWaitActive "ahk_id " h,,1');
    lines.push('}');
  }
  lines.push(`Send "{${safeKey} down}"`);
  lines.push(`Sleep ${Math.max(0, Math.floor(durationMs))}`);
  lines.push(`Send "{${safeKey} up}"`);
  lines.push('ExitApp');
  return lines.join('\n');
}

function runAhk(ahkPath, scriptPath) {
  return new Promise((resolve) => {
    const p = spawn(ahkPath, [scriptPath]);
    let resolved = false;
    p.on('exit', (code) => { if (!resolved) { resolved = true; resolve(code === 0); } });
    p.on('error', () => { if (!resolved) { resolved = true; resolve(false); } });
  });
}

async function runAhkSequence(steps) {
  // Build a minimal AHK v2 script first
  const titleKeyword = targetWindowKeyword;
  const safeTitle = escapeAhkString(titleKeyword);
  const lines = [];
  lines.push('#SingleInstance Force');
  lines.push('SendMode "Input"');
  lines.push('SetKeyDelay -1, -1');
  if (titleKeyword) {
    lines.push(`title := "${safeTitle}"`);
    lines.push('h := WinExist(title)');
    lines.push('if (h) {');
    lines.push('  WinActivate "ahk_id " h');
    lines.push('  WinWaitActive "ahk_id " h,,1');
    lines.push('}');
  }
  for (const s of steps) {
    const delay = Math.max(0, Number(s.delayMs || 0));
    const safeKey = sanitizeAhkLabel(String(s.key || '').toLowerCase());
    const ahkKey = mapKeyToAhk(safeKey);

    if (s.kind === 'keyTap') {
      lines.push(`Sleep ${delay}`);
      lines.push(`Send "{${ahkKey}}"`);
    } else if (s.kind === 'keyDown') {
      lines.push(`Sleep ${delay}`);
      lines.push(`Send "{${ahkKey} down}"`);
    } else if (s.kind === 'keyUp') {
      lines.push(`Sleep ${delay}`);
      lines.push(`Send "{${ahkKey} up}"`);
    } else if (s.kind === 'text') {
      lines.push(`Sleep ${delay}`);
      // Escape for AHK string
      const text = escapeAhkString(String(s.text || ''));
      lines.push(`Send "${text}"`);
    } else if (s.kind === 'wait') {
      lines.push(`Sleep ${delay}`);
    } else if (s.kind === 'combo' && Array.isArray(s.keys)) {
      lines.push(`Sleep ${delay}`);
      const safeKeys = s.keys.map(k => mapKeyToAhk(String(k || '').toLowerCase()));
      // AHK combo send as down then up in order
      for (const k of safeKeys) lines.push(`Send "{${k} down}"`);
      for (let i = safeKeys.length - 1; i >= 0; i--) lines.push(`Send "{${safeKeys[i]} up}"`);
    }
  }
  lines.push('ExitApp');

  const ahkPath = process.env.AHK_PATH || 'AutoHotkey.exe';
  const v2 = lines.join('\n');
  const tmp = path.join(os.tmpdir(), `ttlrl_seq_${Date.now()}_${Math.random().toString(36).slice(2)}_v2.ahk`);
  fs.writeFileSync(tmp, v2, 'utf8');
  const ok = await runAhk(ahkPath, tmp);
  try { fs.unlinkSync(tmp); } catch { }
  if (ok) return;

  // Fallback to v1
  const v1 = v2
    .replaceAll('SendMode "Input"', 'SendMode, Input')
    .replaceAll('SetKeyDelay -1, -1', 'SetKeyDelay, -1, -1')
    .replaceAll('Sleep ', 'Sleep, ')
    .replaceAll('Send "', 'Send, "');
  const tmp1 = path.join(os.tmpdir(), `ttlrl_seq_${Date.now()}_${Math.random().toString(36).slice(2)}_v1.ahk`);
  fs.writeFileSync(tmp1, v1, 'utf8');
  await runAhk(ahkPath, tmp1);
  try { fs.unlinkSync(tmp1); } catch { }
}

async function runNodesenderSequence(steps) {
  sender.startBatch();
  for (const s of steps) {
    const delay = Math.max(0, Number(s.delayMs || 0));
    if (s.kind === 'keyTap') {
      sender.batchTypeKey(String(s.key || '').toLowerCase(), delay, sender.BATCH_EVENT_KEY_PRESS);
    } else if (s.kind === 'keyDown') {
      sender.batchTypeKey(String(s.key || '').toLowerCase(), delay, sender.BATCH_EVENT_KEY_DOWN);
    } else if (s.kind === 'keyUp') {
      sender.batchTypeKey(String(s.key || '').toLowerCase(), delay, sender.BATCH_EVENT_KEY_UP);
    } else if (s.kind === 'text') {
      // Split batch: send accumulated, then send text, then restart batch
      await sender.sendBatch();
      await sender.sendText(String(s.text || ''));
      sender.startBatch();
    } else if (s.kind === 'wait') {
      // Represent as a no-op press on a benign key with wait only
      sender.batchTypeKey('enter', delay, sender.BATCH_EVENT_KEY_PRESS);
    } else if (s.kind === 'combo' && Array.isArray(s.keys)) {
      // Fallback: down then up in reverse
      for (let i = 0; i < s.keys.length; i++) sender.batchTypeKey(String(s.keys[i] || '').toLowerCase(), i === 0 ? delay : 0, sender.BATCH_EVENT_KEY_DOWN);
      for (let i = s.keys.length - 1; i >= 0; i--) sender.batchTypeKey(String(s.keys[i] || '').toLowerCase(), 0, sender.BATCH_EVENT_KEY_UP);
    }
  }
  await sender.sendBatch();
}

// HTTP server removed; no static catalog endpoints. All data comes from live events.


