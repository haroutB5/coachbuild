// Desktop window — status, the mandatory Riot disclaimer (in desktop.html), and the
// lane selector engo's data layer reads. Deliberately simple: this window is reachable
// before/between games and is NEVER required mid-game (single-monitor constraint — the
// in-game overlay is the only surface that matters once a match starts).
//
// This window talks to overwolf.games.* directly rather than going through
// background.js/sendMessage — any window in the app can call overwolf.* APIs the
// manifest grants permission for, and a plain status readout doesn't need the
// controller's game-session bookkeeping (feature retries, playerlist polling, etc).
// If that duplication ever grows past "which game id is League", promote it to a
// shared js/ module instead of copying more logic here.

const LANE_STORAGE_KEY = 'coachbuild.overwolf.lane';
const VALID_LANES = ['TOP', 'JUNGLE', 'MID', 'BOT', 'SUPPORT'];
const DEFAULT_LANE = 'MID';

// Mirrors background.js's LOL_GAME_ID / LOL_LAUNCHER_ID — see that file for the
// "why both ids" note. Kept as a literal here rather than imported to avoid this
// status-only window depending on the background controller's module graph.
const LOL_GAME_ID = 5426;
const LOL_LAUNCHER_ID = 10902;

function isLeagueId(id) {
  return id === LOL_GAME_ID || id === LOL_LAUNCHER_ID;
}

// --- lane selector -----------------------------------------------------------

function initLaneSelector() {
  const select = document.getElementById('lane-select');
  if (!select) return;

  let stored = null;
  try {
    stored = localStorage.getItem(LANE_STORAGE_KEY);
  } catch {
    // localStorage can throw in some sandboxed contexts — degrade quietly.
  }
  select.value = VALID_LANES.includes(stored) ? stored : DEFAULT_LANE;
  if (!VALID_LANES.includes(stored)) {
    persistLane(select.value);
  }

  select.addEventListener('change', () => {
    persistLane(select.value);
  });
}

function persistLane(lane) {
  if (!VALID_LANES.includes(lane)) return;
  try {
    localStorage.setItem(LANE_STORAGE_KEY, lane);
  } catch {
    // Non-fatal — the selector still reflects the user's choice for this session.
  }
}

// --- status readout ------------------------------------------------------------

function setStatus(inGame) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (!dot || !text) return;

  if (inGame) {
    dot.classList.add('status-dot--in-game');
    text.textContent = 'In game — overlay is active';
  } else {
    dot.classList.remove('status-dot--in-game');
    text.textContent = 'Waiting for a League of Legends game';
  }
}

async function refreshStatus() {
  if (typeof overwolf === 'undefined' || !overwolf.games) {
    setStatus(false);
    return;
  }
  overwolf.games.getRunningGameInfo((info) => {
    const running = !!(info && info.isRunning && isLeagueId(info.id));
    setStatus(running);
  });
}

function init() {
  initLaneSelector();
  refreshStatus();

  if (typeof overwolf !== 'undefined' && overwolf.games && overwolf.games.onGameInfoUpdated) {
    overwolf.games.onGameInfoUpdated.addListener(refreshStatus);
  }
}

init();
