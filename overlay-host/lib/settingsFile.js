// Shared, merge-safe JSON settings file for overlay-host's main process.
// ONE file (`coachbuild-overlay-settings.json` under app.getPath('userData')),
// multiple independent owners (lane, calibration, UI toggles) -- extracted
// 2026-07-27 when calibration settings joined lane settings in the same file,
// specifically to avoid the read-modify-write race that would exist if each
// owner read+wrote the WHOLE file independently (owner B's write could clobber
// owner A's key if both raced on the same tick). Every write here goes through
// `writeSettingsPatch`, which always re-reads the current file, merges the
// patch's top-level keys on top, and writes the merged result back -- so two
// unrelated settings can never stomp on each other.

const fs = require('fs');
const path = require('path');

const SETTINGS_FILENAME = 'coachbuild-overlay-settings.json';

function settingsPath(userDataDir) {
  return path.join(userDataDir, SETTINGS_FILENAME);
}

/**
 * Reads the whole settings object. Missing/corrupt file both degrade to `{}`,
 * never throw -- a first run (no file yet) is the ORDINARY case.
 */
function readSettingsFile(userDataDir) {
  try {
    const raw = fs.readFileSync(settingsPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Shallow-merges `patch`'s top-level keys onto whatever is currently on disk
 * and writes the result back. Never throws on a write failure (e.g. a
 * locked-down userData dir) -- logs and returns the merged value that is at
 * least in effect for the rest of this session.
 */
function writeSettingsPatch(userDataDir, patch) {
  const current = readSettingsFile(userDataDir);
  const next = Object.assign({}, current, patch);
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[CoachBuild:main] failed to persist settings (kept in-memory only):', err.message);
  }
  return next;
}

module.exports = { readSettingsFile, writeSettingsPatch, settingsPath };
