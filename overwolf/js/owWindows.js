// Thin promise wrappers over Overwolf's callback-based overwolf.windows /
// overwolf.games APIs. Kept separate from background.js so the controller reads as
// orchestration (what to do, when) rather than callback plumbing (how to ask Overwolf).
// No game-specific logic lives here -- this file would be identical for any game.

function callbackToPromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`${fn.name || 'overwolf call'} failed: ${(result && result.error) || 'unknown error'}`));
    });
  });
}

export function obtainDeclaredWindow(windowName) {
  return new Promise((resolve, reject) => {
    overwolf.windows.obtainDeclaredWindow(windowName, (result) => {
      if (result && result.success) resolve(result.window);
      else reject(new Error(`obtainDeclaredWindow(${windowName}) failed: ${result && result.error}`));
    });
  });
}

export function restoreWindow(windowName) {
  return new Promise((resolve, reject) => {
    overwolf.windows.restore(windowName, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`restore(${windowName}) failed: ${result && result.error}`));
    });
  });
}

export function hideWindow(windowName) {
  return new Promise((resolve, reject) => {
    overwolf.windows.hide(windowName, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`hide(${windowName}) failed: ${result && result.error}`));
    });
  });
}

export function closeWindow(windowName) {
  return new Promise((resolve, reject) => {
    overwolf.windows.close(windowName, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`close(${windowName}) failed: ${result && result.error}`));
    });
  });
}

export function getWindowState(windowName) {
  return new Promise((resolve, reject) => {
    overwolf.windows.getWindowState(windowName, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`getWindowState(${windowName}) failed: ${result && result.error}`));
    });
  });
}

// Runtime clickthrough toggle. `overwolf.windows.changeWindowProperty` does NOT exist
// (confirmed dead end) -- setWindowStyle / removeWindowStyle with
// WindowStyle.InputPassThrough is the real runtime API. The manifest's
// `clickthrough: true` only sets the window's INITIAL style; everything after that
// (our toggle_interactive hotkey) goes through this.
export function setClickThrough(windowId, enabled) {
  return new Promise((resolve, reject) => {
    const style = overwolf.windows.enums.WindowStyle.InputPassThrough;
    const apply = enabled ? overwolf.windows.setWindowStyle : overwolf.windows.removeWindowStyle;
    apply(windowId, style, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`setClickThrough(${enabled}) failed: ${result && result.error}`));
    });
  });
}

// Cross-window messaging. There is no supported API to reach into another window's
// JS global scope directly from a background page -- overwolf.windows.sendMessage /
// overwolf.windows.onMessageReceived is the real, documented transport. See
// HANDOFF-engy.md for why background.js uses this instead of a literal
// `window.CoachBuildOverlay.onState(...)` call from outside the target window.
//
// `destination` should be a windowId (the documented parameter) when the caller has
// one -- background.js prefers `ingameWindowId` for exactly this reason. A declared
// window NAME is accepted as a fallback (e.g. before a window has been obtained at
// least once and its id captured) but is the less-reliable path.
export function sendMessageToWindow(destination, messageId, content) {
  return new Promise((resolve, reject) => {
    overwolf.windows.sendMessage(destination, messageId, content, (result) => {
      if (result && result.success) resolve(result);
      else reject(new Error(`sendMessage(${destination}, ${messageId}) failed: ${result && result.error}`));
    });
  });
}

export function getRunningGameInfo() {
  return new Promise((resolve) => {
    overwolf.games.getRunningGameInfo((gameInfo) => resolve(gameInfo || null));
  });
}
