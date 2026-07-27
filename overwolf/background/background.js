// CoachBuild Overlay — background controller.
//
// This is the ONLY file that talks to overwolf.games.events (GEP). It owns:
//   - detecting League launching/running/exiting
//   - registering + retrying GEP's required feature (live_client_data)
//   - seeding state via getInfo() (onInfoUpdates2 only fires on CHANGE, so without
//     a seed the overlay stays blank until the first level-up)
//   - polling the local Live Client Data HTTP API for the player list (champion
//     name isn't in the GEP feature — see js/gameState.js)
//   - both hotkeys
//   - opening/closing the in-game and desktop windows
//   - pushing state to the in-game window
//
// Everything game-shape-specific (parsing, the string/object duality, the
// all-or-nothing ability-rank rule) lives in js/gameState.js and is imported, not
// reimplemented here. This file is orchestration glue, not parsing logic.

import {
  obtainDeclaredWindow,
  restoreWindow,
  hideWindow,
  setClickThrough,
  sendMessageToWindow,
  getRunningGameInfo,
} from '../js/owWindows.js';
import {
  parseLevelAndAbilities,
  extractLocalRiotId,
  resolveChampionName,
  mergeState,
  emptyStateFor,
  toFiniteInt,
} from '../js/gameState.js';
import { fetchPlayerList } from '../js/liveClientHttp.js';

const LOL_GAME_ID = 5426;
const LOL_LAUNCHER_ID = 10902;
const REQUIRED_FEATURES = ['live_client_data'];
const FEATURE_RETRY_MS = 3000;
const FEATURE_RETRY_MAX_ATTEMPTS = 10; // ~30s of retrying per game session before giving up
const PLAYERLIST_POLL_MS = 4000;
// companion.ps1 (the existing, production-verified LCU bridge in this same repo)
// hardcodes 2999 at four separate call sites and is live-verified. Today's captured
// payload also came off 2999. GEP's live_client_data.port SHOULD carry the real port
// and is preferred whenever it resolves to a usable value -- this default only
// covers the case where that leaf is absent/unusable, not a claim that 2999 is
// always correct.
const DEFAULT_LIVE_CLIENT_PORT = 2999;

const WINDOW_NAMES = { INGAME: 'ingame', DESKTOP: 'desktop' };
const HOTKEYS = { TOGGLE_OVERLAY: 'toggle_overlay', TOGGLE_INTERACTIVE: 'toggle_interactive' };
const MESSAGES = {
  STATE: 'coachbuild-state',
  INTERACTIVE: 'coachbuild-interactive',
  // Sent BY the in-game window TO us, once its listener is attached. See the
  // handshake below for why this is load-bearing rather than ceremony.
  READY: 'coachbuild-ready',
};

function log(...args) {
  console.log('[CoachBuild:bg]', ...args);
}

function warn(...args) {
  console.warn('[CoachBuild:bg]', ...args);
}

// --- mutable controller state (NOT the same as gameState.js's game state) ---
let gameState = emptyStateFor(false);
let isInteractive = false; // starts clickthrough — see manifest.README.md
let overlayVisibleWanted = true; // user's last toggle_overlay intent
let ingameWindowId = null;
let inGame = false;
let livePort = null;

let featureRetryTimer = null;
let featureRetryAttempts = 0;
let playerListTimer = null;

// ---------------------------------------------------------------------------
// League detection
// ---------------------------------------------------------------------------

function isLeagueId(id) {
  if (typeof id !== 'number') return false;
  if (id === LOL_GAME_ID || id === LOL_LAUNCHER_ID) return true;
  // Defensive only: Overwolf sometimes reports a class id with a trailing variant
  // digit appended (classId*10+n) rather than the bare id. NOT confirmed against
  // a live game on this machine — flagged in HANDOFF-engy.md as unverified.
  return Math.floor(id / 10) === LOL_GAME_ID || Math.floor(id / 10) === LOL_LAUNCHER_ID;
}

async function evaluateRunningGame() {
  try {
    const info = await getRunningGameInfo();
    const running = !!(info && info.isRunning && isLeagueId(info.id));
    if (running && !inGame) {
      await handleGameEnter();
    } else if (!running && inGame) {
      await handleGameExit();
    }
  } catch (err) {
    warn('evaluateRunningGame failed (treated as "no game")', err);
  }
}

