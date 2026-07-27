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
];
const elementsById = new Map();
for (const id of KNOWN_IDS) {
  const el = makeElement(id === "cb-grid" ? "table" : "div");
  el.id = id;
  elementsById.set(id, el);
}

globalThis.document = {
  getElementById: (id) => elementsById.get(id) || null,
  createElement: (tag) => makeElement(tag),
};

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
    ready() {
      registered.readyCalled = true;
    },
    setLane() {},
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main();
