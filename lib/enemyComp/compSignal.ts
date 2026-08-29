// ---------------------------------------------------------------------------
// compSignal.ts -- the enemy-composition signal: five champion ids seen in
// champ select, in; at most one PROMOTION inside the champion's own
// situational pool, out.
//
// It replaces components/live/compHighlight.ts, which was this feature's first
// attempt and shipped structurally dead. That module gated on
// `Pick.matchupConditioned`, which is only ever set when
// `BuildResponse.matchup.supported` is true, which needs the coachless
// `matchupChampionIds` filter, which 403s on every endpoint (lib/coachless.ts,
// lib/recommend.ts's probe). It therefore returned `[]` on every call in
// production, forever, with its consumer chain fully wired and no test able to
// tell. Its header refused a heuristic on the ground that "this repo has NO
// per-champion damage-type/tag classification anywhere"; that premise expired
// when ChampionRef gained `tags` (v0.42.0) and lib/draft/compRatings.ts landed.
// The PRINCIPLE in that header stands and this module keeps it: never invent a
// recommendation. See `promotedIds` for the structural form of that promise.
//
// WHAT THIS IS ALLOWED TO DO, exactly one thing: move an item that is ALREADY
// in the champion's own `items.alts` to the front of the situational row, and
// say why. It cannot add an item, cannot remove one, and cannot change any
// number. That is the same content-preserving contract RC-5b established for
// positional priors ("a prior may PERMUTE a block, never re-select it"),
// applied to a non-positional one.
//
// WHY ONLY BOOTS, measured 2026-08-29 across 24 production champion-roles:
//   * the situational pool is 2 to 9 items (median 6) against a display cap of
//     6, so for 22 of 24 the visible window IS the whole pool. There is nothing
//     to reselect; only order can move.
//   * an anti-heal item is reachable anywhere in a champion's own data for
//     only 9 of 24, and for 0 of the 4 AP champions sampled. Promoting one
//     where it does not exist would mean inventing it. User decision
//     2026-08-29: anti-heal stays out of the shop set entirely.
//   * a magic-resist boot is reachable for 17 of 24 and an armour boot for 16,
//     and the WPA gap to the model's own pick is frequently inside noise
//     (Malphite 0.02, Yasuo 0.09, Thresh 0.11). That is a swap whose cost is
//     small, real, and printable.
//
// PURE. No React, no fetch, no wall clock. Every input is a champion id
// visible in champ select before the game starts; nothing here reads, infers
// or uses anything about what enemies buy DURING a game.
// ---------------------------------------------------------------------------

import type { ItemsBlock, Pick as PickType } from "@/lib/types";
import { aggregateEnemyComp } from "@/lib/draft/compRatings";
import { CC_HEAVY_FLOOR } from "@/lib/draft/compTakeaways";
import { getDamageType } from "@/lib/enemyComp/damageType";
import { ARMOR_BOOTS, MAGIC_RESIST_BOOTS } from "@/lib/enemyComp/counterItems";
import { flattenSituational } from "@/components/hextech/situational";
import { normalizeDraftEnemyIds } from "@/components/live/draftLiveSync";

export { CC_HEAVY_FLOOR };

/** Below this many RESOLVED enemies, no rule fires at all.
 *
 *  Three, not one or two, and the reason is cost rather than statistics: every
 *  comp-driven export is a whole-document PUT to the LCU (the real file
 *  measured 61,060 bytes across 62 sets and the write is all-or-nothing), and
 *  two enemies is one hover away from a coin flip. A step, deliberately, not a
 *  confidence ramp: a rule that fires weakly on two enemies and strongly on
 *  four is a rule whose label means something different each time. */
export const MIN_ENEMIES_FOR_SIGNAL = 3;

/** The most WPA a promotion may cost against the boot the model actually
 *  picked, before the rule refuses.
 *
 *  PROVISIONAL, and flagged as such on purpose. It is calibrated against 24
 *  champion-roles, which is enough to show it discriminates (it accepts
 *  Malphite 0.02, Yasuo 0.09, Thresh 0.11, Urgot 0.87 and refuses Viktor 3.20
 *  and Ahri 1.72) and not enough to defend the exact number. Phase 3 replaces
 *  it with a sweep of the gap distribution over all 323 exportable combos.
 *  Until then this is a JUDGMENT call and the handoff says so. */
export const MAX_WPA_COST = 1.0;

/** Which rule fired. Ordered by priority: `cc` is checked first because it is
 *  the more specific claim, and because both it and `damage-ap` promote the
 *  same boot, so without an order the reported reason would be arbitrary. */
export type CompRule = "cc" | "damage-ad" | "damage-ap";

export interface CompSignalEvidence {
  /** How many enemies survived normalisation and were actually aggregated. */
  enemiesConsidered: number;
  /** How many of those resolved through compRatings' estimated fallback
   *  rather than a curated row. Surfaced so a caller can footnote it, the way
   *  the draft comp bars already do. */
  estimatedCount: number;
  /** Present when the CC rule was evaluated. The aggregate cc axis, 0 to 3. */
  ccMean?: number;
  /** Present when the damage rule was evaluated. */
  adCount?: number;
  apCount?: number;
}

