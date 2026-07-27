// CoachBuild Overlay Host — Electron main process.
//
// Replaces the Overwolf app (see HANDOFF-engy.md's 2026-07-27 "PIVOT" entry for
// why: Overwolf requires developer-whitelist approval that mandates integrating
// Overwolf ads/subscriptions, which this personal one-machine tool cannot and
// should not clear). This file owns everything the old background.js owned:
//   - the always-on-top overlay window's lifecycle
//   - polling Riot's Live Client Data API directly (no GEP, no Overwolf)
//   - both global hotkeys (must work while League has focus)
//   - pushing state to the renderer over Electron IPC
//   - the readiness handshake
//
// Everything game-shape-specific (parsing, the Passive-key exclusion, the
// all-or-nothing rule, riotId-matched champion-name resolution) lives in
// lib/gameState.js, ported verbatim in logic from the Overwolf build's
// overwolf/js/gameState.js and already verified against the real captured
// Practice Tool payload (see that file's header + HANDOFF-engy.md).

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');

const { fetchActivePlayer, fetchPlayerList } = require('./lib/liveClientHttp.js');
const {
  parseLevelAndAbilities,
  extractLocalRiotId,
  resolveChampionName,
  mergeState,
  emptyStateFor,
} = require('./lib/gameState.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Same reasoning as the Overwolf build's manifest.README.md "Overlay position"
// note, ported verbatim: upper-left, clear of the minimap + shop panel
// (bottom-right), the ability/item bar (bottom-center), the
// scoreboard/kill-feed/objective banners (top-center/top-right), and the chat
// log (bottom-left). Still NOT verified against an actual rendered game window
// on this machine -- general LoL HUD-layout knowledge, not an observed
// screenshot. First thing worth checking in a live test.
const OVERLAY_WIDTH = 340;
const OVERLAY_HEIGHT = 520;
const OVERLAY_TOP = 110;
const OVERLAY_LEFT = 24;

const HOTKEY_TOGGLE_OVERLAY = 'Control+F10';
const HOTKEY_TOGGLE_INTERACTIVE = 'Control+F11';

// Poll less often when idle (no game) so this never spins the CPU or hammers
// the loopback socket while the user is just browsing/queuing. Faster while a
// game is live so a level-up shows up promptly.
const IDLE_POLL_MS = 5000;
const ACTIVE_POLL_MS = 1500;
const PLAYERLIST_POLL_MS = 4000;

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

let mainWindow = null;
let isInteractive = false; // starts click-through
let overlayVisibleWanted = true;
let inGame = false;
let gameState = emptyStateFor(false);
let lastKnownRiotId = null;

let pollTimer = null;
let playerListTimer = null;

function log(...args) {
  console.log('[CoachBuild:main]', ...args);
}
function warn(...args) {
  console.warn('[CoachBuild:main]', ...args);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const display = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: display.bounds.x + OVERLAY_LEFT,
    y: display.bounds.y + OVERLAY_TOP,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // the window must never steal focus from the game
    hasShadow: false,
    show: false, // shown via 'ready-to-show' -> showInactive(), see below
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 'screen-saver' is the level that actually stays drawn above a full-screen
  // game on Windows -- the default always-on-top level does not reliably beat
  // a game's own render surface. Set explicitly rather than relying on the
  // constructor's plain `alwaysOnTop: true` alone.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Click-through by default, matching the Overwolf build's `clickthrough:
  // true` initial window style. `forward: true` lets the OS still deliver
  // move/enter/leave events needed for correct rendering without capturing
  // clicks -- same intent as Overwolf's InputPassThrough, different API.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.once('ready-to-show', () => {
    // showInactive(), not show() -- this window is `focusable: false`; calling
    // the normal show() risks attempting to activate/focus it (undefined
    // behavior on a non-focusable window on some platforms). showInactive()
    // is the documented way to display a window without ever taking focus.
    if (overlayVisibleWanted) {
      mainWindow.showInactive();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'ingame.html'));
}

// ---------------------------------------------------------------------------
// IPC — pushing state to the renderer, and the readiness handshake
// ---------------------------------------------------------------------------
//
// webContents.send() is fire-and-forget, exactly like Overwolf's sendMessage
// was -- a push sent before the renderer's preload+script finished loading is
// dropped, not buffered. Same fix as before: the renderer announces itself via
// the 'coachbuild-ready' channel once its listener is attached, and this
// process answers with the current snapshot.

function pushState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('coachbuild-state', gameState);
}

function pushInteractiveChange() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('coachbuild-interactive', isInteractive);
}

ipcMain.on('coachbuild-ready', () => {
  log('renderer announced ready — replaying current state');
  pushState();
  pushInteractiveChange();
});

// ---------------------------------------------------------------------------
// Polling Riot's Live Client Data API directly (no GEP, no Overwolf)
// ---------------------------------------------------------------------------
//
// There is no separate "is League running" check: a successful call to
// /liveclientdata/activeplayer IS the definition of "in game" here.
// ECONNREFUSED (no game) is the NORMAL state and is silent by design — never
// surfaced as an error, never a dialog.