// ---------------------------------------------------------------------------
// Game enter / exit
// ---------------------------------------------------------------------------

async function handleGameEnter() {
  inGame = true;
  gameState = emptyStateFor(true);
  log('League detected running — entering game session');

  await openIngameWindow();
  registerFeaturesWithRetry();
  startPlayerListPolling();
  pushState();
}

async function handleGameExit() {
  inGame = false;
  gameState = emptyStateFor(false);
  livePort = null;
  log('League no longer running — ending game session');

  stopFeatureRetry();
  stopPlayerListPolling();
  pushState(); // best-effort; window is about to hide/close anyway
  await closeIngameWindow();
}

// ---------------------------------------------------------------------------
// GEP: feature registration (races on launch — retry a handful of times)
// ---------------------------------------------------------------------------

function registerFeaturesWithRetry() {
  featureRetryAttempts = 0;
  attemptRegisterFeatures();
}

function attemptRegisterFeatures() {
  overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, (result) => {
    const ok = !!(result && result.success && Array.isArray(result.supportedFeatures) && result.supportedFeatures.length > 0);
    if (ok) {
      featureRetryAttempts = 0;
      log('GEP features registered:', result.supportedFeatures.join(', '));
      seedInitialState();
      return;
    }
    featureRetryAttempts += 1;
    if (featureRetryAttempts <= FEATURE_RETRY_MAX_ATTEMPTS) {
      log(`setRequiredFeatures not ready (attempt ${featureRetryAttempts}/${FEATURE_RETRY_MAX_ATTEMPTS}), retrying in ${FEATURE_RETRY_MS}ms`);
      featureRetryTimer = setTimeout(attemptRegisterFeatures, FEATURE_RETRY_MS);
    } else {
      warn('setRequiredFeatures gave up — overlay will stay empty this session', result);
    }
  });
}

function stopFeatureRetry() {
  if (featureRetryTimer) {
    clearTimeout(featureRetryTimer);
    featureRetryTimer = null;
  }
  featureRetryAttempts = 0;
}

function seedInitialState() {
  // onInfoUpdates2 only fires on CHANGE — without this, a game already in progress
  // (e.g. the app was launched mid-match) would show nothing until the next level-up.
  //
  // FIX (P1, 2026-07-27 audit): the envelope this callback hands back was taken from
  // the brief, not observed — Overwolf's documented getInfo() shape nests under a
  // `res` property in some references (`{status:"success", res:{live_client_data}}`)
  // and flat in others (`{success:true, live_client_data:{...}}`). Guessing wrong
  // silently breaks the exact thing this function exists to prevent, with no error.
  // So: accept BOTH shapes rather than settle the docs question, and log which one
  // actually showed up — that turns the first live run into the experiment that
  // resolves this for good.
  overwolf.games.events.getInfo((res) => {
    if (!res) {
      log('getInfo() returned no data yet (normal early in a match)');
      return;
    }
    const success = res.success === true || res.status === 'success';
    if (!success) {
      log('getInfo() returned no data yet (normal early in a match)');
      return;
    }
    const nestedLiveClientData = res.res && typeof res.res === 'object' ? res.res.live_client_data : undefined;
    const liveClientData = nestedLiveClientData !== undefined ? nestedLiveClientData : res.live_client_data;
    log(
      'getInfo() envelope observed as',
      nestedLiveClientData !== undefined ? 'NESTED under res.res.live_client_data' : 'FLAT under res.live_client_data'
    );
    applyLiveClientData(liveClientData);
  });
}

if (typeof overwolf !== 'undefined' && overwolf.games && overwolf.games.events) {
  overwolf.games.events.onInfoUpdates2.addListener((event) => {
    if (!event || !event.info) return;
    applyLiveClientData(event.info.live_client_data);
  });
}

// ---------------------------------------------------------------------------
// Applying a live_client_data blob (level/abilities half of state)
// ---------------------------------------------------------------------------

