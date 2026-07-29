// ─────────────────────────────────────────────────────────────────────────────
// skillOrder.ts — pure model + display helpers for the "recommended skill
// order" card on the Builds page (new feature, 2026-07-27).
//
// This module backs a RECOMMENDATION card, presented in two parts:
//   1. a compact max-priority string ("Q › W › E") — the thing players actually
//      memorise, so it goes first;
//   2. the classic 18-column SKILL GRID — one row per ability, one column per
//      champion level, a coloured chip where that ability takes a point.
//
// ── The grid replaced per-ability level lists on 2026-07-29 ────────────────
// This header used to argue the opposite: that four short "Q 2 4 5 7 9" rows
// beat a grid because an 18-column grid needs ~18 touch-target-width columns
// and this is a phone-first app. That decision was REVERSED by the user, who
// asked for the grid every reference site uses, everywhere. The mobile
// objection was real but was never a column-WIDTH problem: the cells are not
// touch targets, so `minmax(0, 1fr)` tracks simply shrink to fit a 390px
// screen. See components/SkillGrid.tsx's header for the mechanism.
//
// The grid is the SAME primitive GameDetailSheet's per-game timeline renders
// (components/SkillGrid.tsx + skillOrderGrid.ts) — one implementation, because
// two lookalike grids will drift. What differs is the FILL RULE, and it differs
// on purpose: a per-game grid is a factual record and shows exactly the levels
// that game reached, while this recommendation always answers all 18.
//
// `SkillOrderModel` mirrors the contract engy's data layer builds against
// (GET /api/skill-order?champ=&role=, app's standard envelope: 200 + JSON body
// IS the payload directly, `null` on "no data" — same "absent, not empty"
// convention ProConsensusCard's N=0 "hidden" state already uses). Defined here
// rather than imported from lib/ because this feature was split engy(backend)/
// fronty(frontend) — engy owns lib/ and app/api/, this file is the frontend's
// own copy of the SAME shape so each side can build independently. If lib/
// ever exports an identical type, these two should be reconciled to avoid
// drift — noted in HANDOFF-fronty.md.
//
// No JSX in this file (vitest 4's oxc transform can't parse JSX outside its
// default scope — same constraint proConsensus.ts/skillOrderGrid.ts document)
// so it stays importable from a plain .ts test file.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionKit } from "@/lib/types";
import { isDerivedLevel, observedLevelCount } from "@/lib/skillOrderModel";
import {
  buildSkillGrid,
  SKILL_GRID_COLUMNS,
  type SkillGridCell,
} from "@/components/skillOrderGrid";

// Provenance is NOT duplicated the way the model shape above is. The rule for
// "which levels did we derive" has exactly one correct implementation
// (including the back-compat fallback for payloads cached before
// `observedLevels` existed), and two copies of it would be a real correctness
// hole rather than the cosmetic type duplication this file otherwise accepts
// — the same reasoning the `kit` field's comment already sets out.
// lib/skillOrderModel.ts is pure (no fetch, no I/O), so importing it into a
// client component costs nothing at runtime.
export { isDerivedLevel, observedLevelCount };

export type Ability = "Q" | "W" | "E" | "R";

export interface SkillOrderModel {
  /** Max-priority order of the basic abilities, e.g. ["Q","W","E"]. */
  priority: Ability[];
  /** Level numbers (1-18) at which each ability is ranked up. */
  levels: Record<Ability, number[]>;
  /** Sequence by level; index 0 = level 1. Length 15 or 18. */
  order: Ability[];
  /** True only when levels 16-18 were derived by the completion rule.
   *  False means the source's 15 are all we honestly know. */
  completed: boolean;
  /** How many LEADING entries of `order` came VERBATIM from the source;
   *  anything past that index was DERIVED and must not be rendered as
   *  measured. Optional on the wire for back-compat — read it through
   *  `isDerivedLevel` / `observedLevelCount`, never raw. See the same field on
   *  lib/types.ts's SkillOrderModel. */
  observedLevels?: number;
  /** Which priority resolved the derived tail — op.gg's own published max
   *  order, or one inferred from the observed path. Absent when nothing was
   *  derived. Provenance, never a score. */
  completionBasis?: "published" | "derived";
  /** Levels the derivation refused, filled from the max-priority order so the
   *  grid reads as a complete 18. A GUESS — read it through
   *  `buildRecommendedSkillGrid`, which tags those cells `inferred` so they
   *  render visibly differently. Never part of `order`. See the same field on
   *  lib/types.ts's SkillOrderModel. */
  inferredTail?: Ability[];
  /** Which priority produced `inferredTail`. Provenance, never a score. */
  inferredBasis?: "published" | "derived";
  /** Games behind this order. */
  sampleSize: number;
  /** 0..1, or null when not supplied. */
  winRate: number | null;
  /** Share of games using this order, 0..1, or null. */
  share: number | null;
  /** This champion's real per-ability rank rules, as resolved server-side from
   *  Data Dragon. Carried verbatim from the API payload (this module never
   *  reconstructs the model, so it arrives intact) and consumed by
   *  lib/nextSkill.ts's resolveNextSkill — see the `kit` field on lib/types.ts's
   *  SkillOrderModel for what each of its three states means. Typed as the
   *  shared ChampionKit rather than re-declared, because unlike the rest of
   *  this file's deliberate frontend/backend split it is passed STRAIGHT into
   *  a lib/ function, so drift here would be a real type hole rather than a
   *  cosmetic duplication. */
  kit?: ChampionKit | null;
}

