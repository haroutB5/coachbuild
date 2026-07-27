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
//
// REFACTORED (2026-07-27, calibration round) to route through
// lib/settingsFile.js's shared read/merge-write helpers rather than owning
// its own file I/O -- calibration settings now live in the SAME file, and a
// second independent owner reading+writing the whole file directly would
// have reintroduced a clobber race. Public API (`loadLane`/`saveLane`/
// `VALID_LANES`) and the on-disk `{"lane": "..."}` shape are UNCHANGED --
// existing settings files from before this refactor still load correctly.

const { readSettingsFile, writeSettingsPatch } = require('./settingsFile.js');

const VALID_LANES = new Set(['TOP', 'JUNGLE', 'MID', 'BOT', 'SUPPORT']);

/**
 * @returns {string|null} a valid lane, or null meaning "unset / Auto" -- a
 *   missing/corrupt/unreadable file degrades to null, never throws. A missing
 *   file on first run is the ORDINARY case (nothing has ever been saved yet),
 *   not an error worth logging loudly.
 */
function loadLane(userDataDir) {
  const settings = readSettingsFile(userDataDir);
  return typeof settings.lane === 'string' && VALID_LANES.has(settings.lane) ? settings.lane : null;
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
  writeSettingsPatch(userDataDir, { lane: value });
  return value;
}

module.exports = { loadLane, saveLane, VALID_LANES };
