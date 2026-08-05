// ─────────────────────────────────────────────────────────────────────────────
// championKit.ts — per-champion ability-rank RULES, derived from Data Dragon.
//
// PURE. No fetch, no clock, no I/O. lib/staticData.ts owns the network half
// (see resolveChampionKit there) and hands the four raw `maxrank` integers in
// here; this module owns every judgement about what those integers MEAN.
//
// ── Why this file exists ────────────────────────────────────────────────────
// League's 5/5/5/3 rank model used to be hardcoded across skillOrderModel.ts
// and nextSkill.ts. It is wrong for seven champions, and a real user played
// one of them (Jayce) and got a permanently blank in-game overlay. Refusing
// them was defensible while the caps were a guess; it is not defensible now
// that Riot publishes the real caps per champion, for free, on a CDN this repo
// already talks to.
//
// ── MEASURED, not assumed: full-roster sweep, ddragon 16.14.1, 2026-07-27 ───
// `championFull.json` (one request, all champions) → `spells[i].maxrank`,
// i = 0..3 = Q,W,E,R. Result: 173 champions, EVERY ONE with exactly 4 spells
// (no ragged-array case exists to defend against), and exactly SEVEN off the
// 5/5/5/3 model:
//
//     Aphelios  6/6/6/3      Udyr   6/6/6/6
//     Elise     5/5/5/4      Yuumi  6/5/5/3
//     Jayce     6/6/6/1
//     Karma     5/5/5/4
//     Nidalee   5/5/5/4
//
// ── The R slot carries SEMANTICS, and `maxrank` is what reveals them ────────
// The R slot is not always an ultimate. Reading it as one is what made the
// old ULTIMATE_LEVELS = [6,11,16] constant a live correctness hazard: it is
// simply false for four of the seven above, and this is the module that tells
// a player which key to press DURING a game.
//
// Two facts are needed per champion, and BOTH are derivable from R's maxrank:
//
//   (1) WHEN each R rank becomes legal (the `ultimateLevels` schedule), and
//   (2) whether R's first rank costs a skill point (`freeRanks`).
//
// Fact (2) is the one that is easy to miss and expensive to get wrong: an
// ability granted at level 1 for free is NOT a spent point, and the whole
// feature rests on `unspent = level − Σ(points spent)`. Counting a free rank
// as spent makes the answer off-by-one FOR THE ENTIRE GAME.
//
// ── EVIDENCE for the mapping below (this is an inference; here is its basis) ─
// A champion has exactly 18 ability points (one per level, TOTAL_LEVELS). So
// Σ(purchasable ranks) should equal 18 for any champion who can spend every
// point without waste. Testing that identity across all 173 champions:
//
//   * Reading every rank as purchasable  →  only 166 champions total 18; the
//     seven above total 19/19/19/19/19/21/24. Jayce is the reductio: his
//     basics alone total 6+6+6 = 18, leaving literally no point for R, yet
//     ddragon says R has a rank. Under this reading he is unplayable.
//
//   * Treating R's first rank as FREE exactly when R.maxrank is 1 or 4  →
//     170 of 173 total exactly 18. The only three that do not are Yuumi (19),
//     Aphelios (21) and Udyr (24) — and those three are precisely the
//     champions who genuinely CANNOT max everything and must choose what to
//     skip. That is a real property of their kits, not a modelling failure.
//
// Corroborated independently against the upstream op.gg orders (probed live,
// 2026-07-27), which publish where points are actually SPENT:
//   * Jayce's published 15 levels contain NO R at all (Q6 W6 E3) — consistent
//     with his Transform costing nothing and being granted at level 1.
//   * Karma/Elise/Nidalee publish R at levels 6 and 11 ONLY, never at level 1,
//     even though all three have R available from level 1. A modal aggregate
//     over many games would show a level-1 R if it cost a point.
//   * Their remainders then complete to exactly 3 (R×1 at 16 + 2 basics) — the
//     identical arithmetic that already works for all 160 standard champions.
//
// A NOTE ON A TRAP: CommunityDragon's per-spell `cost` field reads "No Cost"
// for Jayce/Karma/Elise/Nidalee's R, which looks like a ready-made signal for
// fact (2). It is NOT — that field is the MANA cost, and it also reads
// "No Cost" for Yuumi's W and Aphelios's W, both of which very much do consume
// a skill point. It was checked and deliberately rejected as a source.
//
// ── What happens to a shape we have not seen ────────────────────────────────
// `kitFromMaxRanks` returns null for any R maxrank outside {1,3,4,6}. Null
// propagates to a refusal, never to a guess. That is the same posture as the
// rest of this feature: a missing recommendation is fine, a wrong one is not.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ability, ChampionKit } from "./types";

