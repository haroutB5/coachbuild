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
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const { fetchActivePlayer, fetchPlayerList } = require('./lib/liveClientHttp.js');
const { loadLane, saveLane, VALID_LANES } = require('./lib/laneSettings.js');
const { readSettingsFile, writeSettingsPatch } = require('./lib/settingsFile.js');
const { loadCalibration, saveCalibration } = require('./lib/calibrationSettings.js');
const autoUpdaterModule = require('./lib/autoUpdater.js');
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

// Elevated-at-login Scheduled Task (2026-07-27 round 10, Fix 1) -- see the
// big comment block near enableElevatedAutostart() below for the full
// reasoning. Name is deliberately distinctive (unlikely to collide with any
// other task on the user's machine) and stable across versions -- it is both
// created AND queried/deleted by this exact string, so it must never change
// without also migrating/deleting the old one.
const ELEVATED_TASK_NAME = 'CoachBuild Overlay Elevated Autostart';

// Poll less often when idle (no game) so this never spins the CPU or hammers
// the loopback socket while the user is just browsing/queuing. Faster while a
// game is live so a level-up shows up promptly.
const IDLE_POLL_MS = 5000;
const ACTIVE_POLL_MS = 1500;
const PLAYERLIST_POLL_MS = 4000;

// ---------------------------------------------------------------------------
// Companion supervision (2026-07-27, "one app" round). This app becomes the
// single visible surface and supervises public/companion.ps1 -- the LCU
// bridge that actually writes runes/item sets to the user's real account --
// as a hidden headless child. NONE of that writing logic is ported here; see
// CLAUDE.md's "Companion integration" section and the Hard Rules before
// touching anything companion-adjacent.
// ---------------------------------------------------------------------------

// Must match companion.ps1's $script:Config.AppOrigin EXACTLY -- the bridge's
// CORS check is `$origin -ne $Sync.AppOrigin` (see companion.ps1's
// BridgeServer worker), so a request with no Origin header (Node's http
// module doesn't send one by default) or a mismatched one gets a flat 403
// 'bad-origin'. This constant exists so this file's poll requests pass that
// check the same way a real browser tab would.
const COMPANION_APP_ORIGIN = 'https://coachbuild.vercel.app';
// Mirrors companion.ps1's $script:Config.BridgePorts -- first free port of
// these three is where the bridge actually ends up listening.
const COMPANION_BRIDGE_PORTS = [48291, 48292, 48293];
const COMPANION_STATUS_POLL_MS = 3000;
// Exponential-ish backoff for an unexpected child exit, capped at 60s -- NOT
// used for the "another copy is already running" case (mutex race), which is
// a distinct state that does not auto-retry at all (see spawnCompanion()).
const COMPANION_RESTART_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
// A child that exits THIS fast after spawn didn't crash mid-run -- it lost
// Test-SingleInstance's mutex race to another already-running copy (most
// likely the OLD .vbs autostart, if the user hasn't rebooted since this app
// removed it -- see removeLegacyVbsAutostartOnce()). Surfaced distinctly in
// the tray rather than silently retried forever.
const COMPANION_MUTEX_RACE_EXIT_MS = 5000;

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
// Whether the elevated-at-login Scheduled Task (see ELEVATED_TASK_NAME) is
// currently registered -- computed at startup via isElevatedTaskRegistered()
// and kept in sync by toggleElevatedAutostart(), so the tray checkbox always
// reflects real on-disk state rather than an assumed one.
let elevatedAutostartEnabled = false;
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

// Companion child-process supervision state (see the constants block above).
let companionChild = null;
let companionQuitting = false; // set true in will-quit -- suppresses the exit handler's auto-restart
let companionStartedAt = 0;
let companionRestartAttempts = 0;
let companionRestartTimer = null;
let companionRestartPendingAfterGame = false; // set when a restart was due but deferred because inGame was true
let companionStatusPollTimer = null;
let companionKnownPort = null; // last port /status answered on, tried first next poll
// phase: 'starting' | 'ok' | 'already-running' | 'restarting' | 'restart-deferred' | 'unreachable' | 'error' | 'not-found'
let companionStatus = { phase: 'starting', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: null };

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

// B8 FIX (2026-07-27 audit) -- signature of every field the RENDERER actually
// reads off a 'coachbuild-state' push (js/skillOrderData.js's
// resolveOverlayData reads exactly these six: inGame, championName,
// championLevel, abilityRanks.{Q,W,E,R}, lane, detectedPosition -- confirmed
// by reading that function directly, not assumed). Deliberately does NOT
// include `calibration`: that field rides along on `gameState` too, but the
// renderer is contractually forbidden from reading it off the state channel
// (see pushCalibration()'s own comment) -- it has its own dedicated
// 'coachbuild-calibration' channel and its own push call, so including it
// here would make this function report a change the renderer would never
// actually see, and skip a push it might.
//
// Same pattern as ingame.js's own `lastLaneBarSignature` (renderLaneBar) --
// stringify the fields that matter and compare against the last-pushed
// signature, skip the (expensive, ~100-element) rebuild when nothing the
// renderer would draw differently has changed.
function computeGameStateSignature(state) {
  const r = state.abilityRanks;
  return JSON.stringify([
    state.inGame,
    state.championName,
    state.championLevel,
    r ? [r.Q, r.W, r.E, r.R] : null,
    state.lane,
    state.detectedPosition,
  ]);
}

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
      // B8 FIX: this used to merge + pushState() on EVERY successful poll
      // tick (ACTIVE_POLL_MS = 1500ms) regardless of whether the level or any
      // ability rank actually changed since the last push -- over a 40-minute
      // game that's ~1,600 full IPC round trips, each triggering the
      // renderer's handleState -> render -> renderResolved -> buildGrid,
      // which does `els.grid.innerHTML = ""` and rebuilds ~100 DOM elements,
      // even while the overlay is hidden (the default). Change-check first;
      // only merge+push when the candidate state would actually render
      // differently.
      const candidate = mergeState(gameState, {
        inGame: true,
        championLevel: parsed.level,
        abilityRanks: parsed.abilityRanks,
      });
      if (computeGameStateSignature(candidate) !== computeGameStateSignature(gameState)) {
        gameState = candidate;
        pushState();
      }
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
      // The game that was blocking a deferred update install, if any, just
      // ended -- try installing now instead of waiting for the next periodic
      // check (which could be hours away). Safe no-op if no update is
      // pending. See lib/autoUpdater.js's header for the full rule.
      autoUpdaterModule.notifyGameEnded();
      notifyGameEndedForCompanion();
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
// Companion supervision — spawns public/companion.ps1 as a hidden headless
// child (`-NoTray`, see that script's param block) and keeps it running.
//
// This file NEVER speaks the LCU/rune/item-set protocol itself -- it only
// starts the process, watches whether it exits, and polls its OWN `/status`
// endpoint (the same wire contract components/live/companionClient.ts uses)
// to show a status row in this app's tray. See CLAUDE.md's Hard Rules before
// touching anything about WHAT the companion does once it's running.
// ---------------------------------------------------------------------------

