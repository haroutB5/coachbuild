// Seamless background auto-update via electron-updater, feeding off the
// electron-builder "publish" config in package.json (GitHub provider,
// pointed at the PUBLIC haroutB5/coachbuild-overlay-releases repo -- binaries
// only, the source repo stays private; see overlay-host/README.md's
// "Auto-update" section).
//
// THE ONE HARD RULE (from the brief this shipped under): never interrupt a
// game -- WIDENED (2026-07-27 audit, B2) to also cover champ select, not just
// an in-progress match. `getIsBusy()` (a callback into main.js's shared
// `isCompanionBusy()` -- true while `inGame` OR the companion's polled LCU
// gameflow phase is `'ChampSelect'`) is the single source of truth for "is it
// safe to install right now." Was `getInGame()` / bare `inGame` before this
// fix: champ select is exactly when companion.ps1 writes to the LCU
// (Invoke-ApplyRunes's DELETE-then-POST), so quitAndInstall() firing between
// those two calls could destroy the user's own rune page with nothing
// created in its place. A finished download NEVER installs immediately -- it
// only sets `updateReadyToInstall` and waits for `notifyGameEnded()` (main.js
// calls this the instant `inGame` flips back to false) or the initial check
// `update-downloaded` itself performs (a no-op if the app is busy at that
// exact moment).
//
// autoInstallOnAppQuit is left at electron-updater's default (true): if the
// user quits the app manually via the tray while a downloaded update is
// pending, installing on that quit is fine -- they are not mid-game, or the
// app would still be running (the inGame guard only ever blocks the
// SEAMLESS in-app quitAndInstall path below, not a user-initiated quit).
//
// Every event is logged through the SAME file logger main.js already writes
// to (log()/warn() passed in via init()) -- an updater that silently does
// nothing is the exact failure mode this shipped to avoid (see the brief:
// "we have already been burned this session by a `false` return nobody
// surfaced").

const { autoUpdater } = require('electron-updater');

// "Every few hours is plenty" per the brief -- a manual gaming-PC user is not
// shipping updates hourly, and checking more often just adds needless network
// activity for no benefit.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
// Let the app finish its own startup (window, tray, poll loop) before adding
// network activity for the update check -- not required for correctness,
// just keeps startup's own log lines readable instead of interleaved with a
// GitHub HTTP round-trip.
const INITIAL_CHECK_DELAY_MS = 10 * 1000;

let log = (...args) => console.log('[CoachBuild:autoUpdater]', ...args);
let warn = (...args) => console.warn('[CoachBuild:autoUpdater]', ...args);
// B2 (2026-07-27 audit): renamed from getInGame -- the callback now answers
// "is it unsafe to interrupt the companion" (inGame OR champ select), not
// literally "is a game in progress." See main.js's isCompanionBusy().
let getIsBusy = () => false;
let onStatusChange = () => {};

// Surfaced to the tray menu -- see main.js's buildTrayMenuTemplate().
// phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' |
//        'ready' | 'not-available' | 'error'
let status = { phase: 'idle', version: null, percent: null, message: null };

let updateReadyToInstall = false;
let initialInstallCheckTimer = null;
let periodicCheckTimer = null;
let initialized = false;

function setStatus(patch) {
  status = { ...status, ...patch };
  try {
    onStatusChange(status);
  } catch (err) {
    // A tray-refresh callback failing must never take the updater down with it.
    warn('onStatusChange callback threw:', err.message);
  }
}

function getStatus() {
  return status;
}

// One-line summary for the tray's non-clickable status row. Never blank --
// see the brief's "an updater that silently does nothing is the failure mode
// to avoid."
function getStatusLabel(appVersion) {
  switch (status.phase) {
    case 'disabled':
      return 'Update: n/a (dev build, run npm run dist to test)';
    case 'checking':
      return 'Update: checking…';
    case 'available':
      return `Update: v${status.version || '?'} found, downloading…`;
    case 'downloading':
      return `Update: downloading${status.percent != null ? ` ${Math.round(status.percent)}%` : '…'}`;
    case 'ready':
      return `Update: v${status.version || '?'} ready — installs when you finish your game`;
    case 'error':
      return `Update: check failed (${status.message || 'see log file'})`;
    case 'not-available':
    case 'idle':
    default:
      return `Up to date (v${appVersion})`;
  }
}

