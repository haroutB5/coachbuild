// calibrate.js — the calibration UI. Positions four labelled boxes
// (Q/W/E/R, modelled as one rigid group: {firstBoxCenterX, centerY, boxSize,
// spacing} rather than four independent rectangles, since the real ability
// icons are evenly spaced on one horizontal row). Reports the final geometry
// to main.js on Save; changes nothing on disk itself -- ALL persistence is
// main-process-owned (lib/calibrationSettings.js), this file only edits an
// in-memory model and renders it.
//
// This file does NOT compute or know which ability (if any) should be
// highlighted during a real game -- it only ever positions FOUR EQUAL boxes
// so the user can tell this app where the icons are. See main.js's header
// for the compliance note on why that "which ability" question is
// deliberately out of scope here.

const ABILITY_LABELS = ["Q", "W", "E", "R"];

// Mirrors lib/calibrationSettings.js's REFERENCE_WIDTH/HEIGHT/GEOMETRY and
// scaledDefaultGeometry EXACTLY -- duplicated here (not imported) because
// this is a sandboxed, contextIsolated renderer with no Node/require access,
// and the function is small and pure enough that duplicating it is cheaper
// and safer than adding an IPC round-trip just for "Reset to default". If
// the reference values in lib/calibrationSettings.js ever change, this copy
// must change with them.
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;
const REFERENCE_GEOMETRY = Object.freeze({
  firstBoxCenterX: 830,
  centerY: 1010,
  boxSize: 48,
  spacing: 68,
});

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

const MIN_BOX_SIZE = 10;
const MAX_BOX_SIZE = 200;
const MIN_SPACING = 10;
const MAX_SPACING = 300;

let geometry = { firstBoxCenterX: 100, centerY: 100, boxSize: 48, spacing: 68 }; // placeholder until init arrives
let displayWidth = 1920;
let displayHeight = 1080;

const boxEls = {};
for (const label of ABILITY_LABELS) {
  boxEls[label] = document.querySelector(`.cal-box[data-ability="${label}"]`);
}
const els = {
  statusHint: document.getElementById("cal-status-hint"),
  boxSize: document.getElementById("cal-box-size"),
  spacing: document.getElementById("cal-spacing"),
  reset: document.getElementById("cal-reset"),
  cancel: document.getElementById("cal-cancel"),
  save: document.getElementById("cal-save"),
};

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

let loggedFirstRender = false;

function render() {
  ABILITY_LABELS.forEach((label, i) => {
    const cx = geometry.firstBoxCenterX + i * geometry.spacing;
    const cy = geometry.centerY;
    const el = boxEls[label];
    el.style.left = `${cx - geometry.boxSize / 2}px`;
    el.style.top = `${cy - geometry.boxSize / 2}px`;
    el.style.width = `${geometry.boxSize}px`;
    el.style.height = `${geometry.boxSize}px`;
  });
  // Logged ONCE (not per-render) -- diagnostic aid for confirming actual
  // computed layout matches the intended geometry. See HANDOFF-engy.md for
  // an open, unresolved discrepancy this round between DOM-computed position
  // (confirmed correct via getBoundingClientRect/getComputedStyle) and what a
  // screenshot of THIS dev environment showed -- believed to be a
  // display-scaling artifact of the test environment, not this code, but not
  // fully root-caused.
  if (!loggedFirstRender) {
    loggedFirstRender = true;
    const qEl = boxEls.Q;
    console.log(`[calibrate] first render geometry=${JSON.stringify(geometry)} window=${window.innerWidth}x${window.innerHeight} Q.rect=${JSON.stringify(qEl.getBoundingClientRect())}`);
  }
  els.boxSize.value = String(geometry.boxSize);
  els.spacing.value = String(geometry.spacing);
}

function setStatus(text) {
  els.statusHint.textContent = text;
}

// ── Drag: any box moves the whole rigid group ───────────────────────────────
let dragState = null;

function onBoxPointerDown(e) {
  dragState = {
    startClientX: e.clientX,
    startClientY: e.clientY,
    startCenterX: geometry.firstBoxCenterX,
    startCenterY: geometry.centerY,
  };
  e.preventDefault();
}

document.addEventListener("mousemove", (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startClientX;
  const dy = e.clientY - dragState.startClientY;
  geometry = {
    ...geometry,
    firstBoxCenterX: dragState.startCenterX + dx,
    centerY: dragState.startCenterY + dy,
  };
  render();
});

document.addEventListener("mouseup", () => {
  dragState = null;
});

for (const label of ABILITY_LABELS) {
  boxEls[label].addEventListener("mousedown", onBoxPointerDown);
}

// ── Keyboard: arrow nudge (1px, Shift+arrow 10px), Escape cancels ──────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    doCancel();
    return;
  }
  const step = e.shiftKey ? 10 : 1;
  let dx = 0;
  let dy = 0;
  if (e.key === "ArrowLeft") dx = -step;
  else if (e.key === "ArrowRight") dx = step;
  else if (e.key === "ArrowUp") dy = -step;
  else if (e.key === "ArrowDown") dy = step;
  else return;
  e.preventDefault();
  geometry = {
    ...geometry,
    firstBoxCenterX: geometry.firstBoxCenterX + dx,
    centerY: geometry.centerY + dy,
  };
  render();
});

// ── Size / spacing numeric fields ───────────────────────────────────────────
els.boxSize.addEventListener("input", () => {
  const v = clamp(Number(els.boxSize.value) || geometry.boxSize, MIN_BOX_SIZE, MAX_BOX_SIZE);
  geometry = { ...geometry, boxSize: v };
  render();
});

els.spacing.addEventListener("input", () => {
  const v = clamp(Number(els.spacing.value) || geometry.spacing, MIN_SPACING, MAX_SPACING);
  geometry = { ...geometry, spacing: v };
  render();
});

// ── Actions ──────────────────────────────────────────────────────────────────
function doReset() {
  geometry = scaledDefaultGeometry(displayWidth, displayHeight);
  render();
  setStatus("Reset to the scaled starting default. Drag to line up with your real icons.");
}

function doCancel() {
  if (typeof window.coachbuildCalibrateIPC !== "undefined") {
    window.coachbuildCalibrateIPC.cancel();
  }
}

function doSave() {
  if (typeof window.coachbuildCalibrateIPC !== "undefined") {
    window.coachbuildCalibrateIPC.save(geometry);
  }
}

els.reset.addEventListener("click", doReset);
els.cancel.addEventListener("click", doCancel);
els.save.addEventListener("click", doSave);

// ── Init ─────────────────────────────────────────────────────────────────────
if (typeof window.coachbuildCalibrateIPC !== "undefined") {
  window.coachbuildCalibrateIPC.onInit((payload) => {
    if (payload && payload.geometry) geometry = payload.geometry;
    if (payload && Number.isFinite(payload.displayWidth)) displayWidth = payload.displayWidth;
    if (payload && Number.isFinite(payload.displayHeight)) displayHeight = payload.displayHeight;
    render();
    setStatus(
      payload && payload.isDefault
        ? "No calibration saved for this resolution yet — showing a rough starting default. Drag to align."
        : "Loaded your previously saved calibration for this resolution."
    );
  });
  window.coachbuildCalibrateIPC.ready();
} else {
  setStatus("coachbuildCalibrateIPC unavailable — preload script did not run.");
}

render();
