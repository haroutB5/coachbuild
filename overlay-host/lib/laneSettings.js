// Lane persistence — MAIN PROCESS owns this now (2026-07-27 fix, see
// HANDOFF-engy.md round 4). The renderer used to write
// localStorage["coachbuild.overwolf.lane"] directly; that broke two ways at
// once: (1) nothing else ever wrote that key once the Overwolf desktop window
// was dropped in the Electron pivot, so it was permanently unset, and (2) even
// a successful write from the renderer is unreliable across restarts on a
// `file://` origin, where Chromium partitions/evicts localStorage differently
// than a real https origin. Moving ownership to a plain JSON file under
// `app.getPath('userData')` sidesteps both problems entirely rather than
// fighting `file://`.

const fs = require('fs');
const path = require('path');

const VALID_LANES = new Set(['TOP', 'JUNGLE', 'MID', 'BOT', 'SUPPORT']);
const SETTINGS_FILENAME = 'coachbuild-overlay-settings.json';

function settingsPath(userDataDir) {
  return path.join(userDataDir, SETTINGS_FILENAME);
}

/**
 * @returns {string|null} a valid lane, or null meaning "unset / Auto" -- a
 *   missing/corrupt/unreadable file degrades to null, never throws. A missing
 *   file on first run is the ORDINARY case (nothing has ever been saved yet),
 *   not an error worth logging loudly.
 */
function loadLane(userDataDir) {
  try {
    const raw = fs.readFileSync(settingsPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.lane === 'string' && VALID_LANES.has(parsed.lane) ? parsed.lane : null;
  } catch {
    return null;
  }
}

/**
 * Persists `lane` (or clears it if not a recognized lane -- this is how
 * "Auto" is represented: null, not a sixth magic string). Never throws on a
 * write failure (e.g. a locked-down userData dir) -- logs and returns the
 * value that was AT LEAST accepted in memory, so the app keeps working for
 * the rest of the session even if disk persistence is unavailable.
 *
 * @returns {string|null} the normalized value actually in effect.
 */
function saveLane(userDataDir, lane) {
  const value = typeof lane === 'string' && VALID_LANES.has(lane) ? lane : null;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(settingsPath(userDataDir), JSON.stringify({ lane: value }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[CoachBuild:main] failed to persist lane setting (kept in-memory only):', err.message);
  }
  return value;
}

module.exports = { loadLane, saveLane, VALID_LANES };