function maybeInstallIfIdle() {
  if (!updateReadyToInstall) return;
  if (getIsBusy()) {
    log('update downloaded but a game or champ select is in progress -- deferring install until it ends');
    return;
  }
  log('installing deferred update now (not in game) -- quitAndInstall(isSilent=true, isForceRunAfter=true)');
  // isSilent=true: no NSIS wizard UI. isForceRunAfter=true: relaunch
  // automatically after install so the user never has to touch anything.
  updateReadyToInstall = false;
  try {
    autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    // Never let a failed install attempt crash the still-running app --
    // worst case the update stays pending and gets retried next time
    // notifyGameEnded()/maybeInstallIfIdle() runs.
    warn('quitAndInstall() threw:', err.message);
    updateReadyToInstall = true;
    setStatus({ phase: 'error', message: err.message });
  }
}

// Called by main.js the instant `inGame` flips back to false (the game the
// user was in just ended). This is the PRIMARY install trigger -- waiting for
// the next periodic check timer alone could leave an install pending for
// hours after the game that was blocking it is long over.
function notifyGameEnded() {
  maybeInstallIfIdle();
}

function checkForUpdates(reason) {
  if (!initialized) return;
  log(`checking for updates (${reason})`);
  setStatus({ phase: 'checking', message: null });
  autoUpdater.checkForUpdates().catch((err) => {
    // checkForUpdates() already emits an 'error' event for essentially every
    // real-world failure mode (network down, GitHub unreachable, rate
    // limited, malformed/missing latest.yml) -- this catch is a
    // belt-and-braces net for a rejected promise on top of that, so a check
    // failure can NEVER throw out of here, and NEVER crash or block the app.
    warn('checkForUpdates() rejected:', err.message);
    setStatus({ phase: 'error', message: err.message });
  });
}

// init() is a no-op (logged, not silent) when the app isn't packaged --
// electron-updater has no meaningful feed to check against a dev `npm start`
// run (there is no app-update.yml, no installed location, nothing to
// replace), so attempting real checks there would just be noisy failures
// with zero signal. Real verification only happens via a packaged build.
function init({ log: logFn, warn: warnFn, getIsBusy: getIsBusyFn, onStatusChange: onStatusChangeFn, isPackaged, appVersion }) {
  if (logFn) log = logFn;
  if (warnFn) warn = warnFn;
  if (getIsBusyFn) getIsBusy = getIsBusyFn;
  if (onStatusChangeFn) onStatusChange = onStatusChangeFn;

  if (!isPackaged) {
    log('running unpackaged (npm start) -- auto-update is disabled in dev, this is expected');
    setStatus({ phase: 'disabled' });
    return;
  }

  initialized = true;

  autoUpdater.autoDownload = true;
  // autoInstallOnAppQuit stays at electron-updater's own default (true) --
  // see the header comment above for why that's fine alongside the seamless
  // path this file drives itself.
  autoUpdater.logger = {
    info: (...args) => log('[electron-updater]', ...args),
    warn: (...args) => warn('[electron-updater]', ...args),
    error: (...args) => warn('[electron-updater:error]', ...args),
    debug: () => {}, // too noisy for the truncated-per-run log file; events below cover everything that matters
  };

  autoUpdater.on('checking-for-update', () => {
    log('event: checking-for-update');
    setStatus({ phase: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log('event: update-available', info && info.version);
    setStatus({ phase: 'available', version: info && info.version });
  });

  autoUpdater.on('update-not-available', () => {
    log('event: update-not-available (already on latest)');
    setStatus({ phase: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    setStatus({ phase: 'downloading', percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log(`event: update-downloaded v${info && info.version} -- will install once no game is in progress`);
    updateReadyToInstall = true;
    setStatus({ phase: 'ready', version: info && info.version });
    // In case nothing is running right now. maybeInstallIfIdle() re-checks
    // getIsBusy() itself and is a safe no-op if it is.
    maybeInstallIfIdle();
  });

  autoUpdater.on('error', (err) => {
    // MUST NEVER throw/crash the app: no network, GitHub unreachable, rate
    // limited, malformed latest.yml, no releases published yet, etc. are all
    // routine and expected on a gaming PC that isn't always online.
    warn('event: error --', err && err.message);
    setStatus({ phase: 'error', message: err && err.message });
  });

  clearTimeout(initialInstallCheckTimer);
  initialInstallCheckTimer = setTimeout(() => checkForUpdates('startup'), INITIAL_CHECK_DELAY_MS);

  clearInterval(periodicCheckTimer);
  periodicCheckTimer = setInterval(() => checkForUpdates('periodic'), CHECK_INTERVAL_MS);

  log(`initialized -- app version ${appVersion}, checking every ${CHECK_INTERVAL_MS / 3600000}h, first check in ${INITIAL_CHECK_DELAY_MS / 1000}s`);
}

function shutdown() {
  clearTimeout(initialInstallCheckTimer);
  clearInterval(periodicCheckTimer);
}

module.exports = {
  init,
  shutdown,
  checkForUpdates,
  notifyGameEnded,
  getStatus,
  getStatusLabel,
};
