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

const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { fetchActivePlayer, fetchPlayerList } = require('./lib/liveClientHttp.js');
const { loadLane, saveLane, VALID_LANES } = require('./lib/laneSettings.js');
const {
  parseLevelAndAbilities,
  extractLocalRiotId,
  resolveChampionName,
  extractLocalPosition,
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

// TOP/JUNGLE/MID/BOT/SUPPORT with the exact labels the tray menu shows.
// Mirrors js/skillOrderData.js's LANE_TO_ROLE_ID key order/spelling -- kept as
// a small literal here rather than importing that ESM module into this
// CommonJS main process (see lib/gameState.js's header for why the two
// module systems don't mix directly).
const LANE_MENU_ITEMS = [
  { lane: 'TOP', label: 'Top' },
  { lane: 'JUNGLE', label: 'Jungle' },
  { lane: 'MID', label: 'Mid' },
  { lane: 'BOT', label: 'Bot' },
  { lane: 'SUPPORT', label: 'Support' },
];

const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray-icon.png');

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let isInteractive = false; // starts click-through
let overlayVisibleWanted = true;
let inGame = false;
const userDataDir = app.getPath('userData');
let currentLane = loadLane(userDataDir); // string lane, or null = "Auto"
let gameState = mergeState(emptyStateFor(false), { lane: currentLane });
let lastKnownRiotId = null;
let positionLoggedThisGame = false; // logs the raw detected `position` ONCE per game

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
// Lane — MAIN PROCESS owns the OVERRIDE now (2026-07-27 fix, see
// HANDOFF-engy.md rounds 4-5). Persisted to a JSON file (lib/laneSettings.js),
// not localStorage: the renderer's `file://` origin makes localStorage
// unreliable across restarts, and with the Overwolf desktop window gone there
// was nothing left to ever write the key in the first place -- the lane was
// PERMANENTLY unset.
//
// RESOLUTION ORDER (corrected 2026-07-27 -- auto-detect is now PRIMARY, not a
// last resort): `currentLane` here is a MANUAL OVERRIDE ONLY -- null means
// "no override, defer to auto-detection." The actual lane shown is resolved
// in the RENDERER (js/skillOrderData.js's resolveOverlayData), which prefers
// this override when set, else maps the local player's own
// `detectedPosition` (below) to a lane, else falls back to trying each real
// lane in a fixed order. `lane` (override) and `detectedPosition` (raw
// observation) both travel as fields on the same `gameState` object pushed
// over 'coachbuild-state' -- one contract, not two channels.

function setLane(nextLane) {
  currentLane = saveLane(userDataDir, nextLane);
  log('lane OVERRIDE set to', currentLane === null ? 'Auto (cleared -- defers to auto-detection)' : currentLane);
  gameState = mergeState(gameState, { lane: currentLane });
  pushState();
  rebuildTrayMenu();
}

ipcMain.on('coachbuild-set-lane', (_event, lane) => {
  setLane(lane);
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
      positionLoggedThisGame = false;
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
      // `lane` (the manual override) deliberately survives a game exit --
      // it's a user preference, not per-game state. Only session-scoped
      // fields reset.
      gameState = mergeState(emptyStateFor(false), { lane: currentLane });
      lastKnownRiotId = null;
      positionLoggedThisGame = false;
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
    // Compliance: resolveChampionName()/extractLocalPosition() ONLY ever read
    // the ONE entry matching our own riotId -- the local player's own
    // champion and own assigned role. `playerList` (which includes every
    // other player) is discarded here and never stored, logged, or rendered
    // beyond that single lookup. Both reads come off this ONE fetch -- no
    // extra request for position.
    const championName = resolveChampionName(playerList, riotId);
    const detectedPosition = extractLocalPosition(playerList, riotId);

    const patch = {};
    if (championName) patch.championName = championName;
    if (detectedPosition !== null) patch.detectedPosition = detectedPosition;

    if (Object.keys(patch).length > 0) {
      gameState = mergeState(gameState, patch);
      pushState();
    }

    // Logged ONCE per game, regardless of value -- "NONE" is a legitimate,
    // informative answer (expected in Practice Tool/customs), not something
    // to keep re-logging. See lib/gameState.js's extractLocalPosition header:
    // only "NONE" has actually been observed on this machine; a real role in
    // a matchmade game is Riot's documented behaviour, not yet verified here.
    // This line is what turns the next real match into that verification.
    if (!positionLoggedThisGame && detectedPosition !== null) {
      positionLoggedThisGame = true;
      log(`detected local player position (raw, from /liveclientdata/playerlist): "${detectedPosition}"`);
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (overlayVisibleWanted) {
      mainWindow.showInactive();
      pushState(); // resend last known state so it isn't blank on reappear
    } else {
      mainWindow.hide();
    }
  }
  rebuildTrayMenu();
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
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Elevation heuristic — global hotkeys are expected to be UNRELIABLE while
// League has focus, because League/Vanguard runs elevated and Windows UIPI
// does not deliver global hotkey input from a lower-integrity process to a
// higher-integrity foreground window. This is why the tray (below) is the
// PRIMARY fix, not the hotkeys.
// ---------------------------------------------------------------------------
//
// There is no reliable, dependency-free way to definitively detect "is this
// process elevated" from Node on Windows (no is-elevated package -- that
// would be a new dependency, disallowed). This is a BEST-EFFORT heuristic
// only, explicitly logged as such -- never asserted as certain. It attempts
// to write a throwaway file into a normally-protected system directory;
// success is weak evidence of elevation, failure is weak evidence against it.
// UAC virtualization can make this unreliable in either direction, which is
// exactly why the log line hedges instead of stating a verdict.
function bestEffortElevationGuess() {
  const probePath = path.join('C:', 'Windows', 'coachbuild-elevation-probe.tmp');
  try {
    fs.writeFileSync(probePath, 'probe');
    fs.unlinkSync(probePath);
    return 'possibly elevated (could write to C:\\Windows)';
  } catch {
    return 'most likely NOT elevated (could not write to C:\\Windows)';
  }
}

function logElevationGuidance() {
  const guess = bestEffortElevationGuess();
  log(`elevation check (best-effort, not certain): ${guess}`);
  log('if Ctrl+F10/Ctrl+F11 do not respond while League has focus, this is the expected cause -- use the SYSTEM TRAY ICON instead (works regardless of elevation), or relaunch via "npm run start:admin" / right-click this app -> Run as administrator.');
}

// ---------------------------------------------------------------------------
// System tray — the PRIMARY fix for the hotkey deadlock. Reachable from the
// Windows notification area even while League is fullscreen-borderless and
// focused, and does not depend on the elevation question at all.
// ---------------------------------------------------------------------------

function buildTrayMenuTemplate() {
  const laneSubmenu = [
    {
      label: 'Auto (let the app detect / pick)',
      type: 'radio',
      checked: currentLane === null,
      click: () => setLane(null),
    },
    { type: 'separator' },
    ...LANE_MENU_ITEMS.map(({ lane, label }) => ({
      label,
      type: 'radio',
      checked: currentLane === lane,
      click: () => setLane(lane),
    })),
  ];

  return [
    {
      label: overlayVisibleWanted ? 'Hide overlay' : 'Show overlay',
      click: () => toggleOverlayVisibility(),
    },
    {
      label: 'Interactive mode (clickable)',
      type: 'checkbox',
      checked: isInteractive,
      click: () => toggleInteractive(),
    },
    { type: 'separator' },
    {
      label: 'Lane override',
      submenu: laneSubmenu,
    },
    { type: 'separator' },
    {
      label: 'Quit CoachBuild Overlay',
      click: () => app.quit(),
    },
  ];
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
}

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(TRAY_ICON_PATH);
    if (icon.isEmpty()) throw new Error('tray icon decoded empty');
  } catch (err) {
    warn('failed to load tray icon, falling back to a blank image:', err.message);
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('CoachBuild Overlay');
  rebuildTrayMenu();
  // Left-click also toggles show/hide, matching how most tray utilities
  // behave -- the menu (right-click, or left-click depending on platform
  // convention) covers everything else.
  tray.on('click', () => toggleOverlayVisibility());
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
    log(`lane override at startup: ${currentLane === null ? 'Auto (none set)' : currentLane}`);
    createWindow();
    createTray();
    registerHotkeys();
    logElevationGuidance();
    schedulePoll();
  });

  // A tray-only app should NOT quit when its (taskbar-invisible, non-closable
  // via any window-chrome button since frame:false) window "closes" -- there
  // is no user-facing close button on this window at all, so window-all-closed
  // firing here would only ever mean the process crashed the window
  // unexpectedly. Quitting is still correct in that case; it's just no longer
  // the ONLY way to quit now that the tray has its own Quit item.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearTimeout(pollTimer);
    stopPlayerListPolling();
    if (tray && !tray.isDestroyed()) tray.destroy();
  });
}
