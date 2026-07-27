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
// This renders ONLY a static levels-1-18 reference table with the player's
// OWN current level highlighted as a description, plus a lane picker (the
// user choosing which static dataset to view). No imperative copy, no
// "level this next," no arrows, nothing about an opponent. See
// overwolf/js/skillOrderData.js's header for the data-layer half of this.
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
// Index used below is therefore `championLevel - 1` into `model.order`,
// full stop -- never `pointsSpent(ranks)`. `resolveNextSkill`/`pointsSpent`
// are not even imported anywhere in this directory (audit-confirmed) -- the
// former esbuild vendor bundle is gone entirely, see the TOTAL_LEVELS note
// below.
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveOverlayData,
  laneLabel,
  CHAMPION_LIST_RETRY_COOLDOWN_MS,
  ERROR_RETRY_COOLDOWN_MS,
  NO_DATA_RETRY_COOLDOWN_MS,
} from "../js/skillOrderData.js";

// Mirrors lib/skillOrderModel.ts's TOTAL_LEVELS -- that file is the SOURCE OF
// TRUTH (18 = League's 5/5/5/3 standard rank model over 18 levels, see its
// header). Inlined rather than imported from a vendored esbuild bundle
// (audit fix #7, 2026-07-27): this file previously pulled in
// overwolf/vendor/skillEngine.js for this ONE constant, but that bundle's
// entry point transitively carried `resolveNextSkill` -- the imperative
// "which ability next" engine this compliance-critical surface must NEVER
// call -- into the same module graph as the one file that exists precisely
// to not have that shape. There was also no CI catching drift: vitest.config.ts
// excludes overwolf/** entirely, so a future change to skillOrderModel.ts's
// TOTAL_LEVELS would desync a committed, unbuilt artifact silently. A single
// `18` that has been true since League shipped its rank model is a smaller
// risk than either of those. If lib/skillOrderModel.ts's TOTAL_LEVELS ever
// changes, update this constant by hand.
const TOTAL_LEVELS = 18;

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
    renderLaneBar();
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

  // Announce readiness -- main.js answers with a fresh snapshot of current
  // state + interactive mode. See background.js's original comment (same
  // reasoning, ported verbatim): the in-game window can only ever RECEIVE
  // pushes, never pull, so a dropped first push would otherwise leave the
  // overlay blank until the next level-up, possibly minutes into the game,
  // at exactly the moment the player most wants to see it.
  window.coachbuildIPC.ready();
} else {
  console.warn("[CoachBuild overlay] window.coachbuildIPC is not available -- preload.js did not run or contextBridge failed");
}
