// CoachBuild Overlay Host — Electron main process.
//
// Replaces the Overwolf app (see HANDOFF-engy.md's 2026-07-27 "PIVOT" entry for
// why: Overwolf requires developer-whitelist approval that mandates integrating
// Overwolf ads/subscriptions, which this personal one-machine tool cannot and
// should not clear). This file owns everything the old background.js owned:
//   - the always-on-top overlay window's lifecycle (now FULLSCREEN, see below)
//   - polling Riot's Live Client Data API directly (no GEP, no Overwolf)
//   - both global hotkeys (must work while League has focus)
//   - pushing state to the renderer over Electron IPC
//   - the readiness handshake
//   - the calibration window + geometry persistence (2026-07-27 round)
//   - the system tray (primary control surface, and now calibration entry)
//
// Everything game-shape-specific (parsing, the Passive-key exclusion, the
// all-or-nothing rule, riotId-matched champion-name resolution) lives in
// lib/gameState.js, ported verbatim in logic from the Overwolf build's
// overwolf/js/gameState.js and already verified against the real captured
// Practice Tool payload (see that file's header + HANDOFF-engy.md).
//
// ─────────────────────────────────────────────────────────────────────────────
// SEPARATION OF CONCERNS (and a compliance note, stated accurately).
//
// This file computes and persists ONLY geometry: WHERE the four ability-icon
// boxes sit on screen. WHICH ability is highlighted is decided renderer-side
// by `lib/nextSkill.ts`'s `resolveNextSkill` (bundled into
// `overlay-host/vendor/skillEngine.js`). That split is a clean architectural
// boundary and worth keeping: geometry is a display concern, the
// recommendation is a data concern, and they change for different reasons.
//
// CORRECTION TO A PRIOR VERSION OF THIS COMMENT, which claimed this project's
// CHANGELOG "already ruled out" in-HUD ability highlighting on POLICY grounds
// and cited v0.65.0. It does not, and a false precedent in a load-bearing
// comment is worse than no comment. What v0.65.0 actually says is a TECHNICAL
// SCOPE statement: "nothing is drawn inside the game. That is impossible --
// the LCU has no ability/skill endpoint (970 checked) and structurally cannot
// ... Every app that appears to highlight abilities in the HUD is drawing an
// Overwolf-style overlay over the game, which stays out of scope here." That
// is "we cannot do this from the LCU, so it is out of scope", not "policy
// forbids it". Do not cite it as a policy ruling.
//
// The REAL policy tension is genuine and independently verified verbatim at
// https://developer.riotgames.com/docs/lol -- Riot approves "Game overlays
// that provide static data that is available prior to the game" and bans
// "Apps that dictate player decisions". A passive 1-18 table sits comfortably
// in the first category; a marker on the live ability bar at the moment a
// point becomes available sits closer to the second. That was raised
// explicitly with the user, who asked for this feature anyway. It is a
// personal, single-machine, unpublished tool and the call is theirs to make.
// Recorded here so the reasoning is legible, not re-litigated every round.
//
// What has NOT changed: no enemy or other-player information is ever read or
// displayed. The player list is fetched solely to find the local player's own
// champion by riotId. That line is not the user's to move, and it stays.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { fetchActivePlayer, fetchPlayerList } = require('./lib/liveClientHttp.js');
const { loadLane, saveLane, VALID_LANES } = require('./lib/laneSettings.js');
const { readSettingsFile, writeSettingsPatch } = require('./lib/settingsFile.js');
const { loadCalibration, saveCalibration } = require('./lib/calibrationSettings.js');
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

// FULLSCREEN (2026-07-27 round -- replaces the old 340x520 upper-left panel).
// To draw a highlight box over the real ability icons at the bottom-centre of
// the game, the window must cover the WHOLE primary display, not a corner
// panel. Uses `display.bounds`, deliberately NOT `workArea` -- a running game
// covers the taskbar, so the taskbar-excluded workArea would leave a
// window-sized gap right where a fullscreen game actually renders.
//
// The old top-left skill TABLE (`renderer/ingame.html`'s existing panel) is
// NOT deleted -- it's good, working, already-verified-live code, kept behind
// a tray toggle (`showSkillTable`, default OFF this round) exactly as
// instructed ("instead of", not "delete"). It still renders inside this same
// fullscreen window at its own fixed position; engo's renderer code decides
// whether to paint it based on the pushed `calibration.showTable` flag (see
// buildCalibrationPayload() -- nested there, not a top-level field, to match
// what ingame.js actually reads).
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray-icon.png');
const CALIBRATE_PRELOAD_PATH = path.join(__dirname, 'calibratePreload.js');

// Fully transparent (alpha 0) explicitly, in addition to `transparent: true`
// on the constructor -- a known Electron/Chromium gotcha is a fullscreen
// transparent window painting a faint grey/white sheet instead of true
// transparency unless the background colour is pinned to full-zero-alpha.
// Verified this round that it renders genuinely invisible when idle (see
// HANDOFF-engy.md) -- kept explicit rather than relying on `transparent: true`
// alone in case that verification doesn't hold on a different Windows build.
const TRANSPARENT_BACKGROUND_COLOR = '#00000000';