// Resolves to the bundled script both in dev (npm start, reads straight from
// the sibling public/ dir in this monorepo checkout) and packaged (an
// extraResources copy placed at process.resourcesPath/companion.ps1 -- see
// package.json's build.extraResources). Deliberately NOT `files`+asarUnpack:
// extraResources never enters app.asar in the first place, which sidesteps
// the "a .ps1 cannot run from inside an asar" problem entirely rather than
// working around it after the fact. Verified by running the packaged exe --
// see the HANDOFF entry for the confirmed on-disk resources-dir listing.
function getCompanionScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'companion.ps1');
  }
  return path.join(__dirname, '..', 'public', 'companion.ps1');
}

function setCompanionStatus(patch) {
  companionStatus = { ...companionStatus, ...patch };
  rebuildTrayMenu();
}

function spawnCompanion() {
  const scriptPath = getCompanionScriptPath();
  if (!fs.existsSync(scriptPath)) {
    warn(`companion script not found at ${scriptPath} -- cannot supervise it`);
    setCompanionStatus({ phase: 'not-found', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: 'companion.ps1 not found in this build' });
    return;
  }

  companionStartedAt = Date.now();
  log(`companion: spawning powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -NoTray`);
  setCompanionStatus({ phase: 'starting', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: null });
  companionKnownPort = null;

  // stdio: 'ignore', deliberately -- a PowerShell child that fills an unread
  // stdout pipe BLOCKS (a real hazard for a long-running always-on process
  // whose parent never reads it). The alternative considered was tee-ing
  // stdout into this file's own log()/warn() -- rejected because
  // companion.ps1 already has its OWN independent file logger
  // (%LOCALAPPDATA%\CoachBuild\companion.log, unaffected by -NoTray) that
  // captures every phase transition / apply result / internal error, so
  // piping stdout here would be redundant diagnostics with a real blocking
  // risk attached, for no signal this app doesn't already get some other way
  // (the /status poll below, or that log file directly).
  companionChild = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-NoTray'],
    { stdio: 'ignore', windowsHide: true }
  );

  companionChild.on('error', (err) => {
    warn('companion: failed to spawn child process:', err.message);
    companionChild = null;
    setCompanionStatus({ phase: 'error', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: err.message });
  });

  companionChild.on('exit', (code, signal) => {
    const ranMs = Date.now() - companionStartedAt;
    log(`companion: child exited (code=${code}, signal=${signal}) after ${ranMs}ms`);
    companionChild = null;
    if (companionQuitting) {
      stopCompanionStatusPolling();
      return; // app is shutting down -- do not restart
    }

    if (ranMs < COMPANION_MUTEX_RACE_EXIT_MS) {
      // MUTEX-RACE CASE, distinct from a crash: Test-SingleInstance inside
      // companion.ps1 lost the 'Local\CoachBuildCompanion' mutex to another
      // already-running copy (most likely the old .vbs autostart, if the
      // user hasn't rebooted since install/first-run removed it -- see
      // removeLegacyVbsAutostartOnce()) and exited immediately by design.
      // Surfaced as its own tray state, NOT silently retried forever.
      warn('companion: exited within ' + COMPANION_MUTEX_RACE_EXIT_MS + 'ms of spawn -- likely another copy is already running (mutex race), not auto-retrying');
      setCompanionStatus({ phase: 'already-running', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: 'Companion: another copy is already running' });
      // B1 FIX (2026-07-27 audit): this branch used to inherit an
      // UNCONDITIONAL stopCompanionStatusPolling() call that ran before this
      // if/else even checked which case it was -- so the supervisor went
      // permanently blind the moment a standalone companion already held the
      // mutex: no phase, no clientConnected, no lastPollAtAdvancing, for the
      // rest of the session, even though a REAL companion is right there
      // answering /status on loopback (this is not the copy we spawned, but
      // the bridge port answers for whichever process is bound to it,
      // regardless of who started it). Start polling instead of stopping it
      // -- startCompanionStatusPolling() is itself idempotent (it clears any
      // existing timer before arming a new one), so this is always safe to
      // call here even if a poll loop somehow survived. Never auto-retry the
      // spawn in this branch -- that part of the original diagnosis is
      // correct and unchanged.
      startCompanionStatusPolling();
      return;
    }

    stopCompanionStatusPolling();
    scheduleCompanionRestart();
  });

  // B4 FIX (2026-07-27 audit): this used to unconditionally reset
  // companionRestartAttempts to 0 on EVERY spawn, including a spawn that is
  // ITSELF the restart attempt scheduleCompanionRestart() just backed off
  // for -- so the sequence was always attempts=0 -> delay 2000ms -> spawn()
  // resets to 0 -> next failure -> delay 2000ms again, forever, regardless of
  // how many times it had already failed. The backoff table
  // (COMPANION_RESTART_BACKOFF_MS) never got to escalate past its first
  // entry. The reset that actually belongs here is the one already in
  // pollCompanionStatusOnce() ("a real successful status poll is proof of
  // health") -- that is the correct signal for "the backoff counter should
  // go back to zero," not merely "a spawn was attempted." Removed; do not
  // reintroduce a reset at spawn time.
  startCompanionStatusPolling();
}

function scheduleCompanionRestart() {
  clearTimeout(companionRestartTimer);
  const delay = COMPANION_RESTART_BACKOFF_MS[Math.min(companionRestartAttempts, COMPANION_RESTART_BACKOFF_MS.length - 1)];
  companionRestartAttempts++;
  log(`companion: scheduling restart in ${delay}ms (attempt ${companionRestartAttempts})`);
  setCompanionStatus({ phase: 'restarting', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: `Companion: restarting in ${Math.round(delay / 1000)}s…` });
  companionRestartTimer = setTimeout(attemptCompanionRestart, delay);
}

