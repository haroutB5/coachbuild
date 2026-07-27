// ─────────────────────────────────────────────────────────────────────────────
// _selfTest-highlight.mjs — standalone verification for the NEW ability
// highlight box (2026-07-27): the resolveNextSkill wiring, the calibration
// contract, and the highlight-box positioning math in
// overlay-host/renderer/ingame.js.
//
// WHY A HAND-ROLLED DOM SHIM INSTEAD OF A REAL BROWSER: ingame.js is a real
// browser module (`document.getElementById` at top-level, `window.*`), and
// this repo's Electron app has no test runner or jsdom wired up (adding one
// would be a new npm dependency -- disallowed this round). The engine call
// (`resolveNextSkill`) and the coordinate arithmetic are the two places a
// silent bug would be worst here -- a wrong engine call could render an
// imperative claim the engine never actually made, and wrong arithmetic
// would draw the box over the WRONG ability's icon, which is worse than not
// drawing it at all. Both are exercised here against the REAL ingame.js
// module (imported, not reimplemented) with a minimal DOM shim underneath
// it, not a hand-simulated re-description of its logic.
//
// Run with: node overlay-host/vendor/_selfTest-highlight.mjs
// Exits non-zero on any failed assertion.
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${label}: expected ${e}, got ${a}`);
  }
}

function assertTrue(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(`${label}: expected truthy`);
  }
}

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
function makeElement(tag) {
  const el = {
    tagName: tag,
    id: "",
    hidden: false,
    textContent: "",
    children: [],
    style: {},
    _listeners: {},
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      toggle(c, force) {
        const has = this._set.has(c);
        const want = force === undefined ? !has : force;
        if (want) this._set.add(c);
        else this._set.delete(c);
        return want;
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, val) {
      this[`_attr_${name}`] = val;
    },
    addEventListener(type, fn) {
      this._listeners[type] = fn;
    },
    click() {
      if (this._listeners.click) this._listeners.click();
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return this._innerHTML || "";
    },
    set(v) {
      this._innerHTML = v;
      this.children = [];
    },
  });
  return el;
}

const KNOWN_IDS = [
  "cb-overlay",
  "cb-champion",
  "cb-interactive-badge",
  "cb-lanebar",
  "cb-message",
  "cb-grid",
  "cb-footer",
  "cb-highlight",
  "cb-adjust",
  "cb-adjust-legend",
  "cb-adjust-box-Q",
  "cb-adjust-box-W",
  "cb-adjust-box-E",
  "cb-adjust-box-R",
];
// Elements that carry a literal `hidden` attribute in the real ingame.html
// markup -- this shim never parses the HTML file, so anything ingame.js
// doesn't set `hidden` on itself at load time (unlike #cb-overlay/#cb-grid,
// which render({phase:"not-in-game"}) touches on import) needs its true
// initial state seeded here, or a "starts hidden" assertion would pass
// vacuously against a shim default that just happens to also be `false`.
const INITIALLY_HIDDEN_IDS = new Set(["cb-highlight", "cb-adjust", "cb-overlay", "cb-interactive-badge", "cb-grid"]);

const elementsById = new Map();
for (const id of KNOWN_IDS) {
  const el = makeElement(id === "cb-grid" ? "table" : "div");
  el.id = id;
  el.hidden = INITIALLY_HIDDEN_IDS.has(id);
  elementsById.set(id, el);
}

// document.addEventListener/removeEventListener + a dispatch helper -- round
// 8 needs this to drive setAdjustMode's real `keydown` listener the same way
// a real browser would (attach/detach through the actual DOM API, not a
// hand-simulated call into handleAdjustKeydown directly).
const documentListeners = {};
globalThis.document = {
  getElementById: (id) => elementsById.get(id) || null,
  createElement: (tag) => makeElement(tag),
  addEventListener(type, fn) {
    documentListeners[type] = documentListeners[type] || [];
    if (!documentListeners[type].includes(fn)) documentListeners[type].push(fn);
  },
  removeEventListener(type, fn) {
    if (!documentListeners[type]) return;
    documentListeners[type] = documentListeners[type].filter((f) => f !== fn);
  },
};

function dispatchKeydown(key, opts = {}) {
  const listeners = documentListeners.keydown || [];
  const event = {
    key,
    shiftKey: !!opts.shiftKey,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  for (const fn of listeners.slice()) fn(event);
  return event;
}

// Capture whatever ingame.js registers so this test can drive pushes exactly
// the way main.js will (real callback references, not reimplemented dispatch).
const registered = {};
globalThis.window = {
  coachbuildIPC: {
    onState(cb) {
      registered.onState = cb;
    },
    onInteractiveChange(cb) {
      registered.onInteractiveChange = cb;
    },
    onCalibration(cb) {
      registered.onCalibration = cb;
    },
    onAdjustModeChange(cb) {
      registered.onAdjustModeChange = cb;
    },
    ready() {
      registered.readyCalled = true;
    },
    setLane() {},
    saveAdjustedGeometry(geometry) {
      registered.savedGeometry = geometry;
      registered.saveCallCount = (registered.saveCallCount || 0) + 1;
    },
    cancelAdjustedGeometry() {
      registered.cancelCallCount = (registered.cancelCallCount || 0) + 1;
    },
  },
};

// ── fetch mock -- a real, complete Ahri/Mid SkillOrderModel (the exact order
// this session pulled live from prod earlier: order[8] === "Q" at Q's cap,
// which is what produces the deliberate "capped-ability" refusal test below
// -- not a contrived number). ────────────────────────────────────────────────
const CHAMPION_LIST = [{ id: 103, key: "Ahri", name: "Ahri" }];
const AHRI_MID_MODEL = {
  priority: ["Q", "W", "E"],
  levels: { Q: [1, 4, 5, 7, 9], W: [2, 8, 10, 12, 13], E: [3, 14, 15, 17, 18], R: [6, 11, 16] },
  order: ["Q", "W", "E", "Q", "Q", "R", "Q", "W", "Q", "W", "R", "W", "W", "E", "E", "R", "E", "E"],
  completed: true,
  sampleSize: 12779,
  winRate: 0.59,
  share: 0.48,
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/champions")) return jsonResponse(CHAMPION_LIST);
  if (u.includes("/api/skill-order")) return jsonResponse(AHRI_MID_MODEL);
  throw new Error(`unexpected fetch: ${u}`);
};

async function main() {
  await import("../renderer/ingame.js");

  const highlight = elementsById.get("cb-highlight");
  const overlay = elementsById.get("cb-overlay");

  assertTrue(typeof registered.onState === "function", "ingame.js registered window.coachbuildIPC.onState");
  assertTrue(typeof registered.onCalibration === "function", "ingame.js registered window.coachbuildIPC.onCalibration");
  assertTrue(registered.readyCalled === true, "ingame.js called window.coachbuildIPC.ready()");
  assertTrue(highlight.hidden === true, "highlight box starts hidden (no calibration, no state yet)");
  assertTrue(overlay.hidden === true, "table starts hidden (showTable defaults false, not interactive)");

  // ── Push a resolved state BEFORE any calibration exists ───────────────────
  // Level 1, no points spent -> a clean "recommend Q" from resolveNextSkill.
  // Must stay hidden anyway: no calibration means nowhere honest to draw it.
  registered.onState({
    inGame: true,
    championName: "Ahri",
    championLevel: 1,
    abilityRanks: { Q: 0, W: 0, E: 0, R: 0 },
  });
  // `registered.onState` (the transport wrapper) does not return/await
  // handleState's internal promise chain -- same as the real
  // window.coachbuildIPC.onState contract -- so this test flushes pending
  // microtasks with a trailing macrotask tick rather than `await`ing a
  // value that resolves immediately regardless of whether the real work
  // finished. Used after every push below for the same reason.
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(highlight.hidden === true, "highlight stays hidden with a valid recommendation but NO calibration yet");

  // ── Push calibration, then re-push the same state ─────────────────────────
  registered.onCalibration({ firstBoxCenterX: 800, centerY: 950, boxSize: 60, spacing: 70, showTable: false });
  // applyCalibration re-renders from lastState itself (see ingame.js) -- no
  // second onState push needed; give the microtask queue a tick since
  // applyCalibration's re-render goes through the same async handleState path.
  await new Promise((r) => setTimeout(r, 0));

  assertTrue(highlight.hidden === false, "highlight becomes visible once calibration exists AND there is a recommendation");
  // Q is slot 0: centerX = 800 + 0*70 = 800, box 60 -> left = 800-30=770, top = 950-30=920.
  assertEq(highlight.style.left, "770px", "highlight left position: Q is slot 0, firstBoxCenterX itself");
  assertEq(highlight.style.top, "920px", "highlight top position: centerY - boxSize/2");
  assertEq(highlight.style.width, "60px", "highlight width == calibration.boxSize");
  assertEq(highlight.style.height, "60px", "highlight height == calibration.boxSize");
  assertTrue(overlay.hidden === true, "table stays hidden -- calibration's showTable was false");

  // ── showTable:true must make the table visible even outside interactive mode ─
  registered.onCalibration({ firstBoxCenterX: 800, centerY: 950, boxSize: 60, spacing: 70, showTable: true });
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(overlay.hidden === false, "table becomes visible when calibration.showTable is true (not interactive)");
  registered.onCalibration({ firstBoxCenterX: 800, centerY: 950, boxSize: 60, spacing: 70, showTable: false });
  await new Promise((r) => setTimeout(r, 0));

  // ── W's slot (index 1) -- verify the spacing arithmetic generalizes, not
  //    just correct for index 0 which could hide an off-by-one ─────────────
  // Level 2, Q already ranked once, unspent 1 -> order[1] (points spent
  // index 1) is "W". A genuine second real point of this exact order, not a
  // contrived one.
  await registered.onState({
    inGame: true,
    championName: "Ahri",
    championLevel: 2,
    abilityRanks: { Q: 1, W: 0, E: 0, R: 0 },
  });
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(highlight.hidden === false, "highlight visible for the W recommendation");
  // W is slot 1: centerX = 800 + 1*70 = 870 -> left = 870-30 = 840.
  assertEq(highlight.style.left, "840px", "highlight left position generalizes correctly to slot index 1 (W)");

  // ── A genuine REFUSAL from the real order (capped-ability, not contrived):
  //    level 9, ranks {Q:5,W:2,E:1,R:0} -> spent=8 -> order[8] === "Q", but
  //    Q is already at its 5-rank cap. resolveNextSkill must return
  //    kind:"none", and the box must disappear, not keep showing stale. ────
  await registered.onState({
    inGame: true,
    championName: "Ahri",
    championLevel: 9,
    abilityRanks: { Q: 5, W: 2, E: 1, R: 0 },
  });
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(highlight.hidden === true, "highlight correctly HIDDEN on a real capped-ability refusal (never guesses a fallback)");

  // ── A bad-ranks refusal (missing abilityRanks entirely) -- must not throw,
  //    must not show a stale box from the previous successful render. ───────
  await registered.onState({ inGame: true, championName: "Ahri", championLevel: 5, abilityRanks: null });
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(highlight.hidden === true, "highlight hidden when abilityRanks is null (resolveNextSkill's own bad-ranks refusal)");

  // ── Malformed calibration payload must be rejected, not silently corrupt
  //    the previously-good calibration. ────────────────────────────────────
  registered.onCalibration({ firstBoxCenterX: 800, centerY: 950 }); // missing boxSize/spacing
  await new Promise((r) => setTimeout(r, 0));
  // Re-push the clean Q-recommend state to prove the OLD (still valid, 60px)
  // calibration survived the malformed push rather than being overwritten
  // with something that would draw a NaN-sized box.
  await registered.onState({
    inGame: true,
    championName: "Ahri",
    championLevel: 1,
    abilityRanks: { Q: 0, W: 0, E: 0, R: 0 },
  });
  await new Promise((r) => setTimeout(r, 0));
  assertEq(highlight.style.width, "60px", "malformed calibration payload ignored -- previous valid calibration survives untouched");

  // ── Adjust-in-place mode (round 8, 2026-07-27) ─────────────────────────────
  const adjust = elementsById.get("cb-adjust");
  const boxQ = elementsById.get("cb-adjust-box-Q");
  const boxW = elementsById.get("cb-adjust-box-W");
  const legend = elementsById.get("cb-adjust-legend");

  assertTrue(typeof registered.onAdjustModeChange === "function", "ingame.js registered window.coachbuildIPC.onAdjustModeChange");
  assertTrue(adjust.hidden === true, "adjust UI starts hidden");

  // Current committed calibration at this point is still {800,950,60,70}
  // (the malformed push above was rejected, see the assertion just above).
  registered.onAdjustModeChange(true);
  await new Promise((r) => setTimeout(r, 0));

  assertTrue(adjust.hidden === false, "adjust UI becomes visible on onAdjustModeChange(true)");
  assertTrue(highlight.hidden === true, "the single recommendation highlight is suppressed while adjusting (4-box preview owns the surface)");
  // Q slot 0: left=800-30=770,top=950-30=920,60x60. W slot 1: left=870-30=840.
  assertEq(boxQ.style.left, "770px", "adjust box Q snapshotted from the current committed calibration, not a guess");
  assertEq(boxW.style.left, "840px", "adjust box W position generalizes correctly");
  assertEq(boxQ.style.width, "60px", "adjust box size snapshotted from calibration");
  // Legend anchor: rowCenterX = 800 + 1.5*70 = 905; top = 950 - 30 = 920.
  assertEq(legend.style.left, "905px", "legend anchored to the box row's horizontal midpoint");
  assertEq(legend.style.top, "920px", "legend anchored just above the row's top edge");

  // ── Keyboard: fine nudge ────────────────────────────────────────────────
  let ev = dispatchKeydown("ArrowRight");
  assertTrue(ev.defaultPrevented, "ArrowRight calls preventDefault (never leaks to the game)");
  assertEq(boxQ.style.left, "771px", "ArrowRight nudges firstBoxCenterX by 1 (fine step)");

  // ── Keyboard: coarse (Shift) nudge ──────────────────────────────────────
  dispatchKeydown("ArrowRight", { shiftKey: true });
  assertEq(boxQ.style.left, "781px", "Shift+ArrowRight nudges by 10 (coarse step) -- matters at 200% OS scale per the brief");

  // ── Keyboard: vertical nudge ─────────────────────────────────────────────
  dispatchKeydown("ArrowDown", { shiftKey: true });
  assertEq(boxQ.style.top, "930px", "Shift+ArrowDown nudges centerY by 10");

  // ── Keyboard: box size, clamped ──────────────────────────────────────────
  dispatchKeydown("+");
  assertEq(boxQ.style.width, "61px", "'+' grows boxSize by 1");
  dispatchKeydown("=");
  assertEq(boxQ.style.width, "62px", "'=' (unshifted +) also grows boxSize by 1");
  dispatchKeydown("-");
  dispatchKeydown("-");
  assertEq(boxQ.style.width, "60px", "'-' shrinks boxSize by 1");

  // ── Keyboard: spacing, affects W but not Q ───────────────────────────────
  // State at this point: firstBoxCenterX=811 (801 after the fine step, +10
  // for the coarse step), centerY=960, boxSize back down to 60, spacing
  // still 70.
  const qLeftBeforeSpacing = boxQ.style.left;
  dispatchKeydown("]");
  assertEq(boxQ.style.left, qLeftBeforeSpacing, "']' (spacing) does not move Q -- Q is slot 0, spacing only affects slots 1-3");
  // spacing 70 -> 71; W center = 811 + 1*71 = 882 -> left = 882 - 30 = 852.
  assertEq(boxW.style.left, "852px", "']' grows spacing, correctly shifts W's slot-1 position");
  dispatchKeydown("[");

  // ── Tab: deliberate no-op, but still preventDefault ──────────────────────
  const qLeftBeforeTab = boxQ.style.left;
  ev = dispatchKeydown("Tab");
  assertTrue(ev.defaultPrevented, "Tab calls preventDefault (never leaks focus out of the window)");
  assertEq(boxQ.style.left, qLeftBeforeTab, "Tab is a genuine no-op on geometry -- whole-row model, nothing to cycle between");

  // ── An unrelated key passes through untouched ────────────────────────────
  ev = dispatchKeydown("a");
  assertTrue(ev.defaultPrevented === false, "an unrelated key is NOT preventDefault'd -- must not swallow normal input");
  assertEq(boxQ.style.left, qLeftBeforeTab, "an unrelated key changes nothing");

  // ── Enter: saves the CURRENT nudged geometry, reactive-only (no local
  //    teardown until onAdjustModeChange(false) actually arrives) ──────────
  // Full trace into this point: {800,950,60,70} -> ArrowRight (+1 fine) ->
  // {801,950,60,70} -> Shift+ArrowRight (+10 coarse) -> {811,950,60,70} ->
  // Shift+ArrowDown (+10 coarse) -> {811,960,60,70} -> +/=/-/- net 0 on
  // boxSize -> still 60 -> ]/[ net 0 on spacing -> still 70.
  dispatchKeydown("Enter");
  assertEq(registered.saveCallCount, 1, "Enter calls window.coachbuildIPC.saveAdjustedGeometry exactly once");
  assertEq(
    registered.savedGeometry,
    { firstBoxCenterX: 811, centerY: 960, boxSize: 60, spacing: 70 },
    "the saved geometry matches every nudge applied above, and carries ONLY the four geometry fields (no showTable)"
  );
  assertTrue(adjust.hidden === false, "adjust UI stays open after Enter until main.js's own onAdjustModeChange(false) arrives (reactive-only, no optimistic local teardown)");

  // Main.js's real response to a save: re-push calibration with the new
  // geometry, then close adjust mode.
  registered.onCalibration({ firstBoxCenterX: 811, centerY: 960, boxSize: 60, spacing: 70, showTable: false });
  registered.onAdjustModeChange(false);
  await new Promise((r) => setTimeout(r, 0));

  assertTrue(adjust.hidden === true, "adjust UI closes once onAdjustModeChange(false) actually arrives");
  const qLeftAfterClose = boxQ.style.left;
  dispatchKeydown("ArrowRight");
  assertEq(boxQ.style.left, qLeftAfterClose, "keydown listener was detached on close -- further key presses do nothing to the (now-hidden) adjust boxes");
  assertTrue(highlight.hidden === false, "the single highlight box is restored after leaving adjust mode");
  // firstBoxCenterX is now 811 (the saved value) -- left = 811-30 = 781.
  assertEq(highlight.style.left, "781px", "restored single highlight reflects the NEWLY SAVED calibration, not the pre-adjustment one");

  // ── Reopening snapshots from the LATEST calibration, not stale state ─────
  registered.onAdjustModeChange(true);
  await new Promise((r) => setTimeout(r, 0));
  assertEq(boxQ.style.left, "781px", "reopening adjust mode snapshots the newly-saved calibration (811), not the original (800)");

  // ── Escape: cancels, same reactive-only teardown discipline ─────────────
  dispatchKeydown("ArrowLeft"); // nudge something so cancel has an edit to discard
  ev = dispatchKeydown("Escape");
  assertTrue(ev.defaultPrevented, "Escape calls preventDefault");
  assertEq(registered.cancelCallCount, 1, "Escape calls window.coachbuildIPC.cancelAdjustedGeometry exactly once");
  assertTrue(adjust.hidden === false, "adjust UI stays open after Escape until onAdjustModeChange(false) actually arrives");

  // Main.js's real response to a cancel: re-push the LAST SAVED geometry
  // (unchanged, since nothing was actually saved this time) and close.
  registered.onCalibration({ firstBoxCenterX: 811, centerY: 960, boxSize: 60, spacing: 70, showTable: false });
  registered.onAdjustModeChange(false);
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(adjust.hidden === true, "adjust UI closes after a cancel too");
  assertEq(highlight.style.left, "781px", "cancel leaves the highlight at the LAST SAVED geometry -- the discarded nudge never took effect");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main();
