// ─────────────────────────────────────────────────────────────────────────────
// ingame.js — renders the transparent in-game overlay.
//
// Public contract with the Electron main process (overlay-host/main.js,
// PORTED 2026-07-27 from the Overwolf background controller -- window is
// still the ONLY surface on a single-monitor setup):
//   window.CoachBuildOverlay.onState(state)
//     state: { championLevel: number|null, championName: string|null,
//              abilityRanks: {Q,W,E,R}|null, inGame: boolean,
//              lane: string|null (MANUAL override, tray/lane-bar-set),
//              detectedPosition: string|null (RAW Riot position, unmapped) }
//   window.CoachBuildOverlay.onInteractiveChange(isInteractive)
//     isInteractive: boolean -- true while the hotkey/tray has made the
//     window clickable (input reaches this page instead of passing through
//     to the game). Default assumed false (clickthrough) until told
//     otherwise.
//
// ── Compliance shape (Riot developer policy, verbatim in the task brief) ────
// This renders a static levels-1-18 reference table with the player's OWN
// current level highlighted as a description, plus a lane picker (the user
// choosing which static dataset to view). No imperative copy, no "level
// this next," no arrows, nothing about an opponent. See
// overwolf/js/skillOrderData.js's header for the data-layer half of this.
// STILL TRUE for the table specifically -- everything in this section
// describes the TABLE. See "The ability highlight box" section further down
// for the one deliberately different surface added 2026-07-27.
//
// In every case, on BOTH surfaces: zero enemy/other-player information is
// ever read or rendered. `resolveOverlayData`'s inputs are the LOCAL
// player's own state only (see overlay-host/lib/gameState.js's header).
//
// ── Why a 4-row (Q/W/E/R) x 18-column grid, not an 18-row list ─────────────
// This is the classic op.gg/u.gg skill-order visual: one filled cell per
// level marking which ability was ranked. It is more compact than 18 rows
// (4 rows total instead of 18), reads as recognizably the same "static
// aggregate skill path" convention the approved category describes, and
// scales to a single glance rather than needing the eye to scan down a list
// mid-fight -- the single-monitor revision's core requirement.
//
// ── The highlight-index judgement call (required by the task brief) ────────
// skillOrderModel.ts's `order` is indexed by POINTS SPENT (see
// lib/nextSkill.ts's own header: "the order is indexed by points spent, not
// by level, and those diverge when a player banks a point"). This overlay
// highlights by CHAMPION LEVEL instead, deliberately NOT points spent:
//   - `resolveNextSkill`'s points-spent indexing exists to answer "which
//     ability should I put THIS point into" -- an instruction. This overlay
//     must never render that shape at all (no ability is ever singled out
//     as "next"); it only marks "this is the level you are at" on a table
//     that already exists independent of the player's choices.
//   - Champion level is a fact the player can already read off their own
//     HUD, unconditionally and always correctly -- "you are level N" is true
//     regardless of whether they've banked points, deviated from the
//     recommended order, or anything else. Points-spent would NOT have that
//     property: if the player is level 9 with only 7 points spent (banked
//     2), highlighting order[6] (points-spent index) instead of order[8]
//     (level index) would show a column that looks like "you should be
///    here" relative to their actual progress -- closer to advice than
//     description, and wrong on its own terms besides (points-spent tracks
//     what THEY did, not what the aggregate recommends for their level).
//   - The tradeoff, stated plainly: a player who banked a point will see the
//     level-N column highlighted while their own live ability ranks (not
//     rendered here at all) are actually behind where a "spent every point
//     immediately" player would be. That is fine -- the table is not
//     claiming to describe the player's ranks, only "this is level N's
//     column in the static reference order." Nothing here reads their own
//     ranks into the highlight, so there is no claim to be wrong about.
// Index used below (for the TABLE only) is therefore `championLevel - 1`
// into `model.order`, full stop -- never `pointsSpent(ranks)`.
//
// ── The ability highlight box (NEW, 2026-07-27) -- a deliberately DIFFERENT
//    compliance posture, and why that's allowed ────────────────────────────
// The user asked to stop looking at the table and instead have the ONE
// recommended-next ability highlighted directly on the real ability icons.
// That IS an instruction ("put your next point here") -- there is no honest
// way to draw a box around exactly one of four abilities and call it
// descriptive. The reasoning that kept `resolveNextSkill` out of this
// codebase before (an Overwolf-hosted overlay, subject to Riot's developer
// policy on "apps that dictate player decisions") no longer applies: this is
// now a standalone Electron app the user runs on their own machine, outside
// Overwolf's distribution/approval surface entirely -- see
// overlay-host/README.md's PIVOT section. So `resolveNextSkill` is
// deliberately reintroduced HERE, and ONLY for the highlight box -- the
// table's rendering path below still never calls it, still stays
// level-indexed and descriptive, unchanged. Two features, two different
// honest postures, in the same file, on purpose.
//
// The refusal discipline is what makes this safe rather than reckless:
// `resolveNextSkill` returns `{kind:"none", because:<one of 11 refusals>}`
// far more often than a live game "should" produce ambiguity -- non-standard
// kits, a deviated-from ability already capped, an incomplete order past
// level 15, a level/ranks reading that doesn't add up, etc (see
// lib/nextSkill.ts's own header -- read it before touching
// computeNextSkillRecommendation below). On ANY refusal this file renders
// NOTHING -- no box, no fallback guess, no "probably Q." Never editorialize
// past what the engine itself is willing to assert.
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveOverlayData,
  laneLabel,
  CHAMPION_LIST_RETRY_COOLDOWN_MS,
  ERROR_RETRY_COOLDOWN_MS,
  NO_DATA_RETRY_COOLDOWN_MS,
} from "../js/skillOrderData.js";
import { resolveNextSkill } from "../vendor/skillEngine.js";