const HOTKEY_TOGGLE_OVERLAY = 'Control+F10';
const HOTKEY_TOGGLE_INTERACTIVE = 'Control+F11';
// Adjust-in-place mode (2026-07-27 round 8) -- see the big comment block near
// toggleAdjustOverlay() for why this exists and replaces the separate
// calibration window as the PRIMARY alignment path.
//
// CHANGED (2026-07-27 round 9) from 'Control+F12' -- ROOT CAUSE of "Ctrl+F12
// does nothing, even genuinely elevated": F12 is PERMANENTLY reserved by
// Windows for the debugger, verbatim from Microsoft's own RegisterHotKey
// docs: "F12 is reserved for use by the debugger at all times, so it should
// not be registered as a hot key. Even when you are not debugging an
// application, F12 is reserved in case a kernel-mode debugger or a
// just-in-time debugger is resident."
// (https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)
// Electron's globalShortcut is a thin wrapper over RegisterHotKey, so
// register('...F12', ...) returns false on EVERY Windows machine,
// unconditionally -- elevation was never the mechanism. See
// registerHotkeys()'s guard below, which now refuses to even attempt
// registering any accelerator containing F12 and fails loudly instead of
// silently, so this exact mistake can't recur invisibly.
// Control+Shift+A chosen as the replacement: not reserved by Windows, not a
// League of Legends default keybind, and mnemonic (A for Adjust). Deliberately
// NOT Control+Q/W/E/R -- those are League's own ability-level binds.
const HOTKEY_TOGGLE_ADJUST = 'Control+Shift+A';

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

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let isInteractive = false; // starts click-through
let isAdjustingOverlay = false; // adjust-in-place mode, see toggleAdjustOverlay()
let overlayVisibleWanted = true;
let inGame = false;
// Computed once at startup (not re-checked live) and surfaced in the tray menu
// AND the startup log -- see logElevationGuidance(). A guess, never a certainty
// (see bestEffortElevationGuess()'s own header), but "computed once" is correct:
// elevation cannot change mid-process, only across a relaunch (e.g. start:admin).
let elevationGuessText = null;
// Per-hotkey bind status, populated by registerHotkeys() -- read by
// buildTrayMenuTemplate() so a dead hotkey is visible in the tray, not just
// the log file. [{accel, label, registered, reservedByWindows}]
let hotkeyRegistrationResults = [];
const userDataDir = app.getPath('userData');
// File logging (2026-07-27 round 9) -- `npm run start:admin` launches detached
// with NO console, and a PACKAGED app has no console at all, so console.log
// alone was silently discarding every diagnostic exactly when it mattered
// most (the Ctrl+F12-doesn't-fire investigation -- see HOTKEY_TOGGLE_ADJUST's
// header for the actual root cause, a reserved key, found after this file's
// logging shipped). Tees
// log()/warn() to this file, console output UNCHANGED alongside it.
//
// Bounded by TRUNCATING AT STARTUP, not rolling mid-run -- chosen over a
// ~1MB rolling log because this is a per-launch diagnostic file, not a
// historical audit trail: the intended workflow is relaunch, reproduce the
// bug, then read this file, so one run's worth of lines is exactly the right
// amount of history and there is no risk of unbounded growth across many
// sessions sitting untouched.
const LOG_FILE_PATH = path.join(userDataDir, 'coachbuild-overlay.log');
let currentLane = loadLane(userDataDir); // string lane, or null = "Auto"
// UI toggle, not per-game state -- loaded here (fs-only, safe before
// app.whenReady) same as currentLane. Defaults OFF this round: the table is
// kept, not deleted, but the highlight box (engo's renderer work) is the new
// primary surface. See buildTrayMenuTemplate() for the toggle.
let showSkillTable = readSettingsFile(userDataDir).showSkillTable === true;
let gameState = mergeState(emptyStateFor(false), { lane: currentLane, calibration: null });
let lastKnownRiotId = null;
let positionLoggedThisGame = false; // logs the raw detected `position` ONCE per game

let pollTimer = null;
let playerListTimer = null;

// Calibration -- geometry itself is loaded inside app.whenReady() (it needs
// `screen.getPrimaryDisplay()`, which Electron does not allow calling before
// the app is ready; unlike `app.getPath`/`fs` above, this can't happen at
// module scope). See the COMPLIANCE FLAG at the top of this file before
// touching anything calibration-related.
let calibrationGeometry = null;
let calibrationWindow = null;
let isCalibrating = false;

let logStream = null;

// Truncates (create-or-overwrite) then opens in append mode. Must run before
// the FIRST log()/warn() call anywhere in this file -- called explicitly,
// early, right before the single-instance-lock check below, rather than
// relying on call order of the (hoisted) function declarations here.
function initLogFile() {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(LOG_FILE_PATH, ''); // truncate at startup -- see the constant's header comment
    logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' });
    logStream.on('error', (err) => {
      // Best-effort only -- a log-file write failure must never crash the
      // overlay itself. Falls back to console-only for the rest of the run.
      console.warn('[CoachBuild:main] log file write stream error:', err.message);
      logStream = null;
    });
  } catch (err) {
    console.warn('[CoachBuild:main] failed to initialize log file at', LOG_FILE_PATH, '--', err.message);
    logStream = null;
  }
}

