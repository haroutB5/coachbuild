// ─────────────────────────────────────────────────────────────────────────────
// scenarios.ts -- the enemy composition, classified. Five champion ids visible
// in champ select in; a set of named scenarios plus the evidence that produced
// them, out.
//
// It replaces lib/enemyComp/compSignal.ts, which classified the same comp on
// two axes (heavy CC, and a decisive AD/AP lean) in order to PERMUTE the
// Situational row. That row is no longer comp-driven at all -- see the
// "For this game" plan, decision 5: two comp-driven opinions inside one item
// set cannot be reconciled by the reader, and the promotion was measured to
// only relabel (rather than reorder) in 58.2% of its fires. What survives from
// that module is its posture, and all three of its refusals.
//
// WHERE EACH AXIS COMES FROM, and why two of them are not re-curated here:
//
//   cc          lib/draft/compRatings.ts, aggregated, cut at compTakeaways'
//               own CC_HEAVY_FLOOR. The draft page's "Heavy CC" chip and this
//               block's Mercury's Treads mean the same thing about the same
//               comp because they are literally the same number and the same
//               constant.
//   tankiness   lib/draft/compRatings.ts, per enemy, cut at TANK_FLOOR = 3 --
//               the top band of that file's own published rubric.
//   damage      lib/enemyComp/damageType.ts, unchanged.
//   assassin    \
//   heal         >  lib/enemyComp/kitAxes.ts -- the three axes nothing else
//   shield      /   carries. See that file's header for why they cannot be
//                   derived from what already exists.
//
// PURE. No React, no fetch, no wall clock. Every input is a champion id visible
// in champ select before the game starts; nothing here reads, infers or uses
// anything about what enemies buy DURING a game.
// ─────────────────────────────────────────────────────────────────────────────

import { aggregateEnemyComp, getCompRating } from "@/lib/draft/compRatings";
import { CC_HEAVY_FLOOR } from "@/lib/draft/compTakeaways";
import { getDamageType } from "@/lib/enemyComp/damageType";
import { countAtOrAbove } from "@/lib/enemyComp/kitAxes";
import { normalizeDraftEnemyIds, MAX_DRAFT_ENEMIES } from "@/components/live/draftLiveSync";

export { CC_HEAVY_FLOOR };

/**
 * A FULL enemy comp is required. Five, not three.
 *
 * The phase-1 signal fired from three enemies because it only ever permuted a
 * row that already existed: being wrong cost an ordering. This block is a
 * BUILD, titled "For this game", and a build named after a game that has not
 * finished drafting is a claim about a comp that does not exist yet. The two
 * remaining enemies can add the second healer, the second tank or the third AP
 * champion, each of which changes the answer outright.
 *
 * It also makes the content rule and the TIMING rule (components/live/
 * compFinalization.ts) agree by construction rather than by coincidence: the
 * block exists exactly when the comp is complete, which is exactly when the one
 * permitted overwrite fires.
 */
export const MIN_ENEMIES_FOR_PLAN = MAX_DRAFT_ENEMIES;

/** The `tankiness` level at which an enemy counts as a tank.
 *
 *  3, which is compRatings.ts's own published rubric band for "defining: this
 *  axis is core to the champion's identity". Not a tuned number and not a
 *  magic one -- it is that file's own word for the population whose entire
 *  identity is resistances, which is exactly the population penetration
 *  answers. At 2 the set would admit Aatrox, Renekton and Volibear, who buy
 *  damage and die to it. */
export const TANK_FLOOR = 3;

/** The damage rule needs a clear majority AND near-unanimity. A 3-2 split is
 *  not a finding, especially when the underlying per-champion read is editorial
 *  (see damageType.ts). Carried over verbatim from compSignal.ts, which used
 *  the same two numbers for the same reason. */
export const DAMAGE_MIN_LEAN = 3;
export const DAMAGE_MAX_DISSENT = 1;

/**
 * The scenarios one comp can present. COMBINABLE -- a comp is routinely two or
 * three of these at once, and the priority in SCENARIO_PRIORITY is what decides
 * which ones reach the two item slots.
 *
 * `mixed` is deliberately NOT a member. "The enemy deals both kinds of damage"
 * is the residual of the two damage scenarios rather than a finding, and there
 * is no item that answers it which a defensive boot does not already answer
 * better. It is reported on the evidence (`damageLean: "mixed"`) so a surface
 * can say it out loud, and it names nothing.
 */
export type CompScenario =
  | "healers"
  | "shielders"
  | "tanks"
  | "heavy-cc"
  | "heavy-ap"
  | "heavy-ad"
  | "assassins";

/**
 * The ONE priority order, walked once. Two budgets are spent against it (see
 * scenarioItems.ts): a boots channel of 1 and an item channel of 2. A candidate
 * whose channel is full is skipped and the walk continues, which is what lets
 * `heavy-cc` still take Mercury's Treads after `healers` and `tanks` have taken
 * both item slots -- without needing a second, separately-maintained order for
 * boots.
 *
 * 1. `healers`   -- anti-heal is the only class of item with no substitute. A
 *                   build without it does not out-damage a two-healer comp by
 *                   buying something else; it loses that exchange by
 *                   construction.
 * 2. `tanks`     -- penetration, on the same argument: nothing else recovers
 *                   the damage that resistances remove.
 * 3. `heavy-cc`  -- the more specific claim about the comp, and it costs only
 *                   the boots slot. This is the SAME precedence the shipped
 *                   resolveCompSignal used ("cc is checked first ... both
 *                   promote the same boot"), preserved deliberately so the
 *                   ordering does not silently invert across the rewrite.
 * 4. `heavy-ap`  \  Mutually exclusive by construction (DAMAGE_MAX_DISSENT
 * 5. `heavy-ad`  /  makes both impossible), so their relative order can never
 *                   be observed. Adjacent, and arbitrary between themselves.
 * 6. `assassins` -- a survivability item, competing for the same slot as 4/5 on
 *                   a narrower claim: 2 enemies rather than 3.
 * 7. `shielders` -- narrowest. Serpent's Fang applies to two classes and to no
 *                   one else, so it is the one most willing to lose its slot.
 */