export type { ChampionKit };

/** The four rankable slots in Riot's canonical order. Index i here is index i
 *  of ddragon's `spells` array — that positional correspondence is the entire
 *  contract with the CDN, so it is named rather than left implicit. */
export const SPELL_SLOTS: readonly Ability[] = ["Q", "W", "E", "R"] as const;

/** Total ability points in a game — one per level. Also, necessarily, the
 *  number of purchasable ranks a champion who wastes nothing must have. */
export const TOTAL_LEVELS = 18;

/** The levels at which a TRUE ultimate (R with three ranks) may be ranked.
 *  Retained as the canonical schedule the table below is built from. */
export const ULTIMATE_LEVELS: readonly number[] = [6, 11, 16] as const;

/**
 * R-slot semantics keyed on R's own `maxrank`.
 *
 * `levels[n-1]` is the minimum champion level at which R's nth rank is legal,
 * counting free ranks. `null` means the slot is not level-gated at all.
 * `free` is how many of R's ranks are granted without spending a point.
 *
 * Nothing here names a champion: a rework that changes a maxrank is picked up
 * automatically on the next ddragon fetch rather than silently drifting.
 */
const ULTIMATE_SEMANTICS: Record<
  number,
  { levels: readonly number[] | null; free: number }
> = {
  // Single-rank transform/stance (Jayce). Granted at level 1, never ranked
  // again, costs nothing — his 6+6+6 basics already consume all 18 points.
  1: { levels: [1], free: 1 },
  // True ultimate. The standard case, 166 champions plus Aphelios and Yuumi.
  3: { levels: ULTIMATE_LEVELS, free: 0 },
  // Level-1 form-swap ultimate (Elise, Karma, Nidalee). Rank 1 is free at
  // level 1; ranks 2-4 are bought on the ordinary ultimate cadence.
  4: { levels: [1, ...ULTIMATE_LEVELS], free: 1 },
  // Not an ultimate at all — a fourth basic-like ability (Udyr). No level
  // gate whatsoever; his "R" is legitimately ranked at level 2.
  6: { levels: null, free: 0 },
};

const ZERO_FREE: Readonly<Record<Ability, number>> = Object.freeze({ Q: 0, W: 0, E: 0, R: 0 });

/**
 * Build a ChampionKit from ddragon's four `maxrank` values, in Q,W,E,R order.
 * `championKey` is optional for the old cap-only callers; the ddragon boundary
 * supplies it so the recorded Aphelios path can distinguish its serialized
 * automatic R from an ordinary R3 ultimate.
 *
 * Returns null — never a guess — when the values are not integers ≥ 1, when
 * there are not exactly four of them, or when R's maxrank is a shape this
 * module has no verified semantics for. A null kit refuses downstream.
 */
export function kitFromMaxRanks(maxranks: readonly number[], championKey?: string): ChampionKit | null {
  if (!Array.isArray(maxranks) || maxranks.length !== SPELL_SLOTS.length) return null;
  if (!maxranks.every((n) => Number.isInteger(n) && n >= 1)) return null;

  const semantics = ULTIMATE_SEMANTICS[maxranks[3]];
  if (!semantics) return null;

  const maxRanks = Object.freeze({
    Q: maxranks[0],
    W: maxranks[1],
    E: maxranks[2],
    R: maxranks[3],
  }) as Readonly<Record<Ability, number>>;

  const freeRanks = Object.freeze({ ...ZERO_FREE, R: semantics.free }) as Readonly<
    Record<Ability, number>
  >;

  const purchasableTotal =
    maxRanks.Q + maxRanks.W + maxRanks.E + (maxRanks.R - semantics.free);

  return Object.freeze({
    maxRanks,
    freeRanks,
    ultimateLevels: semantics.levels === null ? null : Object.freeze([...semantics.levels]),
    purchasableTotal,
    // R maxrank alone cannot distinguish standard champions from Aphelios:
    // both are 6/6/6/3, but live Riot timelines serialize Aphelios's automatic
    // R as a zero-cost SKILL_LEVEL_UP marker. Identity is therefore threaded
    // through the existing ddragon boundary rather than guessed downstream.
    rAuto: maxranks[3] === 1 || championKey?.toLowerCase() === "aphelios",
  });
}

