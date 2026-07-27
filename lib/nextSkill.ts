// ─────────────────────────────────────────────────────────────────────────────
// nextSkill.ts — "which ability should I level RIGHT NOW?"
//
// PURE. No fetch, no clock, no I/O. Given (a) the recommended levelling order
// from lib/skillOrderModel.ts, (b) the champion level the in-game Live Client
// Data API reports, and (c) the per-ability ranks it reports, this decides
// which ability to put the next point into — or, far more often than you would
// expect, decides that it is not entitled to an opinion and says so.
//
// ── The whole design is the refusals ────────────────────────────────────────
// Repo CLAUDE.md hard rule #4 ("no fabricated data") and skillOrderModel.ts's
// house rule ("never present judgement as measured") both land here with more
// force than usual, because this is the one surface that tells a player to
// press a key DURING a game. A wrong answer here is not a slightly-off stat on
// a card; it is a misplayed level. So every ambiguity resolves to `none`.
//
// ── Provenance of the inputs — read this before trusting anything ───────────
// The `level` and `ranks` inputs come off Riot's in-game Live Client Data API
// (`https://127.0.0.1:2999/liveclientdata/activeplayer`). As of the commit
// that introduced this file, NO LIVE RESPONSE HAS EVER BEEN OBSERVED by the
// author — this environment has no League client. The field names
// (`level`, `abilities.{Q,W,E,R}.abilityLevel`) are taken from Riot's
// PUBLISHED SCHEMA, not from a captured payload. That is exactly why this
// module validates its inputs like they came from a stranger: `bad-level`,
// `bad-ranks` and `over-spent` are not defensive padding, they are the
// contract boundary against a wire format nobody here has run.
//
// The one thing that is NOT assumed is the arithmetic:
//   unspent = level - (Q + W + E + R)
// That is just League's one-point-per-level rule, and it is tested exhaustively
// below. The passive is excluded structurally — it has no `abilityLevel` and is
// never nameable as an `Ability` — so it cannot leak into the sum.
// ─────────────────────────────────────────────────────────────────────────────

import { MAX_RANKS, SOURCE_LEVELS, TOTAL_LEVELS, ULTIMATE_LEVELS, isAbility } from "./skillOrderModel";
import type { Ability, SkillOrderModel } from "./types";

/** Per-ability rank as reported live. The passive is deliberately absent from
 *  this type — it has no rank and must never enter the point arithmetic. */
export interface AbilityRanks {
  Q: number;
  W: number;
  E: number;
  R: number;
}

export const RANKABLE: readonly Ability[] = ["Q", "W", "E", "R"] as const;

/**
 * Why no recommendation was given. Every one of these is a NORMAL outcome, not
 * an error — the UI renders nothing for all of them. They are distinguished
 * only so a refusal is explainable (and testable) rather than mysterious.
 */
export type NextSkillRefusal =
  /** No recommended order exists at all — unsupported role, unknown champion,
   *  or a champion lib/opgg.ts refused outright (Kha'Zix's "R-Q"/"R-W"
   *  evolution tokens). */
  | "no-model"
  /** The champion level isn't an integer in 1..18. */
  | "bad-level"
  /** A rank isn't a non-negative integer, or the four don't fit in 18 points. */
  | "bad-ranks"
  /** The live ranks exceed League's standard 5/5/5/3 model, so this champion
   *  is not on the model the recommended order was derived under. Udyr (six
   *  ranks per basic, no true ultimate), Aphelios, Jayce, Yuumi. See
   *  skillOrderModel.ts's NON-STANDARD CHAMPIONS block — same population,
   *  caught the same way: by arithmetic, never by a champion blocklist. */
  | "non-standard-kit"
  /** ranks sum to MORE than the level. Impossible in a real game (you cannot
   *  spend a point you were never given), so the reading is incoherent —
   *  most plausibly a level and a rank set captured either side of a level-up.
   *  Refusing is the point: see the note on atomic reads below. */
  | "over-spent"
  /** No unspent point. The overwhelmingly common case: you level, you spend,
   *  there is nothing to advise until the next level. */
  | "no-unspent"
  /** The order stops before the point being spent. When the model is
   *  `completed: false` this is levels 16-18 on a champion whose tail
   *  skillOrderModel.ts refused to derive — the source published 15 and we
   *  will not invent the rest. */
  | "model-incomplete"
  /** Ran off the end of an order that IS complete. Requires spending an 19th
   *  point, which `bad-level`/`bad-ranks` already exclude — asserted in tests
   *  precisely because "can't happen" is a claim worth testing. */
  | "order-exhausted"
  /** The order names an ability that is already at its cap. Happens whenever
   *  the player deviates from the recommendation (maxes W when the order maxes
   *  Q) — extremely common, and NOT an error. We do not re-plan around the
   *  deviation, because re-planning would be us inventing an order the source
   *  never published. */
  | "capped-ability"
  /** The order names the ultimate at a level the game will not allow it to be
   *  ranked (R2 before 11, R3 before 16). This is REAL, not theoretical: seven
   *  popular champions (JINX, ZED, KASSADIN, SIVIR, CORKI, ZERI, QIYANA)
   *  publish R at level *12*, because the published order is a per-level MODAL
   *  AGGREGATE across many games rather than one legal path — see
   *  skillOrderModel.ts's "Why there is NO ultimate-level legality check".
   *  That aggregate is fine for the rank COUNTS the completion derives from;
   *  it is NOT fine as a live instruction, so it is refused here instead. */
  | "ultimate-illegal"
  /** The order contains something that isn't Q/W/E/R. Guards against a
   *  reshaped upstream reaching this far. */
  | "bad-order";