/** Row order for the skill-path display — Q/W/E/R, R last and marked
 *  distinctly (see SkillOrderCard's ROW styling) since 6/11/16 are the
 *  power-spike levels. Matches skillOrderGrid.ts's SKILL_ROWS order so the
 *  two features read consistently if a user has both open (GameDetailSheet's
 *  timeline + this card), even though they're otherwise independent. */
export const ABILITY_ROWS: readonly Ability[] = ["Q", "W", "E", "R"];

/** "Q › W › E" — the compact max-priority string, first thing on the card
 *  per the U.GG-derived convention (module header). Uses U+203A (single
 *  right-pointing angle quotation mark), not a plain ">" — a deliberate
 *  typographic choice, not an escaping accident. */
export function formatPriorityString(priority: Ability[]): string {
  return priority.join(" › ");
}

/** Ascending copy of a level list — `SkillOrderModel.levels[ability]` isn't
 *  contractually guaranteed to already be sorted, and the path row must read
 *  low-to-high. Never mutates the input. */
export function sortedLevels(levels: number[]): number[] {
  return [...levels].sort((a, b) => a - b);
}

/**
 * The full 18-level recommendation: the model's own `order` (measured levels,
 * plus any the arithmetic DERIVED) followed by the INFERRED tail.
 *
 * Concatenating here rather than in the model is the whole design: `order`
 * keeps its exact prior meaning for every other consumer — above all
 * lib/nextSkill.ts, whose live in-game refusal past level 15 depends on it —
 * and only this display path opts into the guess.
 *
 * May still be SHORTER than 18 when the inference itself came up short (the
 * priority named nothing left under a cap). Those levels are genuinely unknown
 * and the grid leaves them empty rather than inventing a chip.
 */
export function recommendedSkillOrder(
  model: Pick<SkillOrderModel, "order" | "inferredTail">
): Ability[] {
  const order = Array.isArray(model.order) ? model.order : [];
  const tail = Array.isArray(model.inferredTail) ? model.inferredTail : [];
  return [...order, ...tail];
}

/**
 * The 4×18 grid for the recommendation card, with every cell tagged by
 * provenance so SkillGrid can render measured / derived / inferred levels
 * distinguishably.
 *
 * Always 18 columns wide — a recommendation answers the whole game (user
 * directive 2026-07-29). That is this CALLER's rule, not the grid's: the same
 * primitive backs GameDetailSheet, where a game that ended at level 16 must
 * keep showing 16 and must never be padded.
 */
export function buildRecommendedSkillGrid(
  model: Pick<SkillOrderModel, "order" | "completed" | "observedLevels" | "inferredTail">
): (SkillGridCell | null)[][] {
  return buildSkillGrid(recommendedSkillOrder(model), {
    columns: SKILL_GRID_COLUMNS,
    measuredThrough: observedLevelCount(model),
    derivedThrough: Array.isArray(model.order) ? model.order.length : 0,
  });
}

/** Does this model carry levels the app DERIVED by arithmetic? */
export function hasDerivedTail(
  model: Pick<SkillOrderModel, "order" | "completed" | "observedLevels">
): boolean {
  const len = Array.isArray(model.order) ? model.order.length : 0;
  return len > observedLevelCount(model);
}

/** Does this model carry levels the app GUESSED from the priority order? */
export function hasInferredTail(model: Pick<SkillOrderModel, "inferredTail">): boolean {
  return Array.isArray(model.inferredTail) && model.inferredTail.length > 0;
}

/**
 * The level at which the inferred tail STARTS (1-based), or null when there
 * isn't one. Named in the caption so the disclosure is specific — "levels 16-18
 * are inferred" is a disclosure, "some levels are inferred" is a shrug.
 */
export function inferredTailRange(
  model: Pick<SkillOrderModel, "order" | "inferredTail">
): { from: number; to: number } | null {
  if (!hasInferredTail(model)) return null;
  const from = (Array.isArray(model.order) ? model.order.length : 0) + 1;
  const to = from + (model.inferredTail as Ability[]).length - 1;
  return { from, to };
}

/** Honest sample-size caption for the card footer — "N games", plus win rate
 *  / pick share ONLY when the model actually supplies them (both are
 *  `number | null` on the contract; a null here means "not supplied", never
 *  rendered as 0% or omitted silently without the games-count still showing).
 *  Percent formatting matches proConsensus.ts's `formatSharePct` exactly (same
 *  house rule: round to a whole percent, never a decimal) — this module
 *  doesn't reimplement it, see SkillOrderCard's import. */
