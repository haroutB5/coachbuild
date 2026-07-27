// Ability-bar calibration geometry — persistence + the scaled-default
// heuristic. New 2026-07-27 (fullscreen highlight-box round).
//
// We cannot COMPUTE where League's ability icons are: it depends on display
// resolution AND League's own HUD scale slider AND HUD layout options, none
// of which this process can read. This module therefore ONLY ever does two
// things: (1) persist geometry the USER calibrated by dragging boxes in
// renderer/calibrate.js, tagged with the resolution it was calibrated at, and
// (2) offer a rough STARTING POINT for that calibration UI to open with, so
// the first drag begins somewhere near the target instead of a screen corner.
// Neither of those is "the real coordinates" -- only a user's own calibration
// is ever presented as reliable.

const { readSettingsFile, writeSettingsPatch } = require('./settingsFile.js');

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

// UNRESEARCHED PLACEHOLDER -- explicitly NOT a measured value. Derived only
// from general knowledge that League's default HUD places the Q/W/E/R
// ability row horizontally, near the bottom of the screen, roughly centred
// but sitting left of true screen-centre (the champion portrait + summoner
// spells + trinket cluster occupies the centre-right). No screenshot or
// reference capture of an actual League HUD backs these numbers -- do not
// upgrade this comment to "verified" without one. This exists ONLY so
// calibrate.js's four boxes don't open stacked in the top-left corner; the
// user's own drag is what makes it accurate, every time, for every HUD scale
// and layout setting.
const REFERENCE_GEOMETRY = Object.freeze({
  firstBoxCenterX: 830,
  centerY: 1010,
  boxSize: 48,
  spacing: 68,
});

/**
 * Scales REFERENCE_GEOMETRY from the 1920x1080 reference to the given
 * display size. Horizontal quantities (position, spacing, box size) scale by
 * width ratio; vertical position scales by height ratio. This assumes a
 * roughly similar aspect ratio to 1920x1080 -- on a very different aspect
 * ratio the starting point will be rougher, but it is still only ever a
 * DRAG-FROM starting point, never presented as calibrated.
 */
function scaledDefaultGeometry(width, height) {
  const scaleX = width / REFERENCE_WIDTH;
  const scaleY = height / REFERENCE_HEIGHT;
  return {
    firstBoxCenterX: Math.round(REFERENCE_GEOMETRY.firstBoxCenterX * scaleX),
    centerY: Math.round(REFERENCE_GEOMETRY.centerY * scaleY),
    boxSize: Math.round(REFERENCE_GEOMETRY.boxSize * scaleX),
    spacing: Math.round(REFERENCE_GEOMETRY.spacing * scaleX),
  };
}

function isValidGeometry(g) {
  return (
    g &&
    typeof g === 'object' &&
    Number.isFinite(g.firstBoxCenterX) &&
    Number.isFinite(g.centerY) &&
    Number.isFinite(g.boxSize) &&
    g.boxSize > 0 &&
    Number.isFinite(g.spacing)
  );
}

/**
 * @returns {{geometry: object, isDefault: boolean, calibratedWidth: number|null, calibratedHeight: number|null}}
 *   `isDefault: true` whenever the persisted geometry is missing, corrupt, OR
 *   was calibrated at a DIFFERENT resolution than `currentWidth`/`currentHeight`
 *   -- a resolution change silently reusing stale coordinates from another
 *   screen size would be worse than an honest scaled guess, per the brief.
 *   Logging the fallback is the CALLER's job (main.js), not this pure module's.
 */
function loadCalibration(userDataDir, currentWidth, currentHeight) {
  const settings = readSettingsFile(userDataDir);
  const cal = settings.calibration;
  if (
    cal &&
    isValidGeometry(cal.geometry) &&
    cal.calibratedWidth === currentWidth &&
    cal.calibratedHeight === currentHeight
  ) {
    return {
      geometry: cal.geometry,
      isDefault: false,
      calibratedWidth: cal.calibratedWidth,
      calibratedHeight: cal.calibratedHeight,
    };
  }
  return {
    geometry: scaledDefaultGeometry(currentWidth, currentHeight),
    isDefault: true,
    calibratedWidth: null,
    calibratedHeight: null,
  };
}

/**
 * Persists geometry tagged with the resolution it was calibrated at. Invalid
 * geometry (should not happen -- calibrate.js validates before sending, but
 * never trust a cross-process payload) silently falls back to the scaled
 * default for the given resolution rather than persisting garbage.
 *
 * @returns {object} the geometry actually persisted/in effect.
 */
function saveCalibration(userDataDir, geometry, width, height) {
  const clean = isValidGeometry(geometry) ? geometry : scaledDefaultGeometry(width, height);
  writeSettingsPatch(userDataDir, {
    calibration: { geometry: clean, calibratedWidth: width, calibratedHeight: height },
  });
  return clean;
}

module.exports = {
  loadCalibration,
  saveCalibration,
  scaledDefaultGeometry,
  isValidGeometry,
  REFERENCE_WIDTH,
  REFERENCE_HEIGHT,
  REFERENCE_GEOMETRY,
};