function applyLiveClientData(liveClientDataRaw) {
  if (!liveClientDataRaw) return;
  const liveClientData = typeof liveClientDataRaw === 'string'
    ? safeJsonParse(liveClientDataRaw)
    : liveClientDataRaw;
  if (!liveClientData || typeof liveClientData !== 'object') return;

  resolvePort(liveClientData.port);

  const parsed = parseLevelAndAbilities(liveClientData.active_player);
  if (parsed) {
    gameState = mergeState(gameState, {
      inGame: true,
      championLevel: parsed.level,
      abilityRanks: parsed.abilityRanks,
    });
    pushState();
  }

  const riotId = extractLocalRiotId(liveClientData.active_player);
  if (riotId && !gameState.championName) {
    // Fast-path: try to resolve champion name immediately once we have a riotId,
    // rather than waiting for the next poll tick.
    resolveChampionNameNow(riotId);
  }
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// FIX (P1, 2026-07-27 audit): `port` is a GEP leaf like any other and was the one
// place this file skipped gameState.js's own "always coerce" rule -- a string
// `"2999"` or an absent field left `livePort` null forever, which silently starved
// BOTH resolveChampionNameNow() and pollPlayerList() at their `if (!livePort)`
// guards. fetchPlayerList() was then never even attempted, so its catch-block log
// (the one thing README.md told a tester to look for) could never fire either --
// the documented diagnostic pointed at a subsystem that was never reached.
// Now: coerce through toFiniteInt, fall back to DEFAULT_LIVE_CLIENT_PORT when GEP's
// value is missing/unusable, and log the resolved port once per change (not every
// tick) so a live run can actually see which path was taken.
function resolvePort(portRaw) {
  const coerced = toFiniteInt(portRaw);
  const resolved = coerced !== null && coerced > 0 ? coerced : DEFAULT_LIVE_CLIENT_PORT;
  if (resolved !== livePort) {
    const usedFallback = coerced === null || coerced <= 0;
    log(
      `live client data port resolved to ${resolved}` +
        (usedFallback ? ' (GEP did not supply a usable port -- using the default)' : ' (from GEP)')
    );
    livePort = resolved;
  }
}

// ---------------------------------------------------------------------------
// Champion name resolution — polls /liveclientdata/playerlist (see js/liveClientHttp.js
// for why this can't come from the GEP feature alone).
// ---------------------------------------------------------------------------

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
  if (!inGame || !livePort) return;
  // We don't have the riotId handy here without re-reading active_player, so this
  // relies on the fast-path in applyLiveClientData() having already fired once a
  // riotId is known; this poll exists to retry until the playerlist call itself
  // succeeds (it can 404/refuse-connect briefly at champion-select->game transition).
  if (gameState.championName || !lastKnownRiotId) return;
  await resolveChampionNameNow(lastKnownRiotId);
}

let lastKnownRiotId = null;

