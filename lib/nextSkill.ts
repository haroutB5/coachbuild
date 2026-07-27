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
//   unspent = level - (points actually SPENT)
// That is just League's one-point-per-level rule, and it is tested exhaustively
// below. The passive is excluded structurally — it has no `abilityLevel` and is
// never nameable as an `Ability` — so it cannot leak into the sum.
//
// ── The caps are the CHAMPION'S now, not a constant ─────────────────────────
// This module used to hardcode 5/5/5/3 and 6/11/16. Both are simply false for
// seven champions, and the consequences were live bugs, not theoretical ones:
//
//   * JAYCE (6/6/6/1) was refused outright as `non-standard-kit`. A real user
//     played him and got a permanently blank overlay. That is the report this
//     change answers.
//   * KARMA / ELISE / NIDALEE (5/5/5/4) were WORSE than refused — they were
//     silently mishandled. Their R is available from level 1, so a player
//     following the published order held R:1 while the guard demanded level 6
//     for a first ultimate rank, and every early-game recommendation was
//     refused as `ultimate-illegal`. Then, because their R legitimately
//     reaches rank 4, `non-standard-kit` fired around level 16 — so the panel
//     worked for the mid-game and went dark at both ends, which reads as
//     broken rather than as declining.
//   * UDYR's R is a fourth BASIC, legally ranked at level 2; the old guard
//     refused it for not being level 6.
//
// The rules now arrive as a ChampionKit sourced from Data Dragon (see
// lib/championKit.ts for the derivation and the evidence behind it). Two
// pieces of it are load-bearing here and neither is optional:
//
//   maxRanks       — what counts as capped, and what counts as incoherent.
//   freeRanks      — ranks the game GRANTS rather than sells. Jayce's
//                    Transform and Karma/Elise/Nidalee's first R rank cost no
//                    skill point, so counting them as spent makes `unspent`
//                    off by one FOR THE WHOLE GAME. This is the subtle half:
//                    fixing only the caps would have moved Jayce from a
//                    `non-standard-kit` blank to a `no-unspent` blank, and the
//                    user's overlay would still have been empty.
//   ultimateLevels — per-champion legality, replacing the 6/11/16 constant.
// ─────────────────────────────────────────────────────────────────────────────

import { SOURCE_LEVELS, TOTAL_LEVELS, isAbility } from "./skillOrderModel";
import { STANDARD_KIT, isUltimateRankLegal, purchasedRanks } from "./championKit";
import type { Ability, ChampionKit, SkillOrderModel } from "./types";

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
  /** The live ranks exceed THIS CHAMPION'S OWN published caps, so the reading
   *  is genuinely incoherent — a rank the game could not have granted.
   *
   *  NARROWED. This used to fire for any champion that merely differed from
   *  5/5/5/3, which is what blanked Jayce. A Jayce with Q at 6 or a Karma with
   *  R at 4 is now perfectly ordinary and gets a real recommendation; only a
   *  Jayce with Q at *7* lands here. Still caught by arithmetic against the
   *  champion's own ddragon-published data, never by a champion blocklist. */
  | "non-standard-kit"
  /** The champion's rank rules could not be resolved AND this champion is
   *  known to be off the standard model, so assuming 5/5/5/3 would produce
   *  confidently wrong advice. Distinct from `no-model`: we HAVE a recommended
   *  order, we just cannot safely interpret it. See SkillOrderModel.kit. */
  | "unknown-kit"
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
   *  ranked. This is REAL, not theoretical: seven popular champions (JINX,
   *  ZED, KASSADIN, SIVIR, CORKI, ZERI, QIYANA) publish R at level *12*,
   *  because the published order is a per-level MODAL AGGREGATE across many
   *  games rather than one legal path — see skillOrderModel.ts's "Why there is
   *  NO ultimate-level legality check". That aggregate is fine for the rank
   *  COUNTS the completion derives from; it is NOT fine as a live instruction,
   *  so it is refused here instead.
   *
   *  Legality is now read off the champion's OWN schedule rather than a
   *  6/11/16 constant, so Karma's level-1 R and Udyr's level-2 R are allowed
   *  while a genuinely illegal rank is still refused. */
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

/**
 * Total ability points SPENT. The passive cannot appear here — RANKABLE is the
 * closed set of the four rankable slots, so there is no path by which a
 * passive's (non-existent) level could be added in.
 *
 * Ranks the game GRANTS are excluded, because they were never bought. Only
 * form-swap kits have any: Jayce's Transform, and the first Mantra/Spider
 * Form/Cougar Form rank of Karma/Elise/Nidalee. Getting this wrong is not a
 * rounding error — `unspent = level − spent`, so counting a granted rank as
 * spent hides exactly one point at every level of the game, and the panel
 * shows nothing from level 1 to level 18.
 *
 * Defaults to STANDARD_KIT (no free ranks), which is identical to this
 * function's previous unconditional behaviour.
 */
export function pointsSpent(ranks: AbilityRanks, kit: ChampionKit = STANDARD_KIT): number {
  return RANKABLE.reduce((sum, a) => sum + purchasedRanks(ranks[a], a, kit), 0);
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

  // ── Whose rules are we applying? ─────────────────────────────────────────
  // `undefined` means no kit travelled with this model (a response cached
  // before the field existed, or a hand-built fixture) — assume the standard
  // model, which is exactly what this function did unconditionally before.
  // `null` means resolution FAILED for a champion known to be non-standard;
  // assuming 5/5/5/3 there is precisely the wrong answer that blanked Jayce,
  // so refuse instead. See SkillOrderModel.kit.
  if (model.kit === null) return none("unknown-kit");
  const kit = model.kit ?? STANDARD_KIT;

  // ── Input validation. The wire format has never been observed here; treat
  // every field as untrusted (see this file's header). ──────────────────────
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) return none("bad-level");

  if (!ranks || typeof ranks !== "object") return none("bad-ranks");
  for (const a of RANKABLE) {
    if (!isNonNegativeInt(ranks[a])) return none("bad-ranks");
  }

  const spent = pointsSpent(ranks, kit);
  if (spent > TOTAL_LEVELS) return none("bad-ranks");

  // Incoherent-reading detection, by arithmetic on the champion's OWN
  // published caps rather than a name list that would rot on the next rework.
  // A Jayce Q at 6 and a Karma R at 4 are ordinary and pass; a rank the game
  // could never have granted lands here.
  for (const a of RANKABLE) {
    if (ranks[a] > kit.maxRanks[a]) return none("non-standard-kit");
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
  if (fromRank >= kit.maxRanks[ability]) return none("capped-ability");

  // Ultimate legality — the modal-aggregate check. See the doc comment above
  // and NextSkillRefusal's "ultimate-illegal" note.
  //
  // THE RULE, stated explicitly rather than buried (it is derived from
  // ddragon's `maxrank`, so nothing here names a champion — see
  // lib/championKit.ts's ULTIMATE_SEMANTICS table):
  //   R maxrank 3  → a true ultimate; ranks legal at levels 6 / 11 / 16.
  //   R maxrank 4  → a level-1 form-swap ultimate; legal at 1 / 6 / 11 / 16.
  //   R maxrank 1  → a single-rank transform; legal at level 1.
  //   R maxrank 6  → not an ultimate at all, a fourth basic; NEVER gated.
  //
  // `isUltimateRankLegal` also bounds the index before comparing: an
  // out-of-range rank would otherwise read `undefined` and compare false, i.e.
  // silently APPROVE. Bounds first, then compare.
  if (ability === "R" && !isUltimateRankLegal(toRank, level, kit)) {
    return none("ultimate-illegal");
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