// B2 FIX (2026-07-27 audit) -- ONE shared source of truth for "is it unsafe
// to interrupt the companion right now", consulted by BOTH call sites that
// need it (this file's attemptCompanionRestart below, and
// lib/autoUpdater.js's maybeInstallIfIdle via the getIsBusy callback wired
// in app.whenReady()'s autoUpdaterModule.init() call).
//
// `inGame` alone (true only while /liveclientdata/activeplayer succeeds --
// i.e. a match is already IN PROGRESS) is too narrow: it says nothing about
// CHAMP SELECT, which is exactly when companion.ps1 writes to the LCU
// (Invoke-ApplyRunes does DELETE /lol-perks/v1/pages/<id> then POST). A
// `taskkill /F` landing between those two calls (restart) or a
// quitAndInstall mid-champ-select (update) destroys the user's own rune page
// with nothing created in its place.
//
// The champ-select signal already exists and was going unused:
// pollCompanionStatusOnce() writes the raw LCU gameflow phase straight into
// `companionStatus.phase` (see its own comment, and B6's
// GAMEFLOW_PHASE_LABELS for the presentation-only mapping layered on top of
// this same raw value for the tray -- that mapping must never replace the
// raw value stored here, or this check would break).
function isCompanionBusy() {
  return inGame || companionStatus.phase === 'ChampSelect';
}

function companionBusyReason() {
  if (inGame) return 'a game is in progress';
  if (companionStatus.phase === 'ChampSelect') return 'champ select is in progress';
  return 'busy';
}

// The actual restart attempt, gated on isCompanionBusy() (widened from a
// bare `inGame` check, see B2 above). NEVER restart the LCU writer mid-match
// OR mid-champ-select -- same class of mistake as installing an update at
// either of those moments (see lib/autoUpdater.js's header), and for the
// same reason: this process is what applies runes/item sets, and
// killing/relaunching it while either is live risks a torn write. If
// deferred, notifyGameEndedForCompanion() (wired into pollActivePlayer's
// game-ended branch, alongside autoUpdaterModule's own notifyGameEnded())
// retries immediately once `inGame` flips back to false, rather than waiting
// out the rest of the backoff delay.
function attemptCompanionRestart() {
  if (isCompanionBusy()) {
    log(`companion: restart due, but ${companionBusyReason()} -- deferring until it ends`);
    companionRestartPendingAfterGame = true;
    setCompanionStatus({ phase: 'restart-deferred', clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null, message: 'Companion: restart deferred (game in progress)' });
    return;
  }
  spawnCompanion();
}

function notifyGameEndedForCompanion() {
  if (!companionRestartPendingAfterGame) return;
  companionRestartPendingAfterGame = false;
  log('companion: game ended -- retrying the deferred restart now');
  spawnCompanion();
}