async function resolveChampionNameNow(riotId) {
  lastKnownRiotId = riotId;
  if (!livePort) return;
  try {
    const playerList = await fetchPlayerList(livePort);
    const championName = resolveChampionName(playerList, riotId);
    if (championName) {
      gameState = mergeState(gameState, { championName });
      pushState();
    }
  } catch (err) {
    // Expected transiently (endpoint not up yet at the very start of a match) —
    // never surfaced to the user, just retried on the next poll/tick.
    log('playerlist fetch not ready yet:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

async function openIngameWindow() {
  try {
    const win = await obtainDeclaredWindow(WINDOW_NAMES.INGAME);
    ingameWindowId = win.id;
    await restoreWindow(WINDOW_NAMES.INGAME);
    // Re-assert the desired clickthrough state at runtime, defensively, in addition
    // to the manifest default — belt-and-braces, see owWindows.js.
    await setClickThrough(ingameWindowId, !isInteractive).catch((err) => warn('setClickThrough on open failed', err));
    if (!overlayVisibleWanted) {
      await hideWindow(WINDOW_NAMES.INGAME).catch(() => {});
    }
  } catch (err) {
    warn('openIngameWindow failed', err);
  }
}

async function closeIngameWindow() {
  try {
    await hideWindow(WINDOW_NAMES.INGAME);
  } catch (err) {
    // Not fatal — window may already be gone because the game process exited.
    log('closeIngameWindow: hide failed (likely already closed)', err.message);
  }
}

// FIX (P2, 2026-07-27 audit): init() used to unconditionally restore() the desktop
// window on every startup, including the GameLaunch-triggered auto-launch — directly
// contradicting manifest.README.md's promise ("no window pops up uninvited") and the
// manifest's own `start_minimized: true` on that launch_event. On a single-monitor
// user, that meant a 480x620 window popping over League's loading screen every time
// the client opened.
//
// `overwolf.extensions.onAppLaunchTriggered` is Overwolf's purpose-built signal for
// "why did this app just start" (its `origin` field is documented to include
// `"gamelaunchevent"` for an automated launch_events start). This was NOT observed
// against a live launch on this machine — see HANDOFF-engy.md. Because it's
// unverified, the DEFAULT on any ambiguity (event never fires, field shape differs,
// origin unrecognized) is to NOT auto-open — matching the promise actually made in
// the docs. The window is still declared (not restored) at startup either way, so
// it's ready to show instantly once something decides to; a user can also always
// reach it from Overwolf's app library regardless of this decision.
let desktopAutoOpenDecided = false;

function decideDesktopAutoOpen(origin) {
  if (desktopAutoOpenDecided) return;
  desktopAutoOpenDecided = true;
  const normalizedOrigin = typeof origin === 'string' ? origin.toLowerCase() : null;
  const isAutomatedGameLaunch = normalizedOrigin === 'gamelaunchevent';
  const shouldOpen = normalizedOrigin !== null && !isAutomatedGameLaunch;
  log(
    'desktop auto-open decision — launch origin:',
    normalizedOrigin || '(unknown/unavailable — defaulting to NOT auto-opening)',
    shouldOpen ? '-> opening' : '-> suppressed'
  );
  if (shouldOpen) {
    restoreWindow(WINDOW_NAMES.DESKTOP).catch((err) => warn('restoreWindow(desktop) failed', err));
  }
}

async function declareDesktopWindow() {
  try {
    await obtainDeclaredWindow(WINDOW_NAMES.DESKTOP);
  } catch (err) {
    warn('declareDesktopWindow failed', err);
  }
}

// ---------------------------------------------------------------------------
// Publishing to the in-game window
// ---------------------------------------------------------------------------
//
// There is no supported Overwolf API to reach into another window's JS global
// scope directly from the background page — overwolf.windows.sendMessage /
// onMessageReceived is the real, documented cross-window transport, so that's
// what's used here. The CONTRACT surface engo implements
// (`window.CoachBuildOverlay.onState` / `.onInteractiveChange`) is still exactly
// what's called — just from INSIDE the in-game window, in response to a received
// message, not from outside it. See HANDOFF-engy.md for the full reasoning and
// the exact listener engo needs.

// FIX (S, 2026-07-27 audit): both send sites used to pass the declared window NAME
// to overwolf.windows.sendMessage, whose documented destination parameter is a
// windowId — and this file already holds the real id (`ingameWindowId`, captured in
// openIngameWindow()) without using it. Prefer the id; fall back to the name only
// when the id isn't known yet (very early in a session, before openIngameWindow()
// has resolved), and say so loudly since that's exactly the "not reachable yet"
// case a real delivery failure would also look like.
function ingameSendTarget() {
  if (ingameWindowId) return ingameWindowId;
  warn('no ingameWindowId yet — falling back to sending by window name (less reliable)');
  return WINDOW_NAMES.INGAME;
}

async function pushState() {
  if (!overlayVisibleWanted && !inGame) return; // nothing to tell, window is gone
  try {
    const result = await sendMessageToWindow(ingameSendTarget(), MESSAGES.STATE, gameState);
    if (!result || result.success !== true) {
      warn('pushState: sendMessage did not report success', result);
    }
  } catch (err) {
    // Can mean "window not open yet" (routine, e.g. GEP fired before the window
    // finished restoring) OR a genuine dropped delivery — sendMessage gives no way
    // to tell those apart from here. Logged loudly on purpose: a silently dropped
    // state push is the exact failure the READY handshake exists to route around,
    // and if THAT drops too, this is the only trace of it.
    warn('pushState: delivery failed —', err.message);
  }
}

async function pushInteractiveChange() {
  try {
    const result = await sendMessageToWindow(ingameSendTarget(), MESSAGES.INTERACTIVE, isInteractive);
    if (!result || result.success !== true) {
      warn('pushInteractiveChange: sendMessage did not report success', result);
    }
  } catch (err) {
    warn('pushInteractiveChange: delivery failed —', err.message);
  }
}

// ---------------------------------------------------------------------------
// Readiness handshake — the fix for a real, silent drop
// ---------------------------------------------------------------------------
//
// `sendMessage` is fire-and-forget: it has no queue and no delivery guarantee.
// Opening the in-game window and immediately pushing state therefore races the
// window's own script load, and the loser is the message — it is dropped with
// no error on either side. `pushState`'s catch above already anticipated the
// window "not being reachable yet", but logging a drop does not undo it.
//
// The consequence is not a brief flicker. The in-game window has no way to pull
// state on its own initiative (by design — it only ever receives pushes), so a
// dropped first push leaves it blank until the NEXT GEP change happens to fire.
// Champion level changes only on level-up, which during a quiet stretch of a
// game is minutes of an empty overlay — and it would be worst exactly at
// load-in, which is when the player most wants to see the plan.
//
// So the window announces itself when its listener is attached, and we answer
// with the current snapshot. Cheap, and it turns a race into a handshake.
if (typeof overwolf !== 'undefined' && overwolf.windows && overwolf.windows.onMessageReceived) {
  overwolf.windows.onMessageReceived.addListener((message) => {
    if (!message || message.id !== MESSAGES.READY) return;
    log('in-game window announced ready — replaying current state');
    pushState();
    pushInteractiveChange();
  });
}

// ---------------------------------------------------------------------------
// Hotkeys — MUST be registered here (background), not in the in-game window;
// a listener inside a hidden in-game window never fires. This is the one thing
// that must not regress: with a single-monitor user, toggle_overlay is how the
// overlay comes back after being hidden, and a hidden window firing no events is
// exactly the failure mode that would brick it silently.
// ---------------------------------------------------------------------------

if (typeof overwolf !== 'undefined' && overwolf.settings && overwolf.settings.hotkeys) {
  overwolf.settings.hotkeys.onPressed.addListener(async (event) => {
    if (!event || !event.name) return;

    if (event.name === HOTKEYS.TOGGLE_OVERLAY) {
      overlayVisibleWanted = !overlayVisibleWanted;
      log('toggle_overlay ->', overlayVisibleWanted ? 'show' : 'hide');
      if (!inGame) return; // in_game_only window; nothing to toggle outside a match
      try {
        if (overlayVisibleWanted) {
          await restoreWindow(WINDOW_NAMES.INGAME);
          pushState(); // resend last known state so the overlay isn't blank on reappear
        } else {
          await hideWindow(WINDOW_NAMES.INGAME);
        }
      } catch (err) {
        warn('toggle_overlay failed', err);
      }
      return;
    }

    if (event.name === HOTKEYS.TOGGLE_INTERACTIVE) {
      isInteractive = !isInteractive;
      log('toggle_interactive ->', isInteractive ? 'interactive (clickable)' : 'clickthrough');
      try {
        if (ingameWindowId) {
          await setClickThrough(ingameWindowId, !isInteractive);
        }
      } catch (err) {
        warn('setClickThrough on toggle failed', err);
      }
      pushInteractiveChange();
    }
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function init() {
  log('background controller starting');

  if (typeof overwolf === 'undefined') {
    warn('overwolf global not present — not running inside the Overwolf client');
    return;
  }

  // Desktop window is reachable before/between games (champ select, client idle) —
  // per the single-monitor constraint it must never be required mid-game. It's
  // always DECLARED here so it's ready to show; whether it's actually RESTORED
  // depends on launch origin — see decideDesktopAutoOpen() above.
  declareDesktopWindow();

  if (typeof overwolf.extensions !== 'undefined' && overwolf.extensions.onAppLaunchTriggered) {
    overwolf.extensions.onAppLaunchTriggered.addListener((info) => {
      decideDesktopAutoOpen(info && info.origin);
    });
  }
  // Fallback: if the launch-origin event is unavailable or never fires (unverified
  // API — see HANDOFF-engy.md), still make a decision rather than leaving the
  // window undecided forever. Default is "don't open" (see decideDesktopAutoOpen).
  setTimeout(() => decideDesktopAutoOpen(null), 2000);

  overwolf.games.onGameInfoUpdated.addListener(() => {
    evaluateRunningGame();
  });

  evaluateRunningGame(); // in case the app started with League already running
}

init();