// Mirrors lib/skillOrderModel.ts's TOTAL_LEVELS -- that file is the SOURCE OF
// TRUTH (18 = League's 5/5/5/3 standard rank model over 18 levels, see its
// header). Inlined rather than imported from the vendor bundle: this file AS
// A WHOLE now imports vendor/skillEngine.js (for `resolveNextSkill`, the
// highlight box's engine -- see above), but the TABLE's own rendering code
// (buildGrid/renderResolved below) still never CALLS resolveNextSkill and
// still indexes by `championLevel - 1`, never `pointsSpent(ranks)` -- the
// table's LOGIC stays exactly as descriptive as before, even though the
// module graph is shared now that both features live in one file. If
// lib/skillOrderModel.ts's TOTAL_LEVELS ever changes, update this constant
// by hand.
const TOTAL_LEVELS = 18;

// Q=0, W=1, E=2, R=3 -- the fixed left-to-right order engy's calibration
// geometry assumes (see applyCalibration below): slot i's screen center is
// `firstBoxCenterX + i*spacing`.
const ABILITY_SLOT_INDEX = { Q: 0, W: 1, E: 2, R: 3 };

const ABILITIES = ["Q", "W", "E", "R"];
const LANES = ["TOP", "JUNGLE", "MID", "BOT", "SUPPORT"];
const LANE_SHORT = { TOP: "TOP", JUNGLE: "JG", MID: "MID", BOT: "BOT", SUPPORT: "SUP" };

/** Shared with the "resolved + skillOrder.status === 'error'" case -- both
 *  are the same underlying claim ("the network/API is the problem, not the
 *  champion or the data"), so they get the same words (audit fix #1). */
const MSG_UNAVAILABLE = "Skill order unavailable.";

const els = {
  overlay: document.getElementById("cb-overlay"),
  champion: document.getElementById("cb-champion"),
  badge: document.getElementById("cb-interactive-badge"),
  lanebar: document.getElementById("cb-lanebar"),
  message: document.getElementById("cb-message"),
  grid: document.getElementById("cb-grid"),
  footer: document.getElementById("cb-footer"),
  highlight: document.getElementById("cb-highlight"),
  adjust: document.getElementById("cb-adjust"),
  adjustLegend: document.getElementById("cb-adjust-legend"),
  adjustBoxes: {
    Q: document.getElementById("cb-adjust-box-Q"),
    W: document.getElementById("cb-adjust-box-W"),
    E: document.getElementById("cb-adjust-box-E"),
    R: document.getElementById("cb-adjust-box-R"),
  },
};

// Kept at module scope, not re-derived from the DOM, so a hide/show cycle
// (engy's other hotkey) never loses track of what should be on screen --
// see the header note on re-rendering from last-known state. Every render
// below is a full rebuild driven from these, never an incremental patch
// against whatever the DOM happened to contain before (the ONE deliberate
// exception is the lane bar's short-circuit below -- see its comment).
let lastState = { inGame: false };
let isInteractive = false;
let renderToken = 0;

// ── Calibration state ────────────────────────────────────────────────────────
// Pushed by main.js over IPC (`window.coachbuildIPC.onCalibration`, wired
// and CONFIRMED LIVE in a real game as of round 8 -- the highlight box
// appears correctly on every level-up). See applyCalibration below for the
// payload shape. `calibration === null` means "never calibrated" -- the
// highlight box has nowhere honest to draw itself and stays hidden, same
// "never guess" posture as the skill engine's own refusals.
let calibration = null; // {firstBoxCenterX, centerY, boxSize, spacing} | null
// The reference table now defaults OFF -- the user asked for the highlight
// "instead of" the table. Calibration's `showTable` flag is the intended
// long-term control; starts false so a fresh launch (before any calibration
// has ever run) doesn't show it either.
let showTable = false;

// ── Adjust-in-place mode (round 8, 2026-07-27) ──────────────────────────────
// The calibration WINDOW (a separate BrowserWindow the user dragged boxes
// in) failed live: on one monitor, that window covered the exact ability
// bar the user needed to see to aim at it -- they were calibrating against
// something they could not look at. Root-caused by the coordinator as a
// design mistake in HAVING a separate window at all, not a bug in either
// side's code. Fix: adjust the SAME geometry live, in THIS window, directly
// over the running game, via ordinary keyboard input this renderer owns
// itself (main.js only flips the window to interactive+focused -- it does
// not intercept or forward keys, specifically so arrows are never stolen
// from the game AND never double-fire in both places).
//
// `workingGeometry` is a LOCAL, UNSAVED copy -- nudging it never touches
// `calibration` (the committed value driving the normal single highlight
// box) until the user presses Enter, and main.js re-validates before
// persisting even then (this bridge does not trust the renderer's value as
// final, per preload.js's own comment on `saveAdjustedGeometry`).
let isAdjusting = false;
let workingGeometry = null; // {firstBoxCenterX, centerY, boxSize, spacing} | null