function safeStringifyArg(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeLogLine(level, args) {
  if (!logStream) return;
  try {
    const ts = new Date().toISOString();
    const msg = args.map(safeStringifyArg).join(' ');
    logStream.write(`${ts} [${level}] ${msg}\n`);
  } catch {
    // Best-effort only, same as above.
  }
}

function log(...args) {
  console.log('[CoachBuild:main]', ...args);
  writeLogLine('INFO', args);
}
function warn(...args) {
  console.warn('[CoachBuild:main]', ...args);
  writeLogLine('WARN', args);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// Electron's `screen` module is unusable before app 'ready' -- this is only
// ever called from inside app.whenReady() or a later handler, never at
// module scope (that constraint is WHY calibrationGeometry/etc. above are
// initialized to `null` at module scope and populated inside whenReady()
// instead of at declaration, unlike currentLane/showSkillTable which only
// need `app.getPath`/`fs`, both fine early).
function getPrimaryDisplayBounds() {
  return screen.getPrimaryDisplay().bounds;
}

function createWindow() {
  const bounds = getPrimaryDisplayBounds();

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: TRANSPARENT_BACKGROUND_COLOR,
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

  // Click-through by default. NOW SAFETY-CRITICAL, not a nicety: this window
  // covers the ENTIRE primary display, so if it ever fails to be click-through
  // the game underneath becomes unplayable (every click/move would hit this
  // window instead of the game). `forward: true` lets the OS still deliver
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
    // Re-assert bounds after show. OBSERVED this round (see HANDOFF-engy.md):
    // on this dev machine, a frameless fullscreen window's actual content
    // area came back ~48px SHORTER than the `height` passed to the
    // constructor (Windows silently clamping to something work-area-like
    // despite `display.bounds`, not `workArea`, being requested) -- a
    // post-show setBounds is the standard mitigation for this class of
    // Windows quirk. Cheap and harmless if the constructor bounds already
    // stuck correctly.
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'ingame.html'));
}

// Display change (resolution switch, monitor reconfigured, DPI change) --
// resize/reposition the fullscreen window to match the new primary display,
// and re-validate calibration against the new resolution (stale coordinates
// from the OLD resolution must not silently keep being used -- same "fall
// back to the scaled default, log it" rule as a normal startup mismatch, see
// applyCalibrationForCurrentDisplay() below).
function repositionMainWindowToDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = getPrimaryDisplayBounds();
  mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

function applyCalibrationForCurrentDisplay() {
  const bounds = getPrimaryDisplayBounds();
  const loaded = loadCalibration(userDataDir, bounds.width, bounds.height);
  if (loaded.isDefault) {
    log(
      `no saved calibration for ${bounds.width}x${bounds.height} -- using the scaled starting default until you calibrate (tray -> "Calibrate ability bar…")`
    );
  }
  calibrationGeometry = loaded.geometry;
  gameState = mergeState(gameState, { calibration: buildCalibrationPayload() });
  return bounds;
}

// The `calibration` field pushed to the renderer carries BOTH the ability-box
// geometry (this file's own concern, from lib/calibrationSettings.js) AND
// `showTable` (the "Show skill table" toggle) NESTED together in one object
// -- CONTRACT FIX (2026-07-27, same day as the round that added both): the
// renderer (engo's ingame.js) reads `geometry.showTable` off the calibration
// payload, not a separate top-level field. `showSkillTable` stays its own
// separate SETTING (own key in the settings file, own tray checkbox, own
// toggle function below) -- only the OUTGOING WIRE SHAPE nests it inside
// `calibration`, so the two concerns don't have to merge in storage, only in
// what gets pushed over IPC.
function buildCalibrationPayload() {
  if (!calibrationGeometry) return null;
  return { ...calibrationGeometry, showTable: showSkillTable };
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

// The calibration geometry was being COMPUTED (buildCalibrationPayload) but
// never SENT: there was no channel, no push, and no preload bridge. The
// renderer listens for `onCalibration` and, finding it absent, logs that "the
// highlight box has no geometry to draw with and will stay hidden" -- so the
// whole pink-box feature was silently inert while every individual piece
// looked correct in isolation. Exactly the failure mode the Overwolf merge
// had: two halves, each right, never joined.
//
// Sent on the SAME occasions as state (ready handshake, calibration save,
// table toggle), because a geometry push dropped before the renderer attached
// its listener is lost the same way a state push is -- webContents.send has no
// queue.
function pushCalibration() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = buildCalibrationPayload();
  if (!payload) return; // no geometry yet: renderer keeps the box hidden, correctly
  mainWindow.webContents.send('coachbuild-calibration', payload);
}

function pushInteractiveChange() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('coachbuild-interactive', isInteractive);
}

