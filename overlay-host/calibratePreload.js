// Preload script for the CALIBRATION window (renderer/calibrate.{html,js}).
// Separate from preload.js (the main overlay window's bridge) because it's a
// separate, temporary window with a different, smaller IPC surface -- no
// reason to expose lane/state channels to a UI that only ever positions four
// boxes and reports back a single geometry object.
//
// contextIsolation:true + sandbox:true on the calibration BrowserWindow means
// calibrate.js can NEVER reach ipcRenderer or any Node API directly -- only
// what's explicitly exposed here.

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  READY: 'coachbuild-calibrate-ready',
  INIT: 'coachbuild-calibrate-init',
  SAVE: 'coachbuild-calibrate-save',
  CANCEL: 'coachbuild-calibrate-cancel',
};

contextBridge.exposeInMainWorld('coachbuildCalibrateIPC', {
  // Announces the window is ready to receive its starting geometry -- same
  // readiness-handshake reasoning as the main overlay window's onState:
  // main.js's reply would be dropped if sent before this listener attaches.
  ready() {
    ipcRenderer.send(CHANNELS.READY);
  },
  onInit(callback) {
    ipcRenderer.on(CHANNELS.INIT, (_event, payload) => callback(payload));
  },
  // `geometry`: {firstBoxCenterX, centerY, boxSize, spacing} -- validated
  // again on the main-process side (lib/calibrationSettings.js) before
  // persisting; this bridge does not trust the renderer's value as-is.
  save(geometry) {
    ipcRenderer.send(CHANNELS.SAVE, geometry);
  },
  cancel() {
    ipcRenderer.send(CHANNELS.CANCEL);
  },
});