// Fine step is 1 (CSS/logical pixel), coarse (Shift) is 10. Deliberately NO
// DPI compensation anywhere in this file -- the whole app operates in CSS
// pixels end-to-end (main.js's window bounds, calibration geometry, this
// arithmetic), which is already consistent regardless of the OS scale
// factor. On a 200%-scaled display a 1px nudge is a 2px PHYSICAL step,
// which is exactly why the 10px coarse step exists and matters -- not a bug
// to "fix" by scaling these numbers.
const ADJUST_STEP_FINE = 1;
const ADJUST_STEP_COARSE = 10;
const ADJUST_BOX_SIZE_MIN = 10;
const ADJUST_BOX_SIZE_MAX = 200;
const ADJUST_SPACING_MIN = 10;
const ADJUST_SPACING_MAX = 300;

function clampAdjust(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

async function handleState(state) {
  lastState = state || { inGame: false };
  const myToken = ++renderToken; // stale-response guard, same pattern as the
  // repo's own gotcha (q): an async resolve can be superseded by a newer
  // state push before it resolves; only the latest render wins.
  let data;
  try {
    data = await resolveOverlayData(lastState);
  } catch (err) {
    console.error("[CoachBuild overlay] resolveOverlayData failed:", err);
    data = { phase: "error" };
  }
  if (myToken !== renderToken) return;
  render(data);
}

function render(data) {
  // The table is visible when EITHER engy's calibration flag asks for it
  // (`showTable`), OR the user is currently in interactive/edit mode. The
  // second half is a deliberate rendering-side call, not a change to
  // engy's contract: the lane bar/badge live INSIDE this same panel, and
  // interactive mode exists specifically so the user can reach them (fix
  // a wrong lane without leaving the game) -- hiding the only place those
  // controls render, at the exact moment the user asked to use them, would
  // make interactive mode silently useless whenever the table default is
  // off. The tray menu's lane submenu (main.js) is the OTHER, always-
  // available way to change lanes, so this is a convenience restore, not
  // the only path.
  // ...but NOT when there is no game at all. Outside a match the panel has
  // literally nothing to say -- `not-in-game` renders an empty message and the
  // word "CoachBuild" -- and it was sitting on top of the League CLIENT,
  // covering the PLAY button. An overlay that obscures the thing you use to
  // start a game, in order to display nothing, is strictly worse than absent.
  // Interactive/adjust mode still forces it visible, because that is when the
  // user is deliberately reaching for the controls inside it (and needs to see
  // the boxes to align them) -- including on the desktop, where aligning is
  // actually easier than mid-match.
  const hasSomethingToSay = data.phase !== "not-in-game";
  els.overlay.hidden = !((showTable && hasSomethingToSay) || isInteractive);

  renderLaneBar();

  switch (data.phase) {
    case "not-in-game":
      showMessage("");
      els.champion.textContent = "CoachBuild";
      break;
    case "no-data-any-lane":
      // Rare: no manual override, no usable auto-detected position, AND none
      // of the five real lanes had data for this champion. Distinct from the
      // old "no lane selected" dead end this replaces -- that used to be the
      // NORMAL first-run state; this is a genuine, uncommon miss.
      els.champion.textContent = data.championName || "CoachBuild";
      showMessage("No recommended skill order found for this champion in any lane.");
      break;
    case "waiting-for-champion":
      els.champion.textContent = "CoachBuild";
      showMessage("Waiting for champion…");
      break;
    case "unresolved-champion":
      els.champion.textContent = data.championName || "CoachBuild";
      showMessage("No skill data recognized for this champion.");
      break;
    case "unavailable":
      // Champion list fetch failed -- a network claim, not a champion claim.
      // Audit fix #1: this used to fall into "unresolved-champion" and lie
      // about every champion on any network hiccup.
      els.champion.textContent = data.championName || "CoachBuild";
      showMessage(MSG_UNAVAILABLE);
      break;
    case "resolved":
      renderResolved(data);
      break;
    default:
      els.champion.textContent = "CoachBuild";
      showMessage("");
  }

  scheduleRetry(data);
  renderHighlight(data);
}

function showMessage(text) {
  els.grid.hidden = true;
  els.footer.textContent = "";
  if (text) {
    els.message.hidden = false;
    els.message.textContent = text;
  } else {
    els.message.hidden = true;
    els.message.textContent = "";
  }
}

function renderResolved(data) {
  // Audit fix #4: render the champion's proper display name, not the raw/
  // matching identifier -- `championName`/`rawChampionName` is frequently
  // Riot's INTERNAL key ("MonkeyKing" for Wukong, "FiddleSticks" casing,
  // etc). `championDisplayName` comes from the matched ChampionRef's own
  // `name` field (see skillOrderData.js's resolveChampionId).
  els.champion.textContent = data.championDisplayName || data.championName || "CoachBuild";

  const { skillOrder } = data;
  if (skillOrder.status === "no-data") {
    showMessage("No recommended skill order for this champion in this lane.");
    return;
  }
  if (skillOrder.status === "error") {
    showMessage(MSG_UNAVAILABLE);
    return;
  }

  const model = skillOrder.model;
  els.message.hidden = true;
  els.message.textContent = "";
  buildGrid(model, data.championLevel);
  els.grid.hidden = false;

  // Audit fix #5: drive the footer off the ACTUAL known length of the order,
  // not the `completed` flag. `completed: false` also covers
  // `refusedBecause: "already-complete"` -- a source that published all 18
  // entries itself -- in which case `order.length === TOTAL_LEVELS` and there
  // is nothing unknown; printing "not published" under a fully-marked grid
  // would be a fabricated claim contradicting the grid directly above it.
  const order = Array.isArray(model.order) ? model.order : [];
  const parts = [];
  // Quiet, compact, non-imperative source label -- the FIRST thing a user
  // needs when the shown lane looks wrong is whether this app detected it or
  // they pinned it themselves (2026-07-27 fix). Kept in the footer, not a new
  // UI element, and never renders anything for the ordinary case (a lane
  // typed with no ambiguity would be noise).
  const laneNote = laneSourceNote(data.lane, data.laneSource);
  if (laneNote) parts.push(laneNote);
  if (order.length < TOTAL_LEVELS) parts.push("Levels 16–18 not published");
  if (Number.isFinite(model.sampleSize) && model.sampleSize > 0) {
    parts.push(`${formatGames(model.sampleSize)} games`);
  }
  els.footer.textContent = parts.join(" · ");
}

function laneSourceNote(lane, laneSource) {
  if (!lane) return null;
  const label = laneLabel(lane);
  if (laneSource === "manual") return `${label} · manual`;
  if (laneSource === "auto") return `${label} · auto`;
  // Deliberately NOT "auto" -- "auto" is Riot's own reported position (Tier 2),
  // a fact. This is a best-guess picked by comparing sample sizes across all
  // five lanes (Tier 3, see skillOrderData.js's resolveOverlayData header for
  // why the wording must not blur the confidence difference) -- "likely" reads
  // as an estimate, not a claim, and stays non-imperative (2026-07-27 fix #2).
  if (laneSource === "auto-fallback") return `${label} · likely`;
  return null;
}

function formatGames(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function buildGrid(model, championLevel) {
  const order = Array.isArray(model.order) ? model.order : [];
  const known = order.length;
  // See the header comment: highlight column is CHAMPION LEVEL, never
  // points-spent. `championLevel` is already validated to be an integer
  // 1..18 or null by skillOrderData.js's normalizeLevel.
  const currentLevel = championLevel;

  els.grid.innerHTML = "";

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th")); // corner cell, above the ability labels
  for (let lvl = 1; lvl <= TOTAL_LEVELS; lvl += 1) {
    const th = document.createElement("th");
    th.textContent = String(lvl);
    if (lvl === currentLevel) th.classList.add("cb-current");
    headRow.appendChild(th);
  }
  els.grid.appendChild(headRow);

  for (const ability of ABILITIES) {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.textContent = ability;
    label.scope = "row";
    row.appendChild(label);

    for (let lvl = 1; lvl <= TOTAL_LEVELS; lvl += 1) {
      const cell = document.createElement("td");
      const idx = lvl - 1;
      if (idx < known) {
        if (order[idx] === ability) cell.classList.add("cb-marked");
      } else {
        cell.classList.add("cb-unknown");
      }
      if (lvl === currentLevel) cell.classList.add("cb-current");
      row.appendChild(cell);
    }
    els.grid.appendChild(row);
  }
}

// ── The ability highlight box (new, 2026-07-27) ─────────────────────────────
// See this file's header for the compliance reasoning. This is the ONE place
// resolveNextSkill is called in the entire app.

/**
 * @returns {object|null} a `{kind:"recommend", ability, ...}` result, or null
 *   for EVERY refusal (all 11 -- see lib/nextSkill.ts's NextSkillRefusal) and
 *   for every phase that isn't a resolved "ok" skill order. Never guesses.
 */
function computeNextSkillRecommendation(data) {
  if (data.phase !== "resolved" || !data.skillOrder || data.skillOrder.status !== "ok") return null;

  // Deliberately no pre-filtering of `championLevel`/`abilityRanks` here --
  // resolveNextSkill's OWN validation (bad-level / bad-ranks / non-standard-
  // kit / over-spent / etc) is the single source of truth for what counts as
  // a usable reading. Duplicating those checks here would risk this file's
  // guess drifting out of sync with the engine's -- see lib/nextSkill.ts's
  // header on why every one of those refusals exists and is load-bearing.
  const result = resolveNextSkill({
    model: data.skillOrder.model,
    level: data.championLevel,
    ranks: data.abilityRanks,
  });

  return result.kind === "recommend" ? result : null;
}

/** Validates engy's calibration payload defensively -- crosses a process
 *  boundary (main -> renderer over IPC), and a malformed/half-built object
 *  must never silently draw a box at NaN/undefined coordinates (which can
 *  render as `0,0` or a huge nonsense rectangle depending on the engine --
 *  worth refusing outright rather than trusting). */
function isValidCalibration(g) {
  return (
    g &&
    typeof g === "object" &&
    Number.isFinite(g.firstBoxCenterX) &&
    Number.isFinite(g.centerY) &&
    Number.isFinite(g.boxSize) &&
    g.boxSize > 0 &&
    Number.isFinite(g.spacing)
  );
}

/**
 * Applies a calibration push from the main process. See the header comment
 * on `calibration` (module scope) for the contract this expects -- exact
 * shape documented in HANDOFF-engo.md for engy to match, since main.js/
 * preload.js are his files and this side cannot add the sending half itself.
 */
function applyCalibration(geometry) {
  if (!isValidCalibration(geometry)) {
    console.warn("[CoachBuild overlay] ignoring malformed calibration payload:", geometry);
    return;
  }
  calibration = {
    firstBoxCenterX: geometry.firstBoxCenterX,
    centerY: geometry.centerY,
    boxSize: geometry.boxSize,
    spacing: geometry.spacing,
  };
  showTable = !!geometry.showTable;
  // Calibration can change independent of any new game-state push (the user
  // re-runs calibrate.js, or flips the show-table flag) -- re-render
  // immediately from whatever was last resolved rather than waiting for the
  // next state tick, which could be seconds away or (out of game) never.
  // Cheap: resolveOverlayData's own caches make this a near-instant re-run,
  // not a fresh network fetch (same pattern selectLane already relies on).
  handleState(lastState);
}

function renderHighlight(data) {
  if (isAdjusting) {
    // The 4-box adjust preview (renderAdjustBoxes) owns this surface
    // entirely while active -- a single "current recommendation" box would
    // be redundant with, and visually conflict with, the full-row preview
    // the user is actively aligning against the real HUD.
    els.highlight.hidden = true;
    return;
  }

  const rec = calibration ? computeNextSkillRecommendation(data) : null;

  if (!rec) {
    els.highlight.hidden = true;
    return;
  }

  const slot = ABILITY_SLOT_INDEX[rec.ability];
  const centerX = calibration.firstBoxCenterX + slot * calibration.spacing;
  const centerY = calibration.centerY;
  const size = calibration.boxSize;

  els.highlight.style.left = `${centerX - size / 2}px`;
  els.highlight.style.top = `${centerY - size / 2}px`;
  els.highlight.style.width = `${size}px`;
  els.highlight.style.height = `${size}px`;
  els.highlight.hidden = false;
}

// ── Adjust-in-place mode (round 8, 2026-07-27) ──────────────────────────────
// See the module-scope comment above `isAdjusting` for the why. This is the
// renderer's ENTIRE half of the feature: main.js drives entry/exit via
// `onAdjustModeChange`; everything about what happens while it's open --
// snapshotting, the 4-box preview, keyboard handling, save/cancel -- lives
// here.

/**
 * Entry point for `window.coachbuildIPC.onAdjustModeChange`. Reactive only
 * -- this file never sets `isAdjusting` itself outside this function, even
 * from its own Enter/Escape handlers (see handleAdjustKeydown): main.js is
 * the single source of truth for whether adjust mode is open, and
 * preload.js's own comment confirms save/cancel are just two more paths
 * that lead back here with `false`, not something this file should race by
 * tearing itself down optimistically.
 */
function setAdjustMode(next) {
  isAdjusting = !!next;

  if (isAdjusting) {
    // Snapshot the most recently committed calibration into a local working
    // copy -- nudging this NEVER touches `calibration` itself until Enter.
    // Falls back to main.js's own scaled-default reference geometry
    // (lib/calibrationSettings.js's REFERENCE_GEOMETRY, 1920x1080 baseline)
    // only in the shouldn't-happen case that adjust mode somehow opened
    // before any onCalibration push ever arrived -- main.js always has SOME
    // geometry (persisted or freshly scaled) before offering adjust mode in
    // practice, but this file never trusts that from the renderer side.
    workingGeometry = calibration
      ? { ...calibration }
      : { firstBoxCenterX: 830, centerY: 1010, boxSize: 48, spacing: 68 };
    document.addEventListener("keydown", handleAdjustKeydown);
    els.adjust.hidden = false;
    renderAdjustBoxes();
  } else {
    document.removeEventListener("keydown", handleAdjustKeydown);
    els.adjust.hidden = true;
    workingGeometry = null;
  }

  // Single re-render path for both directions: entering hides the single
  // highlight box (renderHighlight's own isAdjusting check) without needing
  // a separate call here, and leaving restores it from `calibration` --
  // which, on the SAVE path, may already reflect the new value if
  // `onCalibration`'s push happened to arrive first, or still be the old
  // one for one frame until it does (harmless, self-correcting).
  handleState(lastState);
}

function renderAdjustBoxes() {
  if (!workingGeometry) return;
  const { firstBoxCenterX, centerY, boxSize, spacing } = workingGeometry;

  for (const ability of ABILITIES) {
    const slot = ABILITY_SLOT_INDEX[ability];
    const centerX = firstBoxCenterX + slot * spacing;
    const box = els.adjustBoxes[ability];
    box.style.left = `${centerX - boxSize / 2}px`;
    box.style.top = `${centerY - boxSize / 2}px`;
    box.style.width = `${boxSize}px`;
    box.style.height = `${boxSize}px`;
  }

  // Anchors the legend's BOTTOM-CENTER at the row's horizontal midpoint
  // (slot 1.5 -- halfway between W and E, i.e. the middle of a 4-box row)
  // just above the row's top edge. `.cb-adjust-legend`'s own
  // `transform: translate(-50%, -100%)` does the actual centering/upward
  // offset, so this only ever needs to set the anchor POINT, never the
  // legend's own rendered width/height.
  const rowCenterX = firstBoxCenterX + 1.5 * spacing;
  els.adjustLegend.style.left = `${rowCenterX}px`;
  els.adjustLegend.style.top = `${centerY - boxSize / 2}px`;
}

/**
 * Keyboard handling for adjust mode -- attached/detached entirely by
 * setAdjustMode above, never left registered outside an active session.
 * main.js deliberately does NOT intercept or forward keys (see preload.js's
 * comment: global shortcuts here would either steal input from the game or
 * double-fire), so this is the renderer's own `keydown` listener, exactly
 * as the contract specifies.
 */
function handleAdjustKeydown(e) {
  if (!workingGeometry) return;
  const step = e.shiftKey ? ADJUST_STEP_COARSE : ADJUST_STEP_FINE;

  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      workingGeometry.firstBoxCenterX -= step;
      renderAdjustBoxes();
      return;
    case "ArrowRight":
      e.preventDefault();
      workingGeometry.firstBoxCenterX += step;
      renderAdjustBoxes();
      return;
    case "ArrowUp":
      e.preventDefault();
      workingGeometry.centerY -= step;
      renderAdjustBoxes();
      return;
    case "ArrowDown":
      e.preventDefault();
      workingGeometry.centerY += step;
      renderAdjustBoxes();
      return;
    case "+":
    case "=":
      e.preventDefault();
      workingGeometry.boxSize = clampAdjust(workingGeometry.boxSize + 1, ADJUST_BOX_SIZE_MIN, ADJUST_BOX_SIZE_MAX);
      renderAdjustBoxes();
      return;
    case "-":
    case "_":
      e.preventDefault();
      workingGeometry.boxSize = clampAdjust(workingGeometry.boxSize - 1, ADJUST_BOX_SIZE_MIN, ADJUST_BOX_SIZE_MAX);
      renderAdjustBoxes();
      return;
    case "[":
      e.preventDefault();
      workingGeometry.spacing = clampAdjust(workingGeometry.spacing - 1, ADJUST_SPACING_MIN, ADJUST_SPACING_MAX);
      renderAdjustBoxes();
      return;
    case "]":
      e.preventDefault();
      workingGeometry.spacing = clampAdjust(workingGeometry.spacing + 1, ADJUST_SPACING_MIN, ADJUST_SPACING_MAX);
      renderAdjustBoxes();
      return;
    case "Tab":
      // Deliberate no-op (engy's suggestion, agreed): the geometry model is
      // ONE rigid row ({firstBoxCenterX, centerY, boxSize, spacing}), the
      // same shape used everywhere else including the now-retired
      // calibration window -- there is no per-box independent position to
      // Tab between. preventDefault anyway so Tab can never leak focus out
      // of this window into whatever's behind it while adjust mode holds
      // keyboard input.
      e.preventDefault();
      return;
    case "Enter":
      e.preventDefault();
      if (typeof window.coachbuildIPC.saveAdjustedGeometry === "function") {
        // Pure geometry only -- no `showTable` -- per the contract: that
        // flag isn't part of what adjust mode edits.
        window.coachbuildIPC.saveAdjustedGeometry({ ...workingGeometry });
      } else {
        console.warn("[CoachBuild overlay] window.coachbuildIPC.saveAdjustedGeometry unavailable -- cannot save the adjustment");
      }
      // No local teardown here -- wait for main.js's own onAdjustModeChange(false)
      // (see setAdjustMode's header comment on why this stays reactive-only).
      return;
    case "Escape":
      e.preventDefault();
      if (typeof window.coachbuildIPC.cancelAdjustedGeometry === "function") {
        window.coachbuildIPC.cancelAdjustedGeometry();
      } else {
        console.warn("[CoachBuild overlay] window.coachbuildIPC.cancelAdjustedGeometry unavailable -- cannot cancel the adjustment");
      }
      return;
    default:
      return; // every other key passes through untouched
  }
}

// ── Lane control (2026-07-27: moved to main-process ownership) ─────────────
// This bar edits the MANUAL OVERRIDE only -- `lastState.lane` -- not the
// auto-detected lane (`lastState.detectedPosition`), which the data layer
// consults on its own when there's no override (see skillOrderData.js's
// resolveOverlayData). Persistence is main.js's job now: selecting a lane
// here sends an IPC message and main.js writes it to disk (under
// app.getPath('userData'), not localStorage -- this window's `file://`
// origin makes localStorage unreliable across restarts, and localStorage was
// also the wrong OWNER once the Overwolf desktop window (the only other
// writer) was dropped in the Electron pivot). `lastState` is updated
// optimistically here so the bar/grid react immediately without waiting for
// the IPC round-trip; main.js's own push (which will arrive a beat later)
// then just confirms the same value.
let lastLaneBarSignature = null; // audit fix #3, see renderLaneBar below

function renderLaneBar() {
  const lane = lastState && typeof lastState.lane === "string" ? lastState.lane : null;
  const signature = `${isInteractive}:${lane}`;

  // Audit fix #3: `render()` calls this on EVERY state push, which -- before
  // this guard -- meant `innerHTML = ""` + fresh <button> elements every
  // single tick, including ticks that change nothing about the lane or
  // interactive mode. A `click` only fires when mousedown and mouseup land on
  // the SAME element, so a push landing between the two silently ate the
  // click. Short-circuiting when nothing the lane bar actually depends on has
  // changed removes the window entirely, without touching the main grid's
  // full-rebuild-every-time approach (deliberately kept -- see the header
  // comment on why NOT incrementalizing that one is correct).
  if (signature === lastLaneBarSignature) return;
  lastLaneBarSignature = signature;

  els.lanebar.innerHTML = "";

  if (!isInteractive) {
    // Clickthrough: a PLAIN LABEL, deliberately not styled or behaving like
    // a button -- input doesn't reach this page right now, so anything that
    // looks pressable here would be actively misleading. "Auto" here means
    // "no override set" -- NOT "broken"; the data layer still resolves a real
    // lane via auto-detection or the fallback loop, shown in the footer's
    // source note once a champion resolves.
    const span = document.createElement("span");
    span.className = "cb-lane-static";
    span.textContent = lane ? laneLabel(lane) : "Auto";
    els.lanebar.appendChild(span);
    return;
  }

  // "AUTO" button first -- clears the override, handing lane resolution back
  // to auto-detection/fallback. Distinct from the five real lane buttons,
  // never labeled as if it were a sixth lane.
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "cb-lane-btn";
  if (lane === null) autoBtn.classList.add("cb-lane-btn--active");
  autoBtn.textContent = "AUTO";
  autoBtn.setAttribute("aria-pressed", String(lane === null));
  autoBtn.addEventListener("click", () => selectLane(null));
  els.lanebar.appendChild(autoBtn);

  for (const l of LANES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-lane-btn";
    if (l === lane) btn.classList.add("cb-lane-btn--active");
    btn.textContent = LANE_SHORT[l];
    btn.setAttribute("aria-pressed", String(l === lane));
    btn.addEventListener("click", () => selectLane(l));
    els.lanebar.appendChild(btn);
  }
}

function selectLane(lane) {
  lastState = { ...lastState, lane };
  renderLaneBar(); // the lane just changed -> signature differs -> rebuilds,
  // reflecting the new active lane immediately.
  handleState(lastState); // re-resolve under the new lane -- this is the
  // "immediately refetches the order" requirement; fetchSkillOrder's cache
  // is keyed by (championId, roleId), so a lane the player already visited
  // this game resolves instantly from cache instead of a fresh request.

  if (typeof window.coachbuildIPC !== "undefined" && typeof window.coachbuildIPC.setLane === "function") {
    window.coachbuildIPC.setLane(lane);
  } else {
    console.warn("[CoachBuild overlay] window.coachbuildIPC.setLane unavailable -- lane change will not persist");
  }
}

// ── Retry timer (audit fix #2) ──────────────────────────────────────────────
// The cooldowns in skillOrderData.js (ERROR_RETRY_COOLDOWN_MS,
// NO_DATA_RETRY_COOLDOWN_MS, CHAMPION_LIST_RETRY_COOLDOWN_MS) are correct in
// isolation, but `fetchSkillOrder`/`resolveChampionId` are only ever CALLED
// from `handleState` (a GEP push) or `selectLane` (a manual click) -- there
// was nothing that called them again on a timer. A player who is level 18,
// or mid-stalemate with no level-up for minutes, would never trigger another
// onState push; a single load-in fetch landing on the observed upstream blip
// (see skillOrderData.js's NO_DATA_RETRY_COOLDOWN_MS comment -- this is a
// REAL, reproduced failure mode, not hypothetical) would then wedge the
// overlay blank for the rest of the match, exactly what the cooldowns were
// supposed to prevent.
let retryTimer = null;

function retryDelayMs(data) {
  if (data.phase === "unavailable") return CHAMPION_LIST_RETRY_COOLDOWN_MS;
  // Same underlying claim class as a single lane's "no-data" (see
  // skillOrderData.js's NO_DATA_RETRY_COOLDOWN_MS comment on why a null is
  // retried at all) -- the fallback loop tried all five lanes and none had
  // data THIS TIME, which upstream flakiness can still resolve on a retry.
  if (data.phase === "no-data-any-lane") return NO_DATA_RETRY_COOLDOWN_MS;
  if (data.phase === "resolved") {
    if (data.skillOrder.status === "error") return ERROR_RETRY_COOLDOWN_MS;
    if (data.skillOrder.status === "no-data") return NO_DATA_RETRY_COOLDOWN_MS;
  }
  return null; // "ok", or a phase with nothing network-shaped to retry
}

function scheduleRetry(data) {
  // Always clear first -- guards against ever stacking multiple outstanding
  // timers (e.g. two state pushes landing in quick succession) -- then only
  // re-arm if the freshly-rendered data still warrants one. A game-exit
  // ("not-in-game") or a successful resolve both fall out of retryDelayMs as
  // `null`, so this single clear-then-maybe-arm also satisfies "clear it on
  // game exit and on a successful resolve" without a separate code path.
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const delay = retryDelayMs(data);
  if (delay == null || !Number.isFinite(delay)) return;
  // +1000ms so the retry fires strictly after the cache/cooldown window this
  // module already enforces has elapsed, not exactly on its boundary.
  retryTimer = setTimeout(() => {
    retryTimer = null;
    handleState(lastState);
  }, delay + 1000);
}

// ── Public contract ──────────────────────────────────────────────────────────
window.CoachBuildOverlay = {
  onState(state) {
    handleState(state);
  },
  onInteractiveChange(nextIsInteractive) {
    isInteractive = !!nextIsInteractive;
    els.overlay.classList.toggle("cb-overlay--interactive", isInteractive);
    els.badge.hidden = !isInteractive;
    // Table visibility now depends on `isInteractive` too (see render()'s
    // `els.overlay.hidden` line) -- a full re-render (not just renderLaneBar)
    // so flipping interactive mode immediately shows/hides the panel instead
    // of waiting for the next state push. render() calls renderLaneBar()
    // itself, so this supersedes the old standalone call rather than
    // duplicating it.
    handleState(lastState);
  },
};

// Initial paint before the first onState/onInteractiveChange call ever
// arrives (e.g. the window is created before champ-select data exists) --
// same full-rebuild render path as every subsequent call, so there is no
// separate "first render" code path to drift from the steady-state one.
render({ phase: "not-in-game" });

// ── Transport (PORTED 2026-07-27: Overwolf -> Electron, overlay-host pivot) ────
//
// The contract above (`window.CoachBuildOverlay.onState` / `.onInteractiveChange`)
// is unchanged from the Overwolf build -- only the wire underneath it changed.
// Overwolf's `overwolf.windows.sendMessage` / `onMessageReceived` is replaced by
// Electron IPC: `preload.js` exposes `window.coachbuildIPC` via `contextBridge`
// (the renderer here has `contextIsolation: true`, so it can never reach
// `ipcRenderer` directly -- only through whatever preload.js explicitly exposes).
// Same shape of problem, same fix: `main.js`'s `webContents.send(...)` is
// fire-and-forget exactly like `sendMessage` was, so a push sent before this
// listener attaches is still dropped, not buffered -- the READY handshake below
// exists for the identical reason it did in background.js.
if (typeof window.coachbuildIPC !== "undefined") {
  window.coachbuildIPC.onState((state) => {
    try {
      window.CoachBuildOverlay.onState(state);
    } catch (err) {
      // A malformed push must not leave a dead overlay on screen for the rest of
      // the game -- log it and keep the last good render.
      console.warn("[CoachBuild overlay] failed to apply pushed state:", err);
    }
  });

  window.coachbuildIPC.onInteractiveChange((isInteractiveNext) => {
    try {
      window.CoachBuildOverlay.onInteractiveChange(isInteractiveNext);
    } catch (err) {
      console.warn("[CoachBuild overlay] failed to apply interactive-change push:", err);
    }
  });

  // ── Calibration -- WIRED AND CONFIRMED LIVE (round 8) ───────────────────────
  //   IPC channel:        'coachbuild-calibration'
  //   preload.js exposes: window.coachbuildIPC.onCalibration(callback)
  //   payload shape:       { firstBoxCenterX, centerY, boxSize, spacing, showTable }
  // Guarded the same way `setLane` is guarded above -- an absent function on
  // `window.coachbuildIPC` must degrade to "highlight box stays hidden,
  // nothing crashes," never a thrown error that takes the rest of the
  // renderer down with it. Kept even though main.js now always exposes this:
  // belt-and-braces costs nothing and matches every other IPC call site here.
  if (typeof window.coachbuildIPC.onCalibration === "function") {
    window.coachbuildIPC.onCalibration((geometry) => {
      try {
        applyCalibration(geometry);
      } catch (err) {
        console.warn("[CoachBuild overlay] failed to apply calibration push:", err);
      }
    });
  } else {
    console.warn(
      "[CoachBuild overlay] window.coachbuildIPC.onCalibration unavailable -- the highlight box has no geometry to draw with and will stay hidden until this is wired up (see HANDOFF-engo.md)"
    );
  }

  // ── Adjust-in-place mode (round 8, 2026-07-27) ──────────────────────────────
  //   IPC channel:        'coachbuild-adjust-mode'
  //   preload.js exposes: window.coachbuildIPC.onAdjustModeChange(callback)
  //   payload:             boolean -- true on open, false on close by ANY path
  //                         (Ctrl+F12, tray, or this file's own save/cancel).
  // See setAdjustMode/handleAdjustKeydown above for the renderer's entire
  // half of this feature. Same defensive guard pattern as onCalibration.
  if (typeof window.coachbuildIPC.onAdjustModeChange === "function") {
    window.coachbuildIPC.onAdjustModeChange((isAdjustingNext) => {
      try {
        setAdjustMode(isAdjustingNext);
      } catch (err) {
        console.warn("[CoachBuild overlay] failed to apply adjust-mode change:", err);
      }
    });
  } else {
    console.warn(
      "[CoachBuild overlay] window.coachbuildIPC.onAdjustModeChange unavailable -- adjust-in-place will not open"
    );
  }

  // Announce readiness -- main.js answers with a fresh snapshot of current
  // state + interactive mode (+ calibration, confirmed live). See
  // background.js's original comment (same reasoning, ported verbatim): the
  // in-game window can only ever RECEIVE pushes, never pull, so a dropped
  // first push would otherwise leave the overlay blank until the next
  // level-up, possibly minutes into the game, at exactly the moment the
  // player most wants to see it.
  window.coachbuildIPC.ready();
} else {
  console.warn("[CoachBuild overlay] window.coachbuildIPC is not available -- preload.js did not run or contextBridge failed");
}
