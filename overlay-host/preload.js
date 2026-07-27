// Preload script -- runs in a privileged context with access to Node/Electron
// APIs, but the renderer (ingame.html/ingame.js) has `contextIsolation: true`
// and `nodeIntegration: false`, so it can NEVER reach `ipcRenderer` or any other
// Node API directly. `contextBridge.exposeInMainWorld` is the only door, and it
// exposes exactly two callback-registration functions and two sends -- nothing
// that could be used to reach the filesystem, spawn a process, or navigate.
//
// This is the direct replacement for Overwolf's `overwolf.windows.sendMessage` /
// `onMessageReceived` from the renderer's point of view. `renderer/ingame.js`'s
// Transport section (ported 2026-07-27) and its lane-bar `selectLane` (added
// 2026-07-27, lane-ownership fix) call exactly these functions.

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  STATE: 'coachbuild-state',
  INTERACTIVE: 'coachbuild-interactive',
  READY: 'coachbuild-ready',
  SET_LANE: 'coachbuild-set-lane',
  CALIBRATION: 'coachbuild-calibration',
  ADJUST_MODE: 'coachbuild-adjust-mode',
  ADJUST_SAVE: 'coachbuild-adjust-save',
  ADJUST_CANCEL: 'coachbuild-adjust-cancel',
};

contextBridge.exposeInMainWorld('coachbuildIPC', {
  onState(callback) {
    ipcRenderer.on(CHANNELS.STATE, (_event, state) => callback(state));
  },
  onInteractiveChange(callback) {
    ipcRenderer.on(CHANNELS.INTERACTIVE, (_event, isInteractive) => callback(isInteractive));
  },
  // Ability-box geometry for the highlight, plus the `showTable` flag nested
  // alongside it. Without this bridge the renderer's own guard fires and it
  // logs that it "has no geometry to draw with and will stay hidden" -- which
  // is precisely what the whole pink-box feature did before this was added:
  // main computed the payload, nothing carried it, the renderer waited
  // forever, and every piece looked correct read on its own.
  onCalibration(callback) {
    ipcRenderer.on(CHANNELS.CALIBRATION, (_event, geometry) => callback(geometry));
  },
  // Adjust-in-place mode (2026-07-27 round 8) -- fires true/false when the
  // user toggles it via Ctrl+F12 or the tray ("Adjust overlay position").
  // While true, the renderer OWNS keyboard handling (arrows/shift/+-/[]/
  // Tab/Enter/Esc) via ordinary `keydown` listeners -- main.js only flips the
  // window to interactive+focused, it does not intercept or forward keys.
  // See HANDOFF-engy.md for the full contract engo needs to implement this
  // against (I do not own/edit renderer/ingame.js).
  onAdjustModeChange(callback) {
    ipcRenderer.on(CHANNELS.ADJUST_MODE, (_event, isAdjusting) => callback(isAdjusting));
  },
  ready() {
    ipcRenderer.send(CHANNELS.READY);
  },
  // `lane` is a string (TOP/JUNGLE/MID/BOT/SUPPORT) to set a manual override,
  // or null to clear it (hand lane resolution back to auto-detection). Main
  // process validates/normalizes again on receipt (lib/laneSettings.js) --
  // this bridge does not trust the renderer's value as-is.
  setLane(lane) {
    ipcRenderer.send(CHANNELS.SET_LANE, lane);
  },
  // `geometry`: {firstBoxCenterX, centerY, boxSize, spacing} -- the
  // renderer's locally-nudged working copy, sent on Enter. Main re-validates
  // before persisting (never trusts this payload as-is) and replies by
  // exiting adjust mode (`onAdjustModeChange(false)`) and re-pushing the
  // saved geometry (`onCalibration`).
  saveAdjustedGeometry(geometry) {
    ipcRenderer.send(CHANNELS.ADJUST_SAVE, geometry);
  },
  // Sent on Esc. Main discards the renderer's local edits, exits adjust mode,
  // and re-pushes the LAST SAVED geometry via `onCalibration` so the box
  // snaps back to it rather than staying at the discarded position.
  cancelAdjustedGeometry() {
    ipcRenderer.send(CHANNELS.ADJUST_CANCEL);
  },
});