async function pollActivePlayer() {
  try {
    const activePlayer = await fetchActivePlayer();

    if (!inGame) {
      inGame = true;
      log('game detected — entering session');
      startPlayerListPolling();
    }

    const parsed = parseLevelAndAbilities(activePlayer);
    if (parsed) {
      gameState = mergeState(gameState, {
        inGame: true,
        championLevel: parsed.level,
        abilityRanks: parsed.abilityRanks,
      });
      pushState();
    }

    const riotId = extractLocalRiotId(activePlayer);
    if (riotId) {
      const isNewRiotId = riotId !== lastKnownRiotId;
      lastKnownRiotId = riotId;
      if (isNewRiotId || !gameState.championName) {
        // Fast-path: try to resolve champion name immediately once we have a
        // riotId, rather than waiting for the next poll tick.
        resolveChampionNameNow(riotId);
      }
    }
  } catch (err) {
    // Any failure here (connection refused, timeout, non-2xx, bad JSON) is
    // treated identically: no game running right now. This is deliberate —
    // Riot's API gives no richer signal than "reachable or not," and treating
    // any subset of failures as "real errors" risks flashing an error state
    // during the ordinary in-game load screen.
    if (inGame) {
      inGame = false;
      log('game no longer detected — ending session');
      stopPlayerListPolling();
      gameState = emptyStateFor(false);
      lastKnownRiotId = null;
      pushState();
    }
  } finally {
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollActivePlayer, inGame ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

function startPlayerListPolling() {
  stopPlayerListPolling();
  playerListTimer = setInterval(pollPlayerList, PLAYERLIST_POLL_MS);
}

function stopPlayerListPolling() {
  if (playerListTimer) {
    clearInterval(playerListTimer);
    playerListTimer = null;
  }
}

async function pollPlayerList() {
  if (!inGame || gameState.championName || !lastKnownRiotId) return;
  await resolveChampionNameNow(lastKnownRiotId);
}

async function resolveChampionNameNow(riotId) {
  try {
    const playerList = await fetchPlayerList();
    // Compliance: resolveChampionName() only ever reads the ONE entry
    // matching our own riotId; `playerList` (which includes every other
    // player) is discarded here and never stored, logged, or rendered beyond
    // that single lookup.
    const championName = resolveChampionName(playerList, riotId);
    if (championName) {
      gameState = mergeState(gameState, { championName });
      pushState();
    }
  } catch (err) {
    // Expected transiently (endpoint not fully up yet at the very start of a
    // match) — never surfaced to the user, just retried on the next tick.
    log('playerlist fetch not ready yet:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Hotkeys — global, so they work while League has focus.
// ---------------------------------------------------------------------------

function registerHotkeys() {
  const okOverlay = globalShortcut.register(HOTKEY_TOGGLE_OVERLAY, toggleOverlayVisibility);
  const okInteractive = globalShortcut.register(HOTKEY_TOGGLE_INTERACTIVE, toggleInteractive);
  if (!okOverlay) warn(`failed to register hotkey ${HOTKEY_TOGGLE_OVERLAY} — likely already bound by another app`);
  if (!okInteractive) warn(`failed to register hotkey ${HOTKEY_TOGGLE_INTERACTIVE} — likely already bound by another app`);
  if (okOverlay && okInteractive) log(`hotkeys registered: ${HOTKEY_TOGGLE_OVERLAY} (show/hide), ${HOTKEY_TOGGLE_INTERACTIVE} (interactive toggle)`);
}

function toggleOverlayVisibility() {
  overlayVisibleWanted = !overlayVisibleWanted;
  log('toggle_overlay ->', overlayVisibleWanted ? 'show' : 'hide');
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (overlayVisibleWanted) {
    mainWindow.showInactive();
    pushState(); // resend last known state so it isn't blank on reappear
  } else {
    mainWindow.hide();
  }
}

function toggleInteractive() {
  isInteractive = !isInteractive;
  log('toggle_interactive ->', isInteractive ? 'interactive (clickable)' : 'clickthrough');
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Equivalent intent to the Overwolf build's setWindowStyle/removeWindowStyle
    // with WindowStyle.InputPassThrough — ported to Electron's own API, not a
    // literal translation of the Overwolf call.
    mainWindow.setIgnoreMouseEvents(!isInteractive, { forward: !isInteractive });

    // FOCUSABILITY MUST FOLLOW INTERACTIVITY, and this is the non-obvious half.
    //
    // The window is created `focusable: false` so it can never steal focus from
    // the game — correct, and load-bearing, for the 99% of the time it is a
    // read-only table. But on Windows that maps to WS_EX_NOACTIVATE, and a
    // non-activatable window does not reliably deliver clicks to DOM controls:
    // letting mouse events through via setIgnoreMouseEvents(false) is necessary
    // but NOT sufficient. Toggling only the former would produce the single
    // worst failure this overlay could have — the lane buttons LOOK pressable
    // (the interactive badge is showing, the affordances are on) and silently
    // do nothing.
    //
    // That matters more here than it would elsewhere: for a one-monitor user
    // this control is the only way to correct a wrong lane without leaving the
    // game, and a wrong lane means a wrong skill path for the whole match.
    //
    // So focus is granted only for the duration of interactive mode, and handed
    // straight back. `setFocusable` is supported on Windows and macOS; guarded
    // because it is absent on some platforms.
    if (typeof mainWindow.setFocusable === 'function') {
      mainWindow.setFocusable(isInteractive);
    }
    if (isInteractive) {
      // Without an explicit focus() the freshly-focusable window still sits
      // unactivated, so the first click would be spent activating it rather than
      // hitting the button under the cursor.
      mainWindow.focus();
    }
  }
  pushInteractiveChange();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance lock — an always-on-top overlay is meaningless duplicated;
// a second launch should hand off to the first instance, not draw a second
// window on top of it.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log('another instance is already running — quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second instance launched — ignoring (this instance keeps running)');
  });

  app.whenReady().then(() => {
    log('CoachBuild Overlay Host starting');
    createWindow();
    registerHotkeys();
    schedulePoll();
  });

  app.on('window-all-closed', () => {
    // This is a single-purpose overlay utility, not a general app — no reason
    // to keep the process alive with no window (the macOS "apps stay open"
    // convention doesn't apply to a Windows-only tool built for this repo's
    // dev machine).
    app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearTimeout(pollTimer);
    stopPlayerListPolling();
  });
}