export const SCENARIO_PRIORITY: readonly CompScenario[] = [
  "healers",
  "tanks",
  "heavy-cc",
  "heavy-ap",
  "heavy-ad",
  "assassins",
  "shielders",
];

/** Everything the classification looked at, so a surface can state its reason
 *  with the number attached instead of asserting a category. */
export interface CompEvidence {
  /** How many enemies survived normalisation and were actually classified. */
  enemiesConsidered: number;
  /** How many of those resolved through compRatings' estimated fallback rather
   *  than a curated row. */
  estimatedCount: number;
  /** The aggregate cc axis, 0-3. */
  ccMean: number;
  tankCount: number;
  assassinCount: number;
  healerCount: number;
  shielderCount: number;
  adCount: number;
  apCount: number;
  /** `mixed` when neither damage scenario fired -- an honest answer, not a
   *  failure, and the only place the word appears. */
  damageLean: "ad" | "ap" | "mixed";
}

export interface CompClassification {
  /** In SCENARIO_PRIORITY order, so a consumer never has to re-sort. */
  scenarios: CompScenario[];
  evidence: CompEvidence;
}

/**
 * Classify one enemy comp, or null when it cannot honestly be classified.
 *
 * THREE REFUSALS, all carried over from compSignal.ts:
 *   1. Fewer than MIN_ENEMIES_FOR_PLAN resolved enemies -- see that constant.
 *   2. More than half the comp resolving through compRatings' tag-derived
 *      fallback. A comp we are mostly guessing at has a cc axis we are mostly
 *      guessing at. Strictly more than half, so 2 of 5 estimated still
 *      classifies and 3 of 5 does not.
 *   3. (in the caller) no candidate item for the resolved class -- an empty
 *      plan is not a block.
 *
 * Null is not a failure. It means the export ships exactly as it does without
 * this feature, byte identical.
 */
export function classifyEnemyComp(enemyChampionIds: readonly number[]): CompClassification | null {
  // Normalisation is draftLiveSync's, not a second copy: dedupe, drop
  // non-positive, cap at five. Two implementations of "what counts as an enemy
  // list" is how the draft page and the exporter would come to disagree about
  // the same champ select.
  const enemies = normalizeDraftEnemyIds(enemyChampionIds);
  if (enemies.length < MIN_ENEMIES_FOR_PLAN) return null;

  const agg = aggregateEnemyComp(enemies);
  if (agg.estimatedCount * 2 > enemies.length) return null;

  const types = enemies.map(getDamageType);
  const adCount = types.filter((t) => t === "ad").length;
  const apCount = types.filter((t) => t === "ap").length;

  const tankCount = enemies.filter((id) => getCompRating(id).tankiness >= TANK_FLOOR).length;
  const assassinCount = countAtOrAbove(enemies, "assassin");
  const healerCount = countAtOrAbove(enemies, "heal");
  const shielderCount = countAtOrAbove(enemies, "shield");

  const heavyAd = adCount >= DAMAGE_MIN_LEAN && apCount <= DAMAGE_MAX_DISSENT;
  const heavyAp = apCount >= DAMAGE_MIN_LEAN && adCount <= DAMAGE_MAX_DISSENT;

  const fired: Record<CompScenario, boolean> = {
    healers: healerCount >= 2,
    tanks: tankCount >= 2,
    "heavy-cc": agg.cc >= CC_HEAVY_FLOOR,
    "heavy-ap": heavyAp,
    "heavy-ad": heavyAd,
    assassins: assassinCount >= 2,
    shielders: shielderCount >= 2,
  };

  return {
    scenarios: SCENARIO_PRIORITY.filter((s) => fired[s]),
    evidence: {
      enemiesConsidered: enemies.length,
      estimatedCount: agg.estimatedCount,
      ccMean: agg.cc,
      tankCount,
      assassinCount,
      healerCount,
      shielderCount,
      adCount,
      apCount,
      damageLean: heavyAd ? "ad" : heavyAp ? "ap" : "mixed",
    },
  };
}

/** The reason a scenario names, with its own number in it, for the wire caption
 *  and the Builds-page card. Written HERE rather than at the two surfaces so
 *  the shop's `companion.log` line and the page's card cannot say different
 *  things about the same swap -- the same "one derivation, two consumers" rule
 *  the situational wire already follows. */
export function scenarioReason(scenario: CompScenario, e: CompEvidence): string {
  switch (scenario) {
    case "healers":
      return `${e.healerCount} healers`;
    case "shielders":
      return `${e.shielderCount} shielders`;
    case "tanks":
      return `${e.tankCount} tanks`;
    case "assassins":
      return `${e.assassinCount} assassins`;
    case "heavy-cc":
      return `heavy CC (${e.ccMean.toFixed(1)})`;
    case "heavy-ap":
      return `${e.apCount} AP`;
    case "heavy-ad":
      return `${e.adCount} AD`;
  }
}
