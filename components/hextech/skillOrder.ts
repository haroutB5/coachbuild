// ─────────────────────────────────────────────────────────────────────────────
// skillOrder.ts — pure model + display helpers for the "recommended skill
// order" card on the Builds page (new feature, 2026-07-27).
//
// IMPORTANT — this is a DIFFERENT thing from skillOrderGrid.ts. That file (and
// GameDetailSheet's own "Skill Order" section) renders the 18-column TIMELINE
// of what happened in ONE pro game — untouched by this feature, do not conflate
// the two. This module backs a RECOMMENDATION card instead: research on how
// U.GG/similar sites present a leveling recommendation converges on two parts,
// in this order —
//   1. a compact max-priority string ("Q › W › E") — the thing players actually
//      memorise, so it goes first;
//   2. a per-ability PATH — one row per ability listing the levels it's ranked
//      at (e.g. "Q  2  4  5  7  9"), NOT an 18-column grid. An 18-column grid
//      needs ~18 touch-target-width columns; four short rows fit a 390px phone
//      screen, which is this app's primary target.
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