export interface CompSignal {
  rule: CompRule;
  /**
   * Ids to move to the head of the situational row, in priority order.
   *
   * GUARANTEED to be a SUBSET of the pool that was passed in. That is the
   * structural form of "never invent a recommendation": this function selects
   * from the champion's own measured alternatives and has no other source of
   * ids. A test asserts the subset property across every fixture and comp, and
   * a second asserts no anti-heal id can ever appear here.
   */
  promotedIds: number[];
  /** Short title suffix for the shop block, e.g. `vs CC`. Block name first and
   *  suffix short, because the client renders set titles in a narrow column. */
  labelSuffix: string;
  /** What the promotion costs against the boot the model picked, in WPA.
   *  Positive means the promoted item is worse than the model's own choice by
   *  this much. Always at or under MAX_WPA_COST when a signal is returned. */
  wpaCost: number;
  evidence: CompSignalEvidence;
}

const LABEL: Record<CompRule, string> = {
  cc: "vs CC",
  "damage-ad": "vs AD",
  "damage-ap": "vs AP",
};

/** The damage rule needs a clear majority AND near-unanimity. A 3-2 split is
 *  not a finding, especially when the underlying per-champion read is
 *  editorial (see damageType.ts). */
const DAMAGE_MIN_LEAN = 3;
const DAMAGE_MAX_DISSENT = 1;

/** First item in `pool` belonging to `wanted`, or null. Order matters: the
 *  pool arrives WPA-descending, so this picks the best available member of the
 *  class rather than the lowest id. */
function firstOfClass(pool: readonly PickType[], wanted: ReadonlySet<number>): PickType | null {
  for (const pick of pool) if (wanted.has(pick.id)) return pick;
  return null;
}

/**
 * Resolve the enemy-comp signal for one champion's build, or null when no rule
 * fires.
 *
 * Null is the overwhelmingly common answer and it is not a failure: it means
 * the block ships exactly as it does today, bare title, WPA order, byte
 * identical. Every degradation path below returns it.
 */
export function resolveCompSignal(
  enemyChampionIds: readonly number[],
  items: ItemsBlock
): CompSignal | null {
  // Normalisation is draftLiveSync's, not a second copy: dedupe, drop
  // non-positive, cap at five. Two implementations of "what counts as an enemy
  // list" is how the draft page and the exporter would come to disagree about
  // the same champ select.
  const enemies = normalizeDraftEnemyIds(enemyChampionIds);
  if (enemies.length < MIN_ENEMIES_FOR_SIGNAL) return null;

  const agg = aggregateEnemyComp(enemies);
  // A comp resolved mostly through the tag-derived fallback is a comp we are
  // mostly guessing at, and its cc axis is a guess too. Refuse rather than
  // label a block on it. Strictly more than half, so 2 of 5 estimated still
  // fires and 3 of 5 does not.
  if (agg.estimatedCount * 2 > enemies.length) return null;

  // The pool is the champion's own ranked alternatives, WPA-descending, from
  // the ONE helper both situational surfaces already call. Nothing else is a
  // legal source of ids.
  const pool = flattenSituational(items);
  if (pool.length === 0) return null;

  const modelBoots = items.boots;
  const evidence: CompSignalEvidence = {
    enemiesConsidered: enemies.length,
    estimatedCount: agg.estimatedCount,
  };

  // -- Rule 1: heavy CC -> a tenacity/magic-resist boot ----------------------
  // CC_HEAVY_FLOOR is compTakeaways' own constant, not a second number that
  // happens to be 2.2 today. The draft page saying "Heavy CC" and the shop
  // promoting a tenacity boot must mean the same thing about the same comp.
  evidence.ccMean = agg.cc;
  if (agg.cc >= CC_HEAVY_FLOOR) {
    const hit = tryPromote(pool, MAGIC_RESIST_BOOTS, modelBoots);
    if (hit) return { rule: "cc", labelSuffix: LABEL.cc, ...hit, evidence };
  }

  // -- Rule 2: a decisive damage-type lean -> the matching defensive boot ----
  const types = enemies.map(getDamageType);
  const adCount = types.filter((t) => t === "ad").length;
  const apCount = types.filter((t) => t === "ap").length;
  evidence.adCount = adCount;
  evidence.apCount = apCount;

  if (adCount >= DAMAGE_MIN_LEAN && apCount <= DAMAGE_MAX_DISSENT) {
    const hit = tryPromote(pool, ARMOR_BOOTS, modelBoots);
    if (hit) return { rule: "damage-ad", labelSuffix: LABEL["damage-ad"], ...hit, evidence };
  }
  if (apCount >= DAMAGE_MIN_LEAN && adCount <= DAMAGE_MAX_DISSENT) {
    const hit = tryPromote(pool, MAGIC_RESIST_BOOTS, modelBoots);
    if (hit) return { rule: "damage-ap", labelSuffix: LABEL["damage-ap"], ...hit, evidence };
  }

  return null;
}

/** The two gates every rule shares, in one place so they cannot drift apart:
 *  the item must EXIST in the champion's own pool, and taking it must not cost
 *  more than MAX_WPA_COST against the boot the model actually chose.
 *
 *  The cost is measured against `items.boots` and not against the head of the
 *  pool, because that is the decision the player is really making: the
 *  situational row is a swap menu, and what a swap costs is the difference
 *  from the build's own pick. `alts.boots` never contains the chosen boot by
 *  construction (measured: 0 collisions across all 323 live combos), so the
 *  two are always genuinely different items. */
function tryPromote(
  pool: readonly PickType[],
  wanted: ReadonlySet<number>,
  modelBoots: PickType
): { promotedIds: number[]; wpaCost: number } | null {
  const pick = firstOfClass(pool, wanted);
  if (!pick) return null;
  const wpaCost = modelBoots.wpa - pick.wpa;
  if (wpaCost > MAX_WPA_COST) return null;
  return { promotedIds: [pick.id], wpaCost };
}