export function formatSkillOrderSampleLine(
  model: Pick<SkillOrderModel, "sampleSize" | "winRate" | "share">,
  formatPct: (share: number) => string
): string {
  const parts = [`${model.sampleSize} game${model.sampleSize === 1 ? "" : "s"}`];
  if (model.winRate !== null) parts.push(`${formatPct(model.winRate)} win rate`);
  if (model.share !== null) parts.push(`${formatPct(model.share)} pick rate`);
  return parts.join(" · ");
}

/** Sample size below which the fractions above are more noise than signal —
 *  mirrors ProConsensusCard's own LOW_SAMPLE_THRESHOLD (=3) and rationale
 *  verbatim (a real "pros go Q max on this matchup" claim CAN be true off 1-2
 *  games, but the card should say so rather than imply a 20-game confidence).
 *  Kept as this card's own constant rather than importing ProConsensusCard's
 *  (that one isn't exported, and the two cards are independent features that
 *  happen to share a threshold value, not a coupled one). */
export const LOW_SAMPLE_THRESHOLD = 3;

/** Fetches the recommended skill order for one champion+lane. Never throws —
 *  degrades to `{ status: "error" }` so the caller never needs its own
 *  try/catch, same posture as heroContracts.ts's getHeroStats. Returns
 *  `{ status: "hidden" }` for the contract's `null` payload ("no data" is a
 *  normal 200, not an error — the caller must render NO card, not an empty
 *  one, per the "absent, not empty" convention ProConsensusCard's N=0 state
 *  already established). */
export type SkillOrderFetchResult =
  | { status: "ok"; model: SkillOrderModel }
  | { status: "hidden" }
  | { status: "error"; reason: string };

/** Minimal shape guard — malformed JSON (wrong deploy skew, a route that
 *  changed shape underneath this card) must never be trusted as a real model.
 *  Deliberately loose (doesn't validate every level number is 1-18, etc.) —
 *  just enough structure to rule out "not a SkillOrderModel at all" before
 *  rendering numbers pulled off it. */
function isSkillOrderModel(data: unknown): data is SkillOrderModel {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    Array.isArray(d.priority) &&
    typeof d.levels === "object" &&
    d.levels !== null &&
    Array.isArray(d.order) &&
    typeof d.completed === "boolean" &&
    typeof d.sampleSize === "number"
  );
}

/**
 * The five concrete lane role ids, in the order they are probed. Role 5 is NOT
 * in this list on purpose — see `fetchSkillOrderBestLane`.
 */
const CONCRETE_ROLE_IDS = [0, 1, 2, 3, 4] as const;

/**
 * Fetch a skill order when the lane is UNKNOWN.
 *
 * `/compact` used to send `role=5` with the comment "let the API pick". The API
 * never picked. `opggPosition(5)` returns null (op.gg rejects `all`/`none`), so
 * role=5 returns `null` for EVERY champion and the panel silently rendered
 * nothing — verified against production 2026-07-27 for both Udyr and Ahri. The
 * comment described an intention nobody implemented, which is why this survived:
 * the code looked deliberate.
 *
 * The overlay already solved the same problem (see `overlay-host/js/
 * skillOrderData.js`): probe every concrete lane and keep whichever resolves
 * with the LARGEST `sampleSize`. That beats a fixed lane priority — a champion
 * played mostly bot but occasionally mid should return the bot order, and only
 * the sample size knows which is which.
 *
 * `hidden` (a legitimate "no data for this lane") is not an error, so a champion
 * with no data in ANY lane still degrades to `hidden` rather than to a spurious
 * failure. A real transport error is only surfaced when NOTHING resolved.
 */
export async function fetchSkillOrderBestLane(championId: number): Promise<SkillOrderFetchResult> {
  const settled = await Promise.all(
    CONCRETE_ROLE_IDS.map((role) => fetchSkillOrder(championId, role))
  );

  let best: { model: SkillOrderModel; sampleSize: number } | null = null;
  let sawHidden = false;
  let firstError: SkillOrderFetchResult | null = null;

  for (const res of settled) {
    if (res.status === "ok") {
      const sampleSize = typeof res.model.sampleSize === "number" ? res.model.sampleSize : 0;
      // Strictly greater, so the earlier lane wins a tie and the result is
      // stable across calls rather than depending on network ordering.
      if (!best || sampleSize > best.sampleSize) best = { model: res.model, sampleSize };
    } else if (res.status === "hidden") {
      sawHidden = true;
    } else if (!firstError) {
      firstError = res;
    }
  }

  if (best) return { status: "ok", model: best.model };
  if (sawHidden) return { status: "hidden" };
  return firstError ?? { status: "hidden" };
}

export async function fetchSkillOrder(championId: number, role: number): Promise<SkillOrderFetchResult> {
  try {
    const res = await fetch(`/api/skill-order?champ=${championId}&role=${role}`);
    if (!res.ok) return { status: "error", reason: `HTTP ${res.status}` };
    const data: unknown = await res.json();
    if (data === null) return { status: "hidden" };
    if (!isSkillOrderModel(data)) return { status: "error", reason: "Unexpected response shape" };
    return { status: "ok", model: data };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: reason.slice(0, 60) };
  }
}