/** League's standard model — 5/5/5/3, no free ranks, ultimate at 6/11/16.
 *  Correct for 166 of 173 champions, and the documented fallback whenever a
 *  champion's real caps could not be resolved AND we have no reason to
 *  believe that champion is non-standard (see resolveChampionKit). */
export const STANDARD_KIT: ChampionKit = kitFromMaxRanks([5, 5, 5, 3])!;

/**
 * Riot numeric ids of every champion measured to be OFF the 5/5/5/3 model
 * (ddragon 16.14.1, full-roster sweep, 2026-07-27).
 *
 * ── Read what this list does and does not claim ─────────────────────────────
 * It carries IDENTITY ONLY — "this champion is not standard" — never cap
 * VALUES. That is deliberate. A parallel table of caps is exactly the thing
 * this repo has been bitten by before (gotcha (y): curated item ids rotting
 * silently every patch), and lib/opgg.ts refuses to ship a second champion
 * table for the same reason. A table of values that goes stale would produce
 * confidently wrong in-game advice; a list of names that goes stale produces,
 * at worst, the behaviour we already ship today.
 *
 * It is consulted ONLY on the degraded path where ddragon could not be
 * reached. There, falling back to 5/5/5/3 for a champion on this list would
 * hand a Jayce player an off-by-one recommendation for the whole game, so we
 * refuse instead; every other champion gets STANDARD_KIT, which is what the
 * app already assumed for all of them before this change.
 *
 * If it rots: a newly non-standard champion simply is not on it, and gets
 * STANDARD_KIT on the ddragon-down path — i.e. exactly today's exposure, not
 * a new one. The happy path never reads this list at all.
 */
export const KNOWN_NON_STANDARD_CHAMPION_IDS: ReadonlySet<number> = new Set([
  523, // Aphelios  6/6/6/3
  60, //  Elise     5/5/5/4
  126, // Jayce     6/6/6/1
  43, //  Karma     5/5/5/4
  76, //  Nidalee   5/5/5/4
  77, //  Udyr      6/6/6/6
  350, // Yuumi     6/5/5/3
]);

/** Ranks that actually cost a skill point. The free level-1 form-swap rank of
 *  a Jayce/Karma/Elise/Nidalee is excluded, because it was never spent.
 *  Clamped at 0 so a live reading below the free allowance (impossible in a
 *  real game, but this is untrusted wire data) cannot produce a negative. */
export function purchasedRanks(rank: number, ability: Ability, kit: ChampionKit): number {
  return Math.max(0, rank - kit.freeRanks[ability]);
}

/** Purchasable ranks in the R slot — total maxrank less any free ranks.
 *  0 for Jayce, 3 for a standard ultimate AND for Karma/Elise/Nidalee. */
export function purchasableUltimateRanks(kit: ChampionKit): number {
  return kit.maxRanks.R - kit.freeRanks.R;
}

/**
 * How many ultimate ranks must land in the DERIVED tail (levels 16-18).
 *
 * Derived from the champion's own legality schedule rather than assumed: the
 * count of its ultimate levels that fall past what the source publishes.
 * For every gated shape that is exactly one (level 16); for Jayce it is zero,
 * which is why his tail is three basics and completes cleanly.
 */
export function tailUltimateRanks(kit: ChampionKit, sourceLevels: number): number {
  if (kit.ultimateLevels === null) return 0;
  return kit.ultimateLevels.filter((lvl) => lvl > sourceLevels).length;
}

/**
 * Is a given R rank legal at a given champion level?
 *
 * `rank` counts free ranks (it is the rank the game would report). An
 * ungated slot (Udyr) is always legal; a rank past the schedule never is.
 */
export function isUltimateRankLegal(rank: number, level: number, kit: ChampionKit): boolean {
  if (kit.ultimateLevels === null) return true;
  if (rank < 1 || rank > kit.ultimateLevels.length) return false;
  return level >= kit.ultimateLevels[rank - 1];
}
