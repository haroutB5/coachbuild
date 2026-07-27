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
};

contextBridge.exposeInMainWorld('coachbuildIPC', {
  onState(callback) {
    ipcRenderer.on(CHANNELS.STATE, (_event, state) => callback(state));
  },
  onInteractiveChange(callback) {
    ipcRenderer.on(CHANNELS.INTERACTIVE, (_event, isInteractive) => callback(isInteractive));
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
});