ipcMain.on('coachbuild-ready', () => {
  log('renderer announced ready — replaying current state');
  pushState();
  pushInteractiveChange();
  pushCalibration();
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
// Show/hide the top-left skill table -- kept, not deleted (2026-07-27 round),
// behind a tray toggle defaulting OFF. Same settings-file pattern as lane.
// ---------------------------------------------------------------------------

function toggleShowSkillTable() {
  showSkillTable = !showSkillTable;
  writeSettingsPatch(userDataDir, { showSkillTable }); // storage key, unrelated to the wire shape below
  log('show skill table ->', showSkillTable);
  // Nested under `calibration.showTable` on the wire -- see
  // buildCalibrationPayload()'s comment for why.
  gameState = mergeState(gameState, { calibration: buildCalibrationPayload() });
  pushState();
  pushCalibration(); // `showTable` rides on the calibration payload, not state
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Calibration — see the COMPLIANCE FLAG at the top of this file. This section
// owns ONLY where the four ability-icon boxes sit on screen (geometry), never
// which one (if any) should be highlighted.
//
// A separate, temporary, fullscreen BrowserWindow (renderer/calibrate.html),
// created on entry and destroyed on exit -- kept independent of `mainWindow`
// so calibration can never interfere with the main overlay's own IPC
// contract (state pushes, interactive toggle) that engo's ingame.js depends
// on. Interactive + focusable ONLY while calibrating (same
// setIgnoreMouseEvents/setFocusable pairing already proven correct for the
// main window's interactive mode, ported here) -- a fullscreen focusable
// window is fine for the few seconds a user spends dragging boxes, but must
// never be left that way once calibration ends.
// ---------------------------------------------------------------------------

function enterCalibration() {
  if (isCalibrating) return;
  if (isAdjustingOverlay) {
    warn('cannot open the separate calibration window while adjust-in-place mode is active -- exit adjust mode first');
    return;
  }
  isCalibrating = true;
  log('entering calibration mode (fallback, separate window)');

  const bounds = getPrimaryDisplayBounds();
  calibrationWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: TRANSPARENT_BACKGROUND_COLOR,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true, // interactive for the duration of calibration ONLY
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: CALIBRATE_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  calibrationWindow.setAlwaysOnTop(true, 'screen-saver');

  calibrationWindow.once('ready-to-show', () => {
    if (!calibrationWindow || calibrationWindow.isDestroyed()) return;
    calibrationWindow.showInactive();
    calibrationWindow.setFocusable(true);
    calibrationWindow.focus();
    // See createWindow()'s matching comment -- same post-show bounds
    // re-assertion, same observed Windows quirk.
    calibrationWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  });

  calibrationWindow.on('closed', () => {
    calibrationWindow = null;
    if (isCalibrating) {
      // Window closed some other way (Alt+F4, task manager) without going
      // through exitCalibration()'s save/cancel path -- still must clear the
      // flag so the tray menu and future enterCalibration() calls recover.
      isCalibrating = false;
      rebuildTrayMenu();
    }
  });

  // Diagnostic: forward the renderer's own console to this process's stdout.
  // A calibrate.js exception wouldn't otherwise be visible outside DevTools.
  calibrationWindow.webContents.on('console-message', (_event, _level, message) => {
    log('[calibrate renderer console]', message);
  });

  calibrationWindow.loadFile(path.join(__dirname, 'renderer', 'calibrate.html'));
  rebuildTrayMenu();
}

function exitCalibration(saved) {
  // saved: {geometry, width, height} on Save, or null/undefined on Cancel.
  if (!isCalibrating) return;

  if (saved && saved.geometry) {
    calibrationGeometry = saveCalibration(userDataDir, saved.geometry, saved.width, saved.height);
    log(`calibration saved for ${saved.width}x${saved.height}:`, JSON.stringify(calibrationGeometry));
  } else {
    log('calibration cancelled -- keeping the previous geometry');
  }
  gameState = mergeState(gameState, { calibration: buildCalibrationPayload() });
  pushState();
  // The renderer reads geometry ONLY off the dedicated calibration channel --
  // it never looks at `state.calibration` -- so the mergeState above alone
  // would leave the box drawing at the OLD position after a save.
  pushCalibration();

  isCalibrating = false;
  if (calibrationWindow && !calibrationWindow.isDestroyed()) {
    calibrationWindow.close();
  }
  rebuildTrayMenu();
}

ipcMain.on('coachbuild-calibrate-ready', () => {
  if (!calibrationWindow || calibrationWindow.isDestroyed()) return;
  const bounds = getPrimaryDisplayBounds();
  const loaded = loadCalibration(userDataDir, bounds.width, bounds.height);
  calibrationWindow.webContents.send('coachbuild-calibrate-init', {
    geometry: loaded.geometry,
    displayWidth: bounds.width,
    displayHeight: bounds.height,
    isDefault: loaded.isDefault,
  });
});

ipcMain.on('coachbuild-calibrate-save', (_event, geometry) => {
  const bounds = getPrimaryDisplayBounds();
  exitCalibration({ geometry, width: bounds.width, height: bounds.height });
});

ipcMain.on('coachbuild-calibrate-cancel', () => {
  exitCalibration(null);
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
      // `lane` (the manual override) and `calibration` (which itself now
      // carries `showTable` nested inside it -- see buildCalibrationPayload)
      // deliberately survive a game exit -- they're user preferences /
      // display config, not per-game state. Only session-scoped fields
      // (championLevel, championName, abilityRanks, detectedPosition) reset.
      // BUG FIX (this round): emptyStateFor(false) only carries EMPTY_STATE's
      // own keys (lane, detectedPosition, plus the base fields) -- it does
      // NOT know about `calibration`, which is this file's own addition to
      // the pushed object, not lib/gameState.js's. Omitting it here would
      // have silently dropped it to `undefined` on every single game exit.
      gameState = mergeState(emptyStateFor(false), { lane: currentLane, calibration: buildCalibrationPayload() });
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

// Logs BOTH the return value of register() AND a follow-up isRegistered()
// check for every hotkey (2026-07-27 round 9, diagnostic request) -- the
// Ctrl+F12-does-nothing-in-game bug (root cause: F12 is permanently reserved
// by Windows for the debugger -- see HOTKEY_TOGGLE_ADJUST's header, and the
// guard below) needs this to distinguish "never bound" from "bound at
// startup, then silently lost/stolen later" from "bound fine, UIPI/focus is
// eating the keypress downstream." `hotkeyRegistrationResults` (module-scope,
// declared with the other mutable state above) is READ by
// buildTrayMenuTemplate() so a dead hotkey is visible in the tray, not just
// this log file -- a detached/packaged launch has no console at all, so a
// log-only signal was exactly how this bug stayed invisible for an hour.
function registerHotkeys() {
  const hotkeys = [
    { accel: HOTKEY_TOGGLE_OVERLAY, label: 'show/hide', handler: toggleOverlayVisibility },
    { accel: HOTKEY_TOGGLE_INTERACTIVE, label: 'interactive toggle', handler: toggleInteractive },
    { accel: HOTKEY_TOGGLE_ADJUST, label: 'adjust overlay position', handler: toggleAdjustOverlay },
  ];

  hotkeyRegistrationResults = [];
  let allOk = true;
  for (const { accel, label, handler } of hotkeys) {
    // GUARD (2026-07-27 round 9): F12 in ANY modifier combination is
    // permanently reserved by Windows for the debugger (Microsoft's
    // RegisterHotKey docs, quoted at HOTKEY_TOGGLE_ADJUST's declaration) --
    // globalShortcut.register() will return false for it unconditionally, on
    // every Windows machine, regardless of elevation or what else is
    // running. Refuse to even attempt it and fail LOUDLY (console + log file
    // + tray, via hotkeyRegistrationResults below) so a future edit that
    // picks F12 again is caught at startup instead of producing a silently
    // dead hotkey again.
    if (/\bF12\b/i.test(accel)) {
      warn(
        `refusing to register ${accel} (${label}) — F12 is permanently reserved by Windows for the debugger (see RegisterHotKey docs) and would always fail; pick a different accelerator`
      );
      hotkeyRegistrationResults.push({ accel, label, registered: false, reservedByWindows: true });
      allOk = false;
      continue;
    }

    const registerReturn = globalShortcut.register(accel, handler);
    const isRegisteredNow = globalShortcut.isRegistered(accel);
    const registered = registerReturn && isRegisteredNow;
    log(`hotkey ${accel} (${label}): register() returned ${registerReturn}, isRegistered() reports ${isRegisteredNow}`);
    if (!registerReturn) {
      warn(`failed to register hotkey ${accel} — likely already bound by another app`);
      allOk = false;
    } else if (!isRegisteredNow) {
      // Registered successfully but isRegistered() disagrees a moment later
      // -- inconsistent state worth flagging loudly rather than assuming
      // register()'s true return is the whole story.
      warn(`hotkey ${accel} registered but isRegistered() reports false immediately after — inconsistent state`);
      allOk = false;
    }
    hotkeyRegistrationResults.push({ accel, label, registered, reservedByWindows: false });
  }

  if (allOk) {
    log(`hotkeys registered: ${HOTKEY_TOGGLE_OVERLAY} (show/hide), ${HOTKEY_TOGGLE_INTERACTIVE} (interactive toggle), ${HOTKEY_TOGGLE_ADJUST} (adjust overlay position)`);
  }
  // Tray was already built once (createWindow/createTray runs before
  // registerHotkeys() in app.whenReady()) -- refresh it now that the real
  // per-hotkey status is known. Guarded no-op if called before the tray
  // exists (defensive; not expected given current call order).
  rebuildTrayMenu();
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

// FOCUSABILITY MUST FOLLOW INTERACTIVITY, and this is the non-obvious half.
//
// The window is created `focusable: false` so it can never steal focus from
// the game — correct, and load-bearing, for the 99% of the time it is a
// read-only table/highlight box. But on Windows that maps to WS_EX_NOACTIVATE,
// and a non-activatable window does not reliably deliver clicks OR KEYS to
// DOM content: letting mouse events through via setIgnoreMouseEvents(false)
// is necessary but NOT sufficient. Toggling only that would produce the
// single worst failure this overlay could have — controls LOOK usable (the
// interactive badge is showing) and silently do nothing.
//
// Extracted into one shared helper (2026-07-27 round 8) because TWO
// independent modes now want this exact pairing -- the lane-button
// "interactive" toggle (mouse) and the new adjust-in-place mode (keyboard,
// see toggleAdjustOverlay() below). Either wanting it is enough; the window
// is interactive+focused whenever `isInteractive || isAdjustingOverlay` is
// true, so the two modes can never fight over the window's own state.
function applyMainWindowInteractivity() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wantInteractive = isInteractive || isAdjustingOverlay;

  // Equivalent intent to the Overwolf build's setWindowStyle/removeWindowStyle
  // with WindowStyle.InputPassThrough — ported to Electron's own API, not a
  // literal translation of the Overwolf call.
  mainWindow.setIgnoreMouseEvents(!wantInteractive, { forward: !wantInteractive });

  // `setFocusable` is supported on Windows and macOS; guarded because it is
  // absent on some platforms.
  if (typeof mainWindow.setFocusable === 'function') {
    mainWindow.setFocusable(wantInteractive);
  }
  if (wantInteractive) {
    // Without an explicit focus() the freshly-focusable window still sits
    // unactivated, so the first click/keypress would be spent activating it
    // rather than reaching the control/listener underneath.
    mainWindow.focus();
  }
}

function toggleInteractive() {
  isInteractive = !isInteractive;
  log('toggle_interactive ->', isInteractive ? 'interactive (clickable)' : 'clickthrough');
  applyMainWindowInteractivity();
  pushInteractiveChange();
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Adjust-in-place mode (2026-07-27 round 8) -- REPLACES the separate
// calibration window as the PRIMARY alignment path.
//
// WHY: the separate window (renderer/calibrate.*, still kept as a fallback)
// covers the game, so a one-monitor user aiming boxes at ability icons they
// can no longer see cannot actually align them -- confirmed by a real user
// report ("the overlay isnt exactly on top of each skill box... i couldnt
// change their places in game"). The fix is to let the user nudge the SAME
// boxes that are already drawn over the SAME running game, live, in the MAIN
// overlay window -- never a surface that occludes what they're aligning to.
//
// KEY HANDLING, and why it is NOT global shortcuts: arrow keys registered
// globally would either be stolen from the game outright, or (with
// `passthrough: true`) fire in BOTH places at once -- both wrong for a mode
// whose whole point is precise nudging. Instead: ONE global hotkey
// (Ctrl+Shift+A, see HOTKEY_TOGGLE_ADJUST -- was Ctrl+F12 until 2026-07-27
// round 9, changed because F12 is permanently reserved by Windows) toggles
// the mode; while it's on, the window is made
// interactive+focusable+focused (applyMainWindowInteractivity() above) so
// ordinary `keydown` listeners in the RENDERER receive the nudge keys and
// the game does not. This is why this file only toggles the MODE FLAG and
// leaves ALL key handling (arrows/shift/+-/[]/Tab/Enter/Esc) and the
// on-screen legend to the renderer -- see the IPC+DOM contract in
// HANDOFF-engy.md for exactly what engo's ingame.js needs to implement; I do
// not own or edit that file.
function toggleAdjustOverlay() {
  if (isCalibrating) {
    warn('cannot enter adjust-in-place mode while the separate calibration window is open -- close it first');
    return;
  }

  isAdjustingOverlay = !isAdjustingOverlay;
  log('adjust overlay position ->', isAdjustingOverlay ? 'ON (main window now captures keyboard input)' : 'off');

  if (isAdjustingOverlay && !overlayVisibleWanted) {
    // The user can't align boxes they can't see -- force the overlay visible
    // rather than silently doing nothing.
    overlayVisibleWanted = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive();
  }

  applyMainWindowInteractivity();
  // Pushed on BOTH directions, not just entry:
  //  - Entering: seeds the renderer's local working copy from the current
  //    authoritative value, in case something changed (e.g. a
  //    display-metrics-changed re-scale) since its last push.
  //  - Exiting via this SAME toggle (hotkey/tray) rather than the renderer's
  //    own Enter/Esc: there is no "save" here, so this must behave like a
  //    cancel -- re-push the last SAVED geometry so any unsaved local nudges
  //    the renderer was rendering live get discarded, not silently kept on
  //    screen while main's own state disagrees with what's displayed.
  pushCalibration();
  pushAdjustModeChange();
  rebuildTrayMenu();
}

function pushAdjustModeChange() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('coachbuild-adjust-mode', isAdjustingOverlay);
}

// Renderer -> main: the user pressed Enter in adjust mode. `geometry` is the
// renderer's locally-nudged working copy -- validated again here
// (saveCalibration -> lib/calibrationSettings.js's isValidGeometry) before
// persisting, same as the separate-window path; never trust a cross-process
// payload as-is.
ipcMain.on('coachbuild-adjust-save', (_event, geometry) => {
  const bounds = getPrimaryDisplayBounds();
  calibrationGeometry = saveCalibration(userDataDir, geometry, bounds.width, bounds.height);
  log(`adjust-in-place geometry saved for ${bounds.width}x${bounds.height}:`, JSON.stringify(calibrationGeometry));
  gameState = mergeState(gameState, { calibration: buildCalibrationPayload() });
  pushState();
  // CRITICAL (matches exitCalibration()'s own fix, same day): the renderer's
  // highlight box reads geometry ONLY off the dedicated 'coachbuild-calibration'
  // channel, never `state.calibration` -- pushState() alone would have saved
  // the new geometry to disk while the on-screen box silently kept using the
  // OLD position until the next unrelated push happened to fire.
  pushCalibration();
  if (isAdjustingOverlay) {
    isAdjustingOverlay = false;
    applyMainWindowInteractivity();
    pushAdjustModeChange();
    rebuildTrayMenu();
  }
});

// Renderer -> main: the user pressed Esc. Discards whatever the renderer's
// local working copy had -- `calibrationGeometry` (this process's own
// authoritative value) is untouched. Still re-pushes the calibration channel
// on the way out: while adjusting, the renderer was rendering its OWN local
// (unsaved) nudges live -- on cancel it needs to be told the real, saved
// geometry again so the box snaps back rather than staying at the discarded
// position.
ipcMain.on('coachbuild-adjust-cancel', () => {
  log('adjust-in-place cancelled -- keeping the previous geometry');
  pushCalibration();
  if (isAdjustingOverlay) {
    isAdjustingOverlay = false;
    applyMainWindowInteractivity();
    pushAdjustModeChange();
    rebuildTrayMenu();
  }
});

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
    return { elevated: true, detail: 'possibly elevated (could write to C:\\Windows)' };
  } catch {
    return { elevated: false, detail: 'most likely NOT elevated (could not write to C:\\Windows)' };
  }
}

// Computed ONCE at startup into module-scope `elevationGuessText`/`elevationGuessElevated`
// (see the "Mutable state" section) rather than re-run on every tray rebuild --
// elevation cannot change mid-process, only across a relaunch. Surfaced in
// TWO places (2026-07-27 round 8 addition): the startup log (this function),
// AND a tray menu row (buildTrayMenuTemplate()) -- a log line in a terminal
// the user isn't looking at mid-match is not communication on its own.
let elevationGuessElevated = false;

function logElevationGuidance() {
  const guess = bestEffortElevationGuess();
  elevationGuessElevated = guess.elevated;
  elevationGuessText = guess.detail;
  log(`elevation check (best-effort, not certain): ${guess.detail}`);
  // REWORDED 2026-07-27 round 9: this used to assert elevation as THE
  // explanation for a non-responding hotkey. That sent a real debugging
  // session an hour down the wrong path -- the actual Ctrl+F12 cause was a
  // Windows-reserved key, nothing to do with elevation at all (see
  // HOTKEY_TOGGLE_ADJUST's header). Elevation/UIPI may still matter for
  // Ctrl+F10/Ctrl+F11 specifically while League (which runs elevated under
  // Vanguard) has focus -- that remains untested and is NOT ruled out here --
  // but it is now presented as one possible factor among several, not a
  // diagnosis. Always check "Open log file" / the tray's hotkey rows first:
  // those report the ACTUAL bind status, which is a fact, not a guess.
  log(
    'if Ctrl+F10/Ctrl+F11/Ctrl+Shift+A do not respond while League has focus: check the tray menu or "Open log file" first for the actual per-hotkey bind status (a hotkey that failed to register will never respond regardless of elevation). If it DID bind but still does not respond in-game, elevation/UIPI is one possible remaining factor -- try "npm run start:admin" / right-click -> Run as administrator. The SYSTEM TRAY ICON works regardless of any of this and is the reliable fallback either way.'
  );
}

// ---------------------------------------------------------------------------
// System tray — the PRIMARY fix for the hotkey deadlock. Reachable from the
// Windows notification area even while League is fullscreen-borderless and
// focused, and does not depend on the elevation question at all.
// ---------------------------------------------------------------------------

// Cosmetic only, for tray display -- matches the README's own "Ctrl+F10"
// style rather than Electron's internal "Control+F10" accelerator spelling.
function humanizeAccel(accel) {
  return accel.replace(/\bControl\b/g, 'Ctrl');
}

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
      // PRIMARY alignment path as of 2026-07-27 round 8 -- adjusts the SAME
      // boxes already drawn over the running game, live, instead of a
      // separate window that covers it. See toggleAdjustOverlay()'s header.
      label: isAdjustingOverlay ? 'Adjusting… (Enter to save, Esc to cancel)' : 'Adjust overlay position',
      type: 'checkbox',
      checked: isAdjustingOverlay,
      enabled: !isCalibrating,
      click: () => toggleAdjustOverlay(),
    },
    {
      // Kept, not deleted -- default OFF this round (2026-07-27). See the
      // "FULLSCREEN" comment on TRAY_ICON_PATH's block for why.
      label: 'Show skill table',
      type: 'checkbox',
      checked: showSkillTable,
      click: () => toggleShowSkillTable(),
    },
    {
      // FALLBACK path now, not primary (round 8) -- a separate window covers
      // the game, so a one-monitor user can't see what they're aligning to.
      // Kept for a second monitor / dry-run-without-a-game use case.
      label: isCalibrating ? 'Calibrating… (use the on-screen Save/Cancel)' : 'Calibrate ability bar (separate window, fallback)…',
      enabled: !isCalibrating && !isAdjustingOverlay,
      click: () => enterCalibration(),
    },
    { type: 'separator' },
    // Non-clickable status rows (2026-07-27 round 8, REWORKED round 9) -- a
    // log line in a terminal the user isn't looking at mid-match is not
    // communication, and a packaged app has no console/log-file-in-view at
    // all. One row per hotkey with its ACTUAL measured bind status
    // (hotkeyRegistrationResults, set by registerHotkeys()) -- this used to
    // be a single elevation guess presented as the explanation for a hotkey
    // not responding, which sent a real debugging session down the wrong
    // path when the true cause (F12 permanently reserved by Windows) had
    // nothing to do with elevation. See logElevationGuidance()'s header for
    // the full reasoning.
    ...(hotkeyRegistrationResults.length > 0
      ? hotkeyRegistrationResults.map(({ accel, label, registered, reservedByWindows }) => ({
          label: registered
            ? `Hotkeys: ${humanizeAccel(accel)} (${label}) — active`
            : reservedByWindows
            ? `Hotkeys: ${humanizeAccel(accel)} (${label}) — FAILED, reserved by Windows`
            : `Hotkeys: ${humanizeAccel(accel)} (${label}) — FAILED to bind`,
          enabled: false,
        }))
      : [{ label: 'Hotkeys: not yet registered', enabled: false }]),
    {
      // Best-effort heuristic ONLY, and no longer presented as an
      // explanation for a hotkey failure -- see logElevationGuidance().
      label: elevationGuessElevated
        ? 'Elevation: probably elevated (one possible factor if a hotkey fails only in-game)'
        : 'Elevation: most likely NOT elevated (one possible factor if a hotkey fails only in-game)',
      enabled: false,
    },
    {
      // 2026-07-27 round 9 -- so the user can retrieve diagnostics (e.g. the
      // hotkey register()/isRegistered() lines) without hunting for
      // app.getPath('userData') themselves, especially once packaged (no
      // console at all then). shell.openPath opens it in the user's default
      // text-file handler (Notepad, by default on a stock Windows install).
      label: 'Open log file',
      click: () => {
        shell.openPath(LOG_FILE_PATH).then((errMsg) => {
          if (errMsg) warn('failed to open log file via shell.openPath:', errMsg);
        });
      },
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
initLogFile(); // must run before the first log()/warn() call below

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
    log(`app version: ${app.getVersion()} -- packaged: ${app.isPackaged} -- log file: ${LOG_FILE_PATH}`);
    // Moved BEFORE createTray() (2026-07-27 round 9, was after) so the tray's
    // own elevation-guess row is correct from its very first render, not just
    // after the next rebuildTrayMenu() call -- a genuine small fix, not just
    // a reorder for logging's sake: `elevationGuessElevated` was previously
    // read by buildTrayMenuTemplate() inside createTray() while still at its
    // initial `false` default.
    logElevationGuidance();
    const startupDisplay = screen.getPrimaryDisplay();
    log(
      `primary display: bounds=${JSON.stringify(startupDisplay.bounds)} scaleFactor=${startupDisplay.scaleFactor} -- for reference, this dev machine is 200% scaled (physical 3072x1920, logical 1536x960); the gaming PC this is packaged for will differ`
    );
    log(`lane override at startup: ${currentLane === null ? 'Auto (none set)' : currentLane}`);
    log(`show skill table at startup: ${showSkillTable}`);
    applyCalibrationForCurrentDisplay(); // populates calibrationGeometry + merges into gameState
    log('calibration payload at startup:', JSON.stringify(buildCalibrationPayload()));
    createWindow();
    createTray();
    registerHotkeys();
    schedulePoll();

    // Test seam, not a feature: this desktop session has no visible taskbar
    // (confirmed across multiple rounds' screenshots), so the tray menu can't
    // be clicked to verify calibration mode end-to-end. Guarded behind an
    // explicit env var nobody sets by accident -- documented in
    // HANDOFF-engy.md and overlay-host/README.md, not a hidden backdoor.
    if (process.env.COACHBUILD_AUTO_CALIBRATE === '1') {
      log('COACHBUILD_AUTO_CALIBRATE=1 -- auto-entering calibration mode (test seam, see README)');
      enterCalibration();
    }

    // Resolution/monitor change while running -- resize the fullscreen window
    // and re-validate calibration against the new resolution (never keep
    // using coordinates calibrated for a different screen size silently).
    screen.on('display-metrics-changed', () => {
      log('display metrics changed -- repositioning overlay window and re-checking calibration');
      repositionMainWindowToDisplay();
      applyCalibrationForCurrentDisplay();
      pushState();
    });
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
    if (calibrationWindow && !calibrationWindow.isDestroyed()) calibrationWindow.close();
    if (logStream) {
      try {
        logStream.end();
      } catch {
        // best-effort only
      }
    }
  });
}