export interface NextSkillRecommendation {
  kind: "recommend";
  /** The ability to put the point into. */
  ability: Ability;
  /** Its rank now. */
  fromRank: number;
  /** Its rank after (always fromRank + 1). */
  toRank: number;
  /** The level slot in the recommended path this point corresponds to —
   *  1-based, i.e. `atLevel === pointsSpent + 1`. On a player who has banked
   *  points this is BELOW their champion level, which is correct and is why
   *  the index is points-spent and not level (see resolveNextSkill). */
  atLevel: number;
  /** How many points are currently unspent (>= 1 whenever we recommend). */
  unspent: number;
}

export interface NextSkillNone {
  kind: "none";
  because: NextSkillRefusal;
}

export type NextSkillResult = NextSkillRecommendation | NextSkillNone;

export interface NextSkillInput {
  /** The recommended order, or null when the app has none for this
   *  champion+role. Null is a normal, expected input. */
  model: SkillOrderModel | null;
  /** Champion level as reported live. */
  level: number;
  /** Per-ability ranks as reported live. */
  ranks: AbilityRanks;
}

const none = (because: NextSkillRefusal): NextSkillNone => ({ kind: "none", because });

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Total ability points spent. The passive cannot appear here — RANKABLE is
 *  the closed set of the four rankable slots, so there is no path by which a
 *  passive's (non-existent) level could be added in. */
export function pointsSpent(ranks: AbilityRanks): number {
  return RANKABLE.reduce((sum, a) => sum + ranks[a], 0);
}

/**
 * Which ability to level next, or an explicit refusal.
 *
 * ── Why the order is indexed by POINTS SPENT, not by level ──────────────────
 * `model.order[0]` is the recommendation for the FIRST point, `[1]` the second,
 * and so on. In ordinary play points-spent == level, so the distinction never
 * shows — but the entire reason this function exists is the case where it does
 * NOT: a player who banked a point is level 9 with 8 points spent, and their
 * next point is their NINTH, i.e. `order[8]`, the level-9 recommendation.
 * Indexing by `level` there would skip a rank permanently and, worse, would
 * silently do so at exactly the moment the player is looking at the panel.
 *
 * A pleasant consequence, worth stating because a later reader will wonder
 * whether the ultimate guard below is reachable: because we only ever
 * recommend when `unspent >= 1`, we always have `level > pointsSpent === idx`,
 * so `level >= atLevel`. A legal order can therefore never be refused for
 * ultimate legality — R at slots 5/10/15 is reached only at levels >= 6/11/16.
 * The guard fires only on the seven champions whose PUBLISHED order is not a
 * legal path (R at level 12). It is not dead code; it is the aggregate check.
 */