function killCompanionChild() {
  companionQuitting = true;
  stopCompanionStatusPolling();
  clearTimeout(companionRestartTimer);
  if (!companionChild || companionChild.exitCode !== null) return;
  const pid = companionChild.pid;
  log(`companion: killing child process (pid ${pid}) on quit`);
  // taskkill /T /F rather than child.kill(): powershell.exe -File spawns no
  // children of its own in this codepath, but /T is cheap insurance against
  // ever leaving an orphan behind -- an orphaned companion.ps1 process holds
  // the Local\CoachBuildCompanion mutex, and the NEXT launch (of either this
  // app's supervised child, or a manually-run companion) would silently lose
  // the mutex race and exit immediately (the "already-running" state above),
  // for no reason the user could see. Verified on this machine: see the
  // HANDOFF entry for the Get-Process check confirming no orphan survives.
  const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  if (result.error) {
    warn('companion: taskkill failed, falling back to child.kill():', result.error.message);
    try {
      companionChild.kill();
    } catch (err) {
      warn('companion: child.kill() also failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Companion status polling — GET /status on loopback, the SAME wire contract
// components/live/companionClient.ts uses. Read-only: this file never calls
// any endpoint that writes runes/item sets/anything else to the LCU.
// ---------------------------------------------------------------------------

function getCompanionSessionToken() {
  // Get-OrCreateSessionToken (companion.ps1) persists here -- read it, never
  // invent a second token. Missing (companion hasn't written it yet, e.g.
  // during the first second after spawn) is expected and handled by the
  // caller, not an error.
  try {
    const tokenPath = path.join(process.env.LOCALAPPDATA, 'CoachBuild', 'companion-session.txt');
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function fetchCompanionStatusOnce(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/status?session=${encodeURIComponent(token)}`,
        method: 'GET',
        // REQUIRED: companion.ps1's bridge does exact-Origin CORS on every
        // request (`$origin -ne $Sync.AppOrigin` -> 403 'bad-origin'), and
        // Node's http module sends no Origin header at all by default -- so
        // without this header every poll from this process would 403.
        headers: { Origin: COMPANION_APP_ORIGIN },
        timeout: 2000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`status ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function pollCompanionStatusOnce() {
  const token = getCompanionSessionToken();
  if (!token) {
    // Expected transiently right after spawn -- Get-OrCreateSessionToken
    // runs early in Start-Companion, but there's a real window before the
    // file exists. Not an error state; the next poll tick resolves it.
    setCompanionStatus({ clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null });
    return;
  }

  const ports = companionKnownPort
    ? [companionKnownPort, ...COMPANION_BRIDGE_PORTS.filter((p) => p !== companionKnownPort)]
    : COMPANION_BRIDGE_PORTS;

  for (const port of ports) {
    try {
      const data = await fetchCompanionStatusOnce(port, token);
      companionKnownPort = port;
      const prevLastPollAt = companionStatus.lastPollAt;
      // THE DOCUMENTED DEAD-LOOP SIGNAL: lastPollAt not advancing across two
      // reads means the real gameflow-poll loop inside the companion has
      // stopped ticking even though the process and its HTTP bridge are both
      // still alive -- the exact blind spot companion.ps1's own -HarnessTest
      // exists to catch at build time (see that script's header). This is
      // the runtime equivalent, surfaced live in the tray.
      const advancing =
        prevLastPollAt && data.lastPollAt ? new Date(data.lastPollAt).getTime() > new Date(prevLastPollAt).getTime() : null;
      setCompanionStatus({
        phase: data.phase || 'Unknown',
        clientConnected: !!data.clientConnected,
        lastPollAt: data.lastPollAt || null,
        lastPollAtAdvancing: advancing,
        message: null,
      });
      companionRestartAttempts = 0; // a real successful status poll is proof of health -- reset the backoff counter
      return;
    } catch {
      // try the next candidate port
    }
  }

  // No configured port answered -- the child may still be starting up (the
  // bridge server takes a beat to bind), or it exited between spawn and this
  // tick (the 'exit' handler above will already be handling that case).
  setCompanionStatus({ clientConnected: null, lastPollAt: null, lastPollAtAdvancing: null });
}

function startCompanionStatusPolling() {
  stopCompanionStatusPolling();
  companionStatusPollTimer = setInterval(pollCompanionStatusOnce, COMPANION_STATUS_POLL_MS);
  pollCompanionStatusOnce();
}

function stopCompanionStatusPolling() {
  if (companionStatusPollTimer) {
    clearInterval(companionStatusPollTimer);
    companionStatusPollTimer = null;
  }
}

// B6 FIX (2026-07-27 audit) -- presentation-only map from the RAW League
// client gameflow vocabulary (Riot's own phase names, as reported by the
// companion's /status and stored VERBATIM in companionStatus.phase by
// pollCompanionStatusOnce) to words a user reads as status. This must stay
// presentation-only: `companionStatus.phase` itself is NOT touched here or
// anywhere else -- B2's isCompanionBusy() depends on that field staying the
// raw gameflow value (`=== 'ChampSelect'`), so collapsing it into a
// different vocabulary here would silently break that check. `'None'` is the
// ORDINARY idle state (League client open, no lobby/game) and must read as
// healthy -- before this fix it fell into buildCompanionStatusLabel's
// `default` branch and rendered verbatim as "Companion: None — client
// connected," which reads as a failure to anyone who doesn't already know
// "None" is gameflow-speak for idle.
const GAMEFLOW_PHASE_LABELS = {
  None: 'idle (client open, no lobby)',
  Lobby: 'in lobby',
  Matchmaking: 'in queue',
  CheckedIntoTournament: 'checked into tournament',
  ReadyCheck: 'ready check',
  ChampSelect: 'champ select',
  GameStart: 'game starting',
  Reconnect: 'reconnecting',
  InProgress: 'in game',
  WaitingForStats: 'game ended, waiting for stats',
  PreEndOfGame: 'post-game',
  EndOfGame: 'post-game',
};

function buildCompanionStatusLabel() {
  switch (companionStatus.phase) {
    case 'not-found':
      return `Companion: ${companionStatus.message || 'script not found'}`;
    case 'already-running':
      return 'Companion: another copy is already running';
    case 'restarting':
    case 'restart-deferred':
      return companionStatus.message || 'Companion: restarting…';
    case 'error':
      return `Companion: error (${companionStatus.message || 'see log file'})`;
    case 'starting':
      return 'Companion: starting…';
    default: {
      if (!companionStatus.lastPollAt) {
        return 'Companion: unreachable (bridge not responding yet)';
      }
      const connected = companionStatus.clientConnected ? 'client connected' : 'client not connected';
      const phaseLabel = GAMEFLOW_PHASE_LABELS[companionStatus.phase] || companionStatus.phase;
      return `Companion: ${phaseLabel} — ${connected}`;
    }
  }
}

// Separate, more alarming row shown ONLY while genuinely stalled -- per the
// brief, "lastPollAt not advancing across two reads is the single most
// useful thing to show." Kept as its own row rather than folded into the
// summary line above so it doesn't get lost among routine phase text.
function buildCompanionPollHealthLabel() {
  if (companionStatus.lastPollAtAdvancing === false) {
    return 'Companion: POLL STALLED — lastPollAt is not advancing';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legacy autostart cleanup + this app's own autostart registration.
//
// requestedExecutionLevel: requireAdministrator was REMOVED from
// package.json's build.win config this round -- it was added chasing a
// hotkey-vs-Vanguard theory that root-caused elsewhere (F12 is permanently
// reserved by Windows, see HOTKEY_TOGGLE_ADJUST's header), and an elevated
// app cannot be silently autostarted (UAC prompts at every sign-in), which is
// strictly worse than the companion's previous silent .vbs. See
// HANDOFF-engy.md for the full reasoning; this is not the file to re-litigate
// it in.
// ---------------------------------------------------------------------------

// Runs the companion's OWN -Uninstall path (removes
// %APPDATA%\...\Startup\CoachBuildCompanion.lnk/.vbs, nothing else -- no
// account-writing logic involved) rather than deleting files by hand here.
// Gated to run once (a settings-file flag) since it's a real (cheap)
// subprocess spawn -- idempotent either way (Uninstall-Companion no-ops with
// "No startup entry found" on a second run), but there's no reason to pay
// that cost on every single launch.
function removeLegacyVbsAutostartOnce() {
  // GATED TO PACKAGED ONLY (found the hard way, this round): this deletes a
  // REAL file in the REAL Windows Startup folder -- %APPDATA%\...\Startup\
  // CoachBuildCompanion.vbs is not sandboxed per-app, it's the one real
  // machine-wide autostart entry. Running this unconditionally during `npm
  // start` on a dev machine that ALSO has a real companion install (this one
  // does) deletes that machine's real autostart entry as a side effect of
  // testing, which is what happened during this round's manual verification
  // (see HANDOFF-engy.md) -- restored by hand afterward, but it should never
  // have been at risk. Only the packaged app -- which is the thing actually
  // taking over autostart duty via configureAutostart() below -- gets to
  // retire the old mechanism it's replacing.
  if (!app.isPackaged) return;
  if (readSettingsFile(userDataDir).legacyVbsAutostartRemoved === true) return;
  const scriptPath = getCompanionScriptPath();
  if (!fs.existsSync(scriptPath)) {
    warn('companion: cannot run -Uninstall to clear the old .vbs autostart -- script not found at', scriptPath);
    return;
  }
  log('companion: running -Uninstall once to remove the old silent .vbs autostart (this app now owns autostart)');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Uninstall'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.error) {
    warn('companion: -Uninstall spawn failed:', result.error.message);
    return;
  }
  log('companion: -Uninstall output:', (result.stdout || '').trim() || '(no output)');
  writeSettingsPatch(userDataDir, { legacyVbsAutostartRemoved: true });
}

// This app now owns autostart (replacing the companion's own .vbs, removed
// above). openAsHidden is a macOS-only concept for Electron login items --
// on Windows there is no separate "start hidden" flag to pass, but none is
// needed here: the overlay window is transparent/click-through/skipTaskbar
// by construction (see createWindow()) and the tray icon appearing is the
// intended always-visible control surface, not a "flash" of UI.
function configureAutostart() {
  if (!app.isPackaged) {
    log('autostart: skipping app.setLoginItemSettings in dev (unpackaged) -- only meaningful for an installed app');
    return;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    const settings = app.getLoginItemSettings();
    log(`autostart: openAtLogin=${settings.openAtLogin}`);
  } catch (err) {
    warn('autostart: setLoginItemSettings failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Elevated-at-login autostart via a Scheduled Task (2026-07-27 round 10,
// Fix 1) -- resolves the tradeoff between "silent autostart" and "elevated,
// so global hotkeys/window-focus work while League has focus" instead of
// choosing one side, which is what this app did twice before (added
// requireAdministrator chasing a hotkey theory that root-caused elsewhere,
// then removed it entirely for silent autostart -- see README's "Install on
// another PC" section and HANDOFF-engy.md).
//
// THE REAL MECHANISM, confirmed with real evidence this round: League runs
// ELEVATED under Vanguard; this app runs asInvoker. Windows UIPI (User
// Interface Privilege Isolation) blocks a lower-integrity process from
// receiving input while a higher-integrity window is foreground -- this
// explains BOTH symptoms in one shot: global hotkeys never fire in-game
// (Ctrl+F10/F11/Shift+A all register() === true, isRegistered() === true,
// yet do nothing while League has focus), AND adjust-mode saves never
// happen (the renderer's keydown listeners never receive Enter/arrows
// because the window can never actually gain OS focus from a
// higher-integrity foreground app -- see toggleAdjustOverlay()'s focus-check
// log, added this same round).
//
// THE FIX: a Scheduled Task with "Run with highest privileges" (/RL HIGHEST)
// and an at-logon trigger (/SC ONLOGON) launches the app ELEVATED with NO
// UAC prompt at sign-in -- this is the standard, documented Windows
// mechanism for "start elevated, silently, every login." UAC's consent
// requirement is specifically for INTERACTIVE launches; a task already
// configured with RunLevel=HighestAvailable is the built-in exception.
//
// CREATING the task itself DOES require elevation (schtasks.exe checks the
// CALLER's own privilege for /RL HIGHEST, it does not self-elevate) -- so
// enableElevatedAutostart() below shells out through PowerShell's
// Start-Process -Verb RunAs, which raises exactly ONE real UAC prompt, once,
// the moment the user opts in from the tray. Every subsequent login after
// that is silent.
//
// DELIBERATELY NOT `requestedExecutionLevel: requireAdministrator` back in
// the exe manifest -- the manifest stays `asInvoker` (see package.json /
// scripts/apply-exe-resources.js). Baking elevation into the manifest would
// ALSO force a UAC prompt on every MANUAL double-click launch, which is
// exactly the regression this app already shipped once and reverted (see
// "Install on another PC" in README). The scheduled task supplies elevation
// ONLY for the specific at-logon launch path; a manual launch stays a plain,
// promptless asInvoker start, same as today.
// ---------------------------------------------------------------------------

function psSingleQuote(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

// Runs `schtasks.exe <schtasksArgs>` ELEVATED via PowerShell's
// Start-Process -Verb RunAs (the ShellExecute "runas" verb -- THIS is what
// actually raises the UAC consent prompt; spawning schtasks.exe directly
// from this asInvoker process would just fail silently with "ERROR: Access
// is denied." for an /RL HIGHEST task, no prompt at all, no chance for the
// user to approve it).
//
// Routed through a temporary .ps1 FILE rather than an inline `-Command`
// string: three layers of argument passing (this function's JS array ->
// PowerShell's own command-line parsing -> Start-Process's -ArgumentList ->
// schtasks.exe's argv) make inline quoting extremely fragile, especially
// with an exe path that itself contains spaces ("CoachBuild Overlay.exe"
// installs under a path with spaces by default). A real script file using a
// native PowerShell array literal sidesteps all of that -- one clean
// boundary instead of three fragile ones.
//
// `-Wait -PassThru` + `exit $p.ExitCode` propagate schtasks' REAL exit code
// out to this function's return value, not just "Start-Process managed to
// launch something." A UAC prompt the user dismisses/denies surfaces here as
// a real, non-zero, reported failure -- never silently treated as success.
function runElevatedSchtasks(schtasksArgs) {
  const scriptPath = path.join(userDataDir, 'coachbuild-schtasks-elevate.ps1');
  const argsLiteral = schtasksArgs.map(psSingleQuote).join(', ');
  const script = [
    `$taskArgs = @(${argsLiteral})`,
    'try {',
    "  $p = Start-Process -FilePath 'schtasks.exe' -ArgumentList $taskArgs -Verb RunAs -Wait -PassThru",
    '  exit $p.ExitCode',
    '} catch {',
    '  Write-Error $_.Exception.Message',
    '  exit 1223', // ERROR_CANCELLED -- the same code Windows uses when a UAC prompt is denied; a thrown Start-Process exception (e.g. the user clicked "No") lands here distinctly from a genuine schtasks failure.
    '}',
  ].join('\r\n');

  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
  } catch (err) {
    warn('elevated autostart: failed to write temp elevation script:', err.message);
    return { success: false, exitCode: null, error: err.message };
  }

  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
    encoding: 'utf8',
  });

  try {
    fs.unlinkSync(scriptPath);
  } catch {
    // Best-effort cleanup only -- a leftover temp script is harmless (plain
    // argv text, no credentials in it), never worth failing the whole
    // operation over.
  }

  if (result.error) {
    return { success: false, exitCode: null, error: result.error.message };
  }
  return { success: result.status === 0, exitCode: result.status, stderr: (result.stderr || '').trim() };
}

// Read-only query -- does NOT require elevation (only /Create and /Delete of
// an /RL HIGHEST task do), so this can run unconditionally at every startup
// to detect real on-disk state rather than trusting a remembered flag.
function isElevatedTaskRegistered() {
  const result = spawnSync('schtasks', ['/Query', '/TN', ELEVATED_TASK_NAME], { windowsHide: true, encoding: 'utf8' });
  return result.status === 0;
}

function enableElevatedAutostart() {
  if (!app.isPackaged) {
    warn('elevated autostart: not meaningful in dev (unpackaged) -- process.execPath points at electron.exe, not this app -- skipping');
    return { success: false, error: 'unavailable in a dev build' };
  }
  const exePath = process.execPath;
  log(
    `elevated autostart: creating scheduled task "${ELEVATED_TASK_NAME}" -> "${exePath}" (ONE UAC prompt expected right now, to create the task -- it then launches silently, elevated, at every future login)`
  );
  const outcome = runElevatedSchtasks(['/Create', '/TN', ELEVATED_TASK_NAME, '/TR', `"${exePath}"`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
  if (!outcome.success) {
    warn(
      `elevated autostart: task creation failed (exit ${outcome.exitCode}${outcome.error ? ', ' + outcome.error : ''}${
        outcome.stderr ? ', ' + outcome.stderr : ''
      }) -- likely the UAC prompt was dismissed or denied`
    );
    return outcome;
  }
  log('elevated autostart: scheduled task created successfully');
  // The two autostart mechanisms MUST NOT both fire at login -- a double
  // launch would hit the single-instance lock and one copy would silently
  // die, the exact class of bug already hit once with the old companion .vbs
  // racing this app's own setLoginItemSettings (see "Companion supervision"
  // in README). The elevated task now owns autostart; turn the plain one off.
  try {
    app.setLoginItemSettings({ openAtLogin: false });
    log('elevated autostart: disabled the plain (non-elevated) setLoginItemSettings autostart -- the scheduled task now owns login launch');
  } catch (err) {
    warn('elevated autostart: failed to disable the plain autostart after enabling the elevated task:', err.message);
  }
  return outcome;
}

function disableElevatedAutostart() {
  log(`elevated autostart: deleting scheduled task "${ELEVATED_TASK_NAME}"`);
  const outcome = runElevatedSchtasks(['/Delete', '/TN', ELEVATED_TASK_NAME, '/F']);
  if (!outcome.success) {
    warn(`elevated autostart: task deletion reported exit ${outcome.exitCode}${outcome.error ? ', ' + outcome.error : ''} (harmless if the task was already gone)`);
  } else {
    log('elevated autostart: scheduled task removed');
  }
  // Never leave the user with NEITHER autostart mechanism active after
  // turning this off -- restore the normal fallback.
  configureAutostart();
  return outcome;
}

function toggleElevatedAutostart() {
  if (elevatedAutostartEnabled) {
    disableElevatedAutostart();
  } else {
    enableElevatedAutostart();
  }
  // Re-derive from real on-disk state rather than assuming the operation
  // above succeeded -- same "measure, don't guess" bar as the hotkey
  // bind-status rows.
  elevatedAutostartEnabled = isElevatedTaskRegistered();
  rebuildTrayMenu();
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
// Fix 3 (2026-07-27 round 10) companion helper -- called on every adjust-mode
// EXIT that does NOT go through the save path (toggled-off via hotkey/tray,
// or Esc-cancel). See the display-metrics-changed guard below: WHILE
// adjusting, a mid-session display/resolution change is deliberately NOT
// reconciled against `calibrationGeometry` (to avoid reloading over the
// renderer's live unsaved working copy out from under the user). This is
// where that deferred reconciliation catches up, exactly once, at the moment
// the session actually ends -- so a cancel/toggle-off can never re-push a
// geometry that's stale for whatever the CURRENT display now is. (The save
// path doesn't need this: it always recomputes fresh from
// getPrimaryDisplayBounds() read at the moment of save, independent of
// `calibrationGeometry`'s prior value.)
function resyncCalibrationOnAdjustExit() {
  applyCalibrationForCurrentDisplay();
}

function toggleAdjustOverlay() {
  if (isCalibrating) {
    warn('cannot enter adjust-in-place mode while the separate calibration window is open -- close it first');
    return;
  }

  isAdjustingOverlay = !isAdjustingOverlay;
  // REASON-TAGGED (2026-07-27 round 10, Fix 2): this line used to just say
  // "-> off" regardless of WHY -- a re-toggle (hotkey/tray), a save (Enter),
  // and a cancel (Esc) all read identically in the log, which cost real
  // diagnostic time on a real bug report where the actual save/cancel
  // handlers below never ran at all. THIS call site is specifically the
  // TOGGLE path (hotkey re-press or tray click) -- the IPC handlers for
  // save/cancel below log their own 'saved'/'cancelled' reason instead, so
  // grepping the log for "adjust overlay position ->" now gives an
  // unambiguous per-transition trace no matter which of the three exit paths
  // actually fired.
  log(
    'adjust overlay position ->',
    isAdjustingOverlay
      ? 'ON (main window now captures keyboard input)'
      : 'off (reason: toggled-off -- the hotkey/tray item was used again, NOT Enter/Esc reaching the renderer)'
  );

  if (isAdjustingOverlay && !overlayVisibleWanted) {
    // The user can't align boxes they can't see -- force the overlay visible
    // rather than silently doing nothing.
    overlayVisibleWanted = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive();
  }

  applyMainWindowInteractivity();

  if (isAdjustingOverlay) {
    // FOCUS CHECK (2026-07-27 round 10, Fix 2): applyMainWindowInteractivity()
    // just called mainWindow.focus() above, but focus() is a REQUEST, not a
    // guarantee -- Windows can refuse to actually activate a window, which is
    // exactly what UIPI does when a higher-integrity process (League, under
    // Vanguard) owns the foreground. A failed focus grab is INDISTINGUISHABLE
    // from the user's seat from "adjust mode does nothing": the renderer's
    // keydown listeners for arrows/+/-/[/]/Enter/Esc simply never fire
    // because the window never became the OS-focused window, and (as this
    // round's real log confirms) that is exactly what was happening -- the
    // save handler below never once logged. This was previously invisible.
    // Logged once per adjust session, after a short delay to give Windows a
    // beat to complete (or refuse) the activation before checking.
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const focused = mainWindow.isFocused();
      log(
        `adjust-in-place focus check: window ${focused ? 'DID gain' : 'did NOT gain'} OS focus after focus() -- ` +
          (focused
            ? 'keyboard input should reach the renderer'
            : "this is precisely the failure mode where arrows/Enter/Esc never arrive at the renderer (UIPI blocking a lower-integrity window from taking focus over a higher-integrity foreground app -- see README's \"Hotkeys and bind status\" section and the tray's \"Run elevated at login\" item)")
      );
    }, 150);
  } else {
    // Exiting via re-toggle (not save/cancel, which handle their own
    // resync -- see resyncCalibrationOnAdjustExit()'s header): catch up on
    // any display change that happened mid-session and was deliberately
    // deferred by the display-metrics-changed guard below (Fix 3), so the
    // re-push a few lines down never sends a geometry that's stale for the
    // CURRENT display.
    resyncCalibrationOnAdjustExit();
  }
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
  // Reason-tagged (Fix 2, see toggleAdjustOverlay()'s matching comment) --
  // this is the line that was MISSING from the real bug log: every "-> off"
  // observed there was the toggled-off variant, never this one, which is
  // exactly the evidence that Enter never reached the renderer.
  log('adjust overlay position -> off (reason: saved)');
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
  // Reason-tagged (Fix 2) + resync (Fix 3) -- see resyncCalibrationOnAdjustExit()'s
  // header for why this call is here: it catches up on any display change
  // that happened mid-session and was deliberately deferred, so the
  // pushCalibration() below sends geometry that's correct for the CURRENT
  // display, not stale for whatever it was when adjusting started.
  log('adjust overlay position -> off (reason: cancelled)');
  resyncCalibrationOnAdjustExit();
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
    'if Ctrl+F10/Ctrl+F11/Ctrl+Shift+A do not respond while League has focus (or "Adjust overlay position" never saves): check the tray menu or "Open log file" first for the actual per-hotkey bind status (a hotkey that failed to register will never respond regardless of elevation) and the "adjust-in-place focus check" line if you were testing adjust mode. If hotkeys DID bind, or the focus check reports the window did NOT gain focus, that is UIPI: League runs elevated under Vanguard and Windows will not deliver keyboard input to a lower-integrity window while a higher-integrity one is foreground -- confirmed as the real cause this round, not just a guess. Fix: tray -> "Run elevated at login (fixes in-game hotkeys)" -- creates a Scheduled Task that launches this app elevated at every login with only ONE UAC prompt, ever (to create the task). The SYSTEM TRAY ICON works regardless of any of this and is the reliable fallback either way.'
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

// ---------------------------------------------------------------------------
// Tray menu redesign (2026-07-27, A1) -- see HANDOFF-engy.md for the full
// brief. The tray is this app's PRIMARY control surface: the window is
// transparent/click-through/skipTaskbar (see createWindow()'s header) and
// the global hotkeys are unreliable under Vanguard's UIPI (see
// logElevationGuidance()'s header), so a user reaching for a control mid-game
// has nowhere else to go. The OLD menu was a single flat list of 17 labels
// and 6 separators -- everything got equal weight regardless of how often
// it's actually touched mid-match versus once-ever setup/diagnostics.
//
// The reorganisation below is a REGROUPING, not a feature cull -- every
// capability the old menu had is still reachable, several are literally
// unchanged (Lane override still has its five lanes plus Auto; the
// transient "Adjusting…"/"Calibrating…" labels still work exactly as
// before). What moved:
//   - Companion status: TWO disabled rows (buildCompanionStatusLabel +
//     buildCompanionPollHealthLabel) collapsed to ONE at top level -- the
//     "is this thing working" summary stays where it's always visible; the
//     rarely-needed stall detail moved into Troubleshooting.
//   - Interactive mode / Show skill table / Lane override / Calibrate
//     (fallback) / Run elevated at login -- all setup-once toggles, not
//     mid-game actions -- moved under "Settings".
//   - The update status line + "Check for updates now" moved under
//     "Updates".
//   - Open log file / the per-hotkey bind-status rows / the elevation guess
//     row -- all diagnostics for when something is already wrong, never
//     touched on a healthy run -- moved under "Troubleshooting".
// What STAYED top-level, one click away, because they're the things a user
// reaches for mid-game: Hide/Show overlay and Adjust overlay position.
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

  const settingsSubmenu = [
    {
      label: 'Interactive mode (clickable)',
      type: 'checkbox',
      checked: isInteractive,
      click: () => toggleInteractive(),
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
      label: 'Lane override',
      submenu: laneSubmenu,
    },
    { type: 'separator' },
    {
      // FALLBACK path now, not primary (round 8) -- a separate window covers
      // the game, so a one-monitor user can't see what they're aligning to.
      // Kept for a second monitor / dry-run-without-a-game use case.
      label: isCalibrating ? 'Calibrating… (use the on-screen Save/Cancel)' : 'Calibrate ability bar (separate window, fallback)…',
      enabled: !isCalibrating && !isAdjustingOverlay,
      click: () => enterCalibration(),
    },
    { type: 'separator' },
    {
      // Fix 1 (2026-07-27 round 10) -- the actual answer to "hotkeys/adjust-
      // mode work outside the game but not in it": League runs elevated
      // under Vanguard, this app runs asInvoker, Windows UIPI blocks input
      // delivery across that gap. This task, not requireAdministrator in the
      // manifest, is how elevation is obtained WITHOUT a UAC prompt on every
      // manual launch. See enableElevatedAutostart()'s header for the full
      // reasoning. Relabeled "Start with Windows" (A1) -- its net effect
      // from the user's seat, and the wording the brief's suggested shape
      // used -- while keeping the full original parenthetical so the "why"
      // (in-game hotkeys) isn't lost.
      label: elevatedAutostartEnabled
        ? 'Start with Windows (elevated, fixes in-game hotkeys) — ENABLED'
        : 'Start with Windows (elevated, fixes in-game hotkeys)…',
      type: 'checkbox',
      checked: elevatedAutostartEnabled,
      enabled: app.isPackaged,
      click: () => toggleElevatedAutostart(),
    },
  ];

  const updatesSubmenu = [
    {
      // Same "surfaced, not silent" bar as the diagnostics rows in
      // Troubleshooting -- see lib/autoUpdater.js's getStatusLabel().
      // Non-clickable status row, live-updated via onStatusChange ->
      // rebuildTrayMenu() wired in app.whenReady().
      label: autoUpdaterModule.getStatusLabel(app.getVersion()),
      enabled: false,
    },
    {
      label: 'Check for updates now',
      enabled: app.isPackaged,
      click: () => autoUpdaterModule.checkForUpdates('manual, from tray'),
    },
  ];

  const troubleshootingSubmenu = [
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
    // B1/B6-aware companion poll-stall detail (A1) -- the second companion
    // row from the old flat menu, moved here per the brief ("collapse to one
    // clear line at top level and put any detail in Troubleshooting"). Only
    // rendered while genuinely stalled -- see buildCompanionPollHealthLabel()'s
    // own header for why it's split out from the top-level summary line.
    ...(buildCompanionPollHealthLabel() ? [{ label: buildCompanionPollHealthLabel(), enabled: false }, { type: 'separator' }] : []),
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
  ];

  return [
    {
      // Version, first and non-clickable. Cheap to add and it answers the
      // question every other diagnostic row depends on: WHICH BUILD is this?
      // Without it, "auto-update is working" is unfalsifiable from the UI --
      // the user cannot tell an app that updated from one that silently did
      // not, which is exactly the failure the app-update.yml bug produced.
      label: `CoachBuild Overlay v${app.getVersion()}`,
      enabled: false,
    },
    // Companion status (2026-07-27, "one app" round; collapsed to one line
    // in the A1 redesign -- see this function's header comment). Stays at
    // TOP level, right under the version, because it's the main "is this
    // thing working" signal and must never be buried behind a submenu click.
    { label: buildCompanionStatusLabel(), enabled: false },
    { type: 'separator' },
    {
      label: overlayVisibleWanted ? 'Hide overlay' : 'Show overlay',
      click: () => toggleOverlayVisibility(),
    },
    {
      // PRIMARY alignment path as of 2026-07-27 round 8 -- adjusts the SAME
      // boxes already drawn over the running game, live, instead of a
      // separate window that covers it. See toggleAdjustOverlay()'s header.
      // Kept top-level (A1): this and Hide/Show overlay are the only two
      // things a user reaches for mid-game.
      label: isAdjustingOverlay ? 'Adjusting… (Enter to save, Esc to cancel)' : 'Adjust overlay position',
      type: 'checkbox',
      checked: isAdjustingOverlay,
      enabled: !isCalibrating,
      click: () => toggleAdjustOverlay(),
    },
    { type: 'separator' },
    { label: 'Settings', submenu: settingsSubmenu },
    { label: 'Updates', submenu: updatesSubmenu },
    { label: 'Troubleshooting', submenu: troubleshootingSubmenu },
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
//
// B5 FIX (2026-07-27 audit): initLogFile() used to run HERE, unconditionally,
// BEFORE this lock check -- so a second launch (a double-click while the app
// is already running, a stray shortcut, Explorer re-opening it: all ordinary,
// harmless events) truncated LOG_FILE_PATH (fs.writeFileSync(path, '') --
// see initLogFile()'s own header) out from under the REAL running instance's
// already-open append-mode write stream, destroying its diagnostics, right
// before the second copy discovered it had lost the lock race and quit. "Open
// log file" then showed an empty file for the copy the user actually cares
// about. Moved inside the `else` branch below, so it only runs once this
// process actually holds the lock.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Console-only here (deliberately no initLogFile()/log() call -- see the
  // comment above): this losing instance never touches the log file at all,
  // so the running instance's own history stays intact.
  console.warn('[CoachBuild:main] another instance is already running — quitting');
  app.quit();
} else {
  initLogFile(); // must run before the first log()/warn() call below, and only
  // once this process holds the single-instance lock (see the comment above).

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

    // Companion supervision (2026-07-27, "one app" round) -- see the
    // "Companion supervision" / "Legacy autostart cleanup" sections above.
    // Order matters: remove the OLD silent .vbs autostart before registering
    // THIS app's own, so a machine that hasn't rebooted yet never has both
    // racing for the mutex at the next sign-in.
    removeLegacyVbsAutostartOnce();
    // Detect real on-disk state, not an assumed one -- and never register
    // BOTH autostart mechanisms: if the elevated scheduled task is already
    // in place (enabled in a previous session), configureAutostart()'s plain
    // setLoginItemSettings must stay OFF, or the app would double-launch at
    // the next login and lose the single-instance-lock race with itself.
    elevatedAutostartEnabled = isElevatedTaskRegistered();
    if (elevatedAutostartEnabled) {
      log('elevated autostart: scheduled task already registered -- using it, skipping the plain setLoginItemSettings autostart to avoid a double-launch at login');
    } else {
      configureAutostart();
    }
    spawnCompanion();

    // Seamless auto-update (2026-07-27) -- see lib/autoUpdater.js's header
    // for the full "never interrupt a game" contract. `onStatusChange` wired
    // to rebuildTrayMenu() so the tray's status row (see
    // buildTrayMenuTemplate()) reflects checking/downloading/ready/error
    // live, without polling -- same "surfaced, not silent" bar as the hotkey
    // bind-status rows above it.
    autoUpdaterModule.init({
      log,
      warn,
      // B2 FIX (2026-07-27 audit): was `() => inGame` -- widened to the
      // shared isCompanionBusy() so a seamless update can never
      // quitAndInstall() during champ select either, not just mid-match. See
      // isCompanionBusy()'s own comment above for the full reasoning.
      getIsBusy: () => isCompanionBusy(),
      onStatusChange: () => rebuildTrayMenu(),
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
    });

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
      // GUARD (2026-07-27 round 10, Fix 3): a game entering/leaving
      // borderless fullscreen fires this repeatedly -- a real user log this
      // round showed it firing 4 times in one session. Repositioning the
      // window to the new display bounds is ALWAYS safe/necessary (a
      // stale-sized fullscreen window could stop covering the game). But
      // applyCalibrationForCurrentDisplay() RELOADS `calibrationGeometry`
      // from disk (or the scaled default, if the resolution doesn't match a
      // saved one) -- doing that WHILE `isAdjustingOverlay` is true would
      // silently overwrite the authoritative in-memory geometry mid-edit: if
      // a transient/spurious resolution report came through during exactly
      // this kind of fullscreen flicker, the user's unsaved working session
      // would be resting on top of geometry that just got swapped out from
      // under it, and a subsequent Cancel would then re-push THAT
      // possibly-wrong value instead of what was on screen before the user
      // started adjusting -- the box visibly snapping to an unexpected spot
      // for no reason the user did.
      //
      // Deferred, not dropped: whichever way the adjust session actually
      // ends, the reconciliation still happens exactly once, correctly --
      // Save always recomputes fresh from bounds read at the moment of save
      // (independent of `calibrationGeometry`'s prior value); toggle-off and
      // Cancel both call resyncCalibrationOnAdjustExit() (the same
      // applyCalibrationForCurrentDisplay() call, just run once at the
      // moment the session ends instead of possibly mid-nudge).
      if (isAdjustingOverlay) {
        log('display metrics changed while adjust-in-place is active -- repositioning window only, calibration re-check deferred until the adjust session ends');
        repositionMainWindowToDisplay();
        return;
      }
      log('display metrics changed -- repositioning overlay window and re-checking calibration');
      repositionMainWindowToDisplay();
      applyCalibrationForCurrentDisplay();
      pushState();
      // B3 FIX (2026-07-27 audit): this handler is the THIRD place that broke
      // the renderer/main contract stated three times elsewhere in this file
      // (exitCalibration, coachbuild-adjust-save) -- the renderer reads
      // highlight-box geometry ONLY off the dedicated 'coachbuild-calibration'
      // channel, never off `state.calibration`. applyCalibrationForCurrentDisplay()
      // can swap in a scaled default geometry when the new resolution has no
      // saved calibration, and without this call the renderer was never told
      // -- boxes kept drawing at the OLD resolution's position until some
      // unrelated event happened to fire pushCalibration(), then visibly
      // jumped. pushState() alone (above) is not enough, same as at the other
      // two sites.
      pushCalibration();
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
    autoUpdaterModule.shutdown();
    killCompanionChild();
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