export function resolveNextSkill(input: NextSkillInput): NextSkillResult {
  const { model, level, ranks } = input;

  if (!model) return none("no-model");

  // ── Input validation. The wire format has never been observed here; treat
  // every field as untrusted (see this file's header). ──────────────────────
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) return none("bad-level");

  if (!ranks || typeof ranks !== "object") return none("bad-ranks");
  for (const a of RANKABLE) {
    if (!isNonNegativeInt(ranks[a])) return none("bad-ranks");
  }

  const spent = pointsSpent(ranks);
  if (spent > TOTAL_LEVELS) return none("bad-ranks");

  // Non-standard kit detection, by arithmetic on the champion's own live data
  // rather than a name list that would rot on the next rework. Udyr's sixth Q
  // rank lands here; so does anything else off the 5/5/5/3 model.
  for (const a of RANKABLE) {
    if (ranks[a] > MAX_RANKS[a]) return none("non-standard-kit");
  }

  // ── The derivation ───────────────────────────────────────────────────────
  const unspent = level - spent;
  // Incoherent reading. Cannot happen within one atomic Live Client Data
  // snapshot; CAN happen if level and ranks are ever sourced from two separate
  // HTTP calls straddling a level-up. The companion reads both from a single
  // /activeplayer response specifically so this stays unreachable in practice
  // — and this refusal is what makes that a checked property rather than a
  // hope.
  if (unspent < 0) return none("over-spent");
  if (unspent === 0) return none("no-unspent");

  const order = model.order;
  if (!Array.isArray(order) || !order.every(isAbility)) return none("bad-order");

  const idx = spent;
  if (idx >= order.length) {
    // A short order is short because skillOrderModel.ts REFUSED to derive
    // levels 16-18, not because the data is missing by accident. Report that
    // honestly rather than as a generic overrun.
    return none(!model.completed && order.length <= SOURCE_LEVELS ? "model-incomplete" : "order-exhausted");
  }

  const ability = order[idx];
  const fromRank = ranks[ability];
  const toRank = fromRank + 1;

  // The player deviated from the recommendation and has already maxed this
  // ability. There is no honest recommendation to give: the published order
  // has no branch for "you did something else."
  if (fromRank >= MAX_RANKS[ability]) return none("capped-ability");

  // Ultimate legality — the modal-aggregate check. See the doc comment above
  // and NextSkillRefusal's "ultimate-illegal" note.
  // (`toRank > ULTIMATE_LEVELS.length` is unreachable — fromRank >= 3 was
  // already sent to `capped-ability` above — but an out-of-range index here
  // would silently read `undefined` and compare false, i.e. approve. Bounds
  // first, then compare.)
  if (ability === "R") {
    if (toRank > ULTIMATE_LEVELS.length) return none("ultimate-illegal");
    if (level < ULTIMATE_LEVELS[toRank - 1]) return none("ultimate-illegal");
  }

  return { kind: "recommend", ability, fromRank, toRank, atLevel: idx + 1, unspent };
}

// ── Wire shape from the companion ───────────────────────────────────────────
// GET http://127.0.0.1:<port>/skills?session=... returns EITHER
//   { level: <int>, abilities: { Q: <int>, W: <int>, E: <int>, R: <int> } }
// or  { error: "no-live" }  (no game running — the normal state).
// Never a partial object: the companion returns the whole reading or none of
// it, so a half-populated snapshot can never reach resolveNextSkill.

export interface LiveSkillState {
  level: number;
  abilities: AbilityRanks;
}

export type LiveSkillResult = LiveSkillState | { error: string };

export function isLiveSkillError(r: LiveSkillResult): r is { error: string } {
  return typeof (r as { error?: unknown }).error === "string";
}

/**
 * Narrow an untyped companion response into a LiveSkillState, or null.
 *
 * This is the SECOND place the unobserved wire format is distrusted (the first
 * is the companion's own shaping function). Deliberate duplication: the
 * companion ships to users over `irm | iex` and updates on its own schedule,
 * so a browser can be talking to an OLDER companion than the page was built
 * against. The page must not assume the shape its own repo currently emits.
 */
export function parseLiveSkillState(raw: unknown): LiveSkillState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { level?: unknown; abilities?: unknown };
  if (!isNonNegativeInt(obj.level)) return null;
  if (!obj.abilities || typeof obj.abilities !== "object") return null;
  const src = obj.abilities as Record<string, unknown>;
  const out = {} as AbilityRanks;
  for (const a of RANKABLE) {
    const v = src[a];
    if (!isNonNegativeInt(v)) return null;
    out[a] = v;
  }
  return { level: obj.level, abilities: out };
}
