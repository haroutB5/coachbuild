// ─────────────────────────────────────────────────────────────────────────────
// scenarioItems.ts -- the curated per-class table of "this comp -> buy this",
// and the selection rule that walks it.
//
// EVERY ID IS PINNED IN SOURCE and verified against a captured 16.17.1
// catalogue by lib/__tests__/enemyComp-scenarioItems.test.ts, which asserts each
// id exists, is a real Summoner's Rift purchasable entry (id < 10000,
// maps["11"], gold.purchasable) and -- for the anti-heal entries -- is a member
// of the set scripts/derive-enemycomp-tables.mjs derives from the catalogue's
// own description text. That last check is what turns "Riot renamed the
// keyword" from a silently wrong recommendation into a red build. See
// counterItems.ts's header for the two measured reasons a runtime regex is not
// an option here.
//
// THIS IS A JUDGMENT TABLE AND THE APP SAYS SO. It is editorial League
// knowledge, not a measurement: nothing in this repo measures which item beats
// which comp. Every surface that renders a choice from it carries the JUDGMENT
// label, per the honesty posture in FEATURES.md and HARD RULE 4. What keeps it
// honest rather than merely disclaimed is the selection rule below, which
// PREFERS an item the champion's own /api/build data already offers and only
// falls back to the curated pick when it offers none.
//
// ANTI-HEAL IS NOW IN. The 2026-08-29 decision that "anti-heal never enters the
// exported item set" was made about the SITUATIONAL row, where the standing
// contract is that an item must exist in the champion's own measured pool --
// and it exists there for only 9 of 24 sampled champion-roles, and for 0 of the
// 4 AP champions sampled. That contract does not apply to this block, which is
// explicitly a judgment build rather than a claim about the champion's own
// data, and the user directive of the same day names Morellonomicon as the
// headline case. counterItems.ts's ANTI_HEAL set keeps its negative-control
// duty for the situational path AND now backs the membership assertion above.
//
// EMPTY CELLS ARE REFUSALS, NOT GAPS. Each one is written out in the table
// below with the reason. A table that answered every cell would be inventing
// three or four items.
//
// PURE. No network, no clock, no React.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionItemClass } from "@/lib/enemyComp/championClass";
import type { CompScenario } from "@/lib/enemyComp/scenarios";
import type { DamageType } from "@/lib/enemyComp/damageType";
import { MERCURYS_TREADS, PLATED_STEELCAPS } from "@/lib/enemyComp/counterItems";

/**
 * What one (class, scenario) cell may name. At most ONE boots candidate list
 * and at most ONE item candidate list, because the two channels have separate
 * budgets and a cell that could fill either would make the walk in
 * `selectScenarioPicks` ambiguous.
 *
 * `any` vs `ad`/`ap`: a few cells depend on OUR OWN damage type rather than the
 * enemy's -- a two-tank comp is answered with Serylda's Grudge by Zed and with
 * Void Staff by Akali, and both are "assassin". `any` wins when present. A
 * `mixed`-damage champion (damageType.ts's honest third answer, three champions
 * today) reaches only `any`, and a cell with no `any` therefore names nothing
 * for it -- fail closed rather than guessing which half of its damage matters.
 *
 * Lists are ORDERED by preference and read left to right by the measured-
 * universe rule; see `selectScenarioPicks`.
 */
export interface ScenarioCandidate {
  boots?: readonly number[];
  any?: readonly number[];
  ad?: readonly number[];
  ap?: readonly number[];
}

// Item ids, named once so the table below reads as League rather than as
// numbers, and so a typo is a compile error instead of a wrong item.
const MORELLONOMICON = 3165;
const MORTAL_REMINDER = 3033;
const CHEMPUNK_CHAINSWORD = 6609;
const THORNMAIL = 3075;
const VOID_STAFF = 3135;
const CRYPTBLOOM = 3137;
const LORD_DOMINIKS = 3036;
const SERYLDAS_GRUDGE = 6694;
const BLACK_CLEAVER = 3071;
const BANSHEES_VEIL = 3102;
const KAENIC_ROOKERN = 2504;
const FORCE_OF_NATURE = 4401;
const SPIRIT_VISAGE = 3065;
const WITS_END = 3091;
const MAW_OF_MALMORTIUS = 3156;
const LOCKET_OF_THE_IRON_SOLARI = 3190;
const ZHONYAS_HOURGLASS = 3157;
const DEATHS_DANCE = 6333;
const GUARDIAN_ANGEL = 3026;
const RANDUINS_OMEN = 3143;
const FROZEN_HEART = 3110;
const DEAD_MANS_PLATE = 3742;
const KNIGHTS_VOW = 3109;
const EDGE_OF_NIGHT = 3814;
const STERAKS_GAGE = 3053;
const MIKAELS_BLESSING = 3222;
const SERPENTS_FANG = 6695;

const MERCS = [MERCURYS_TREADS] as const;
const STEELCAPS = [PLATED_STEELCAPS] as const;

/**
 * The table. Rows are the six item classes; columns are the seven scenarios.
 *
 * Boots appear on the three scenarios that have a boots answer and nowhere
 * else, and they are ALWAYS the tier-2 boot rather than its tier-3 enchant: the
 * decision this block is making is "which boot", and an enchant is a later
 * upgrade of whichever boot you took, not a different answer to the comp.
 */
export const CLASS_SCENARIO_ITEMS: Readonly<
  Record<ChampionItemClass, Partial<Record<CompScenario, ScenarioCandidate>>>
> = {
  mage: {
    healers: { any: [MORELLONOMICON] },
    tanks: { any: [VOID_STAFF, CRYPTBLOOM] },
    "heavy-cc": { boots: MERCS },
    "heavy-ap": { boots: MERCS, any: [BANSHEES_VEIL, KAENIC_ROOKERN] },
    "heavy-ad": { boots: STEELCAPS, any: [ZHONYAS_HOURGLASS] },
    assassins: { any: [ZHONYAS_HOURGLASS] },
    // shielders: no AP item reduces shields. Serpent's Fang is physical-damage
    // only, so a mage vs two shielders has nothing to buy and this cell says so.
  },
  assassin: {
    healers: { ad: [CHEMPUNK_CHAINSWORD], ap: [MORELLONOMICON] },
    tanks: { ad: [SERYLDAS_GRUDGE, LORD_DOMINIKS], ap: [VOID_STAFF] },
    "heavy-cc": { boots: MERCS },
    "heavy-ap": { boots: MERCS, ad: [MAW_OF_MALMORTIUS], ap: [BANSHEES_VEIL] },
    "heavy-ad": { boots: STEELCAPS, ad: [DEATHS_DANCE], ap: [ZHONYAS_HOURGLASS] },
    assassins: { ad: [EDGE_OF_NIGHT], ap: [ZHONYAS_HOURGLASS] },
    shielders: { ad: [SERPENTS_FANG] },
  },
  marksman: {
    healers: { any: [MORTAL_REMINDER] },
    tanks: { any: [LORD_DOMINIKS] },
    "heavy-cc": { boots: MERCS },
    "heavy-ap": { boots: MERCS, any: [WITS_END, MAW_OF_MALMORTIUS] },
    "heavy-ad": { boots: STEELCAPS, any: [GUARDIAN_ANGEL, RANDUINS_OMEN] },
    assassins: { any: [GUARDIAN_ANGEL] },
    // shielders: Serpent's Fang carries no crit and no attack speed. A marksman
    // who buys it gives up the stat their whole build multiplies.
  },
  "fighter-bruiser": {
    healers: { ad: [CHEMPUNK_CHAINSWORD], ap: [MORELLONOMICON] },
    tanks: { ad: [SERYLDAS_GRUDGE, BLACK_CLEAVER], ap: [VOID_STAFF] },
    "heavy-cc": { boots: MERCS },
    "heavy-ap": { boots: MERCS, any: [KAENIC_ROOKERN, FORCE_OF_NATURE, SPIRIT_VISAGE] },
    "heavy-ad": { boots: STEELCAPS, any: [DEATHS_DANCE, RANDUINS_OMEN] },
    assassins: { any: [STERAKS_GAGE] },
    shielders: { ad: [SERPENTS_FANG] },
  },
  tank: {
    healers: { any: [THORNMAIL] },
    // tanks: a tank does not answer two enemy tanks with penetration. Its job
    // in that game is unchanged and its items already are the answer.
    "heavy-cc": { boots: MERCS },
    "heavy-ap": { boots: MERCS, any: [FORCE_OF_NATURE, KAENIC_ROOKERN, SPIRIT_VISAGE] },
    "heavy-ad": { boots: STEELCAPS, any: [RANDUINS_OMEN, FROZEN_HEART, DEAD_MANS_PLATE] },
    // assassins: a tank is not the target. Buying a fourth defensive item
    // against two assassins protects the person they were never going to kill.
    // shielders: no answer that a tank's own build does not already carry.
  },
  "enchanter-support": {
    healers: { any: [MORELLONOMICON] },
    // tanks: an enchanter's damage is not what beats two tanks; its allies' is.
    "heavy-cc": { boots: MERCS, any: [MIKAELS_BLESSING] },
    "heavy-ap": { boots: MERCS, any: [LOCKET_OF_THE_IRON_SOLARI] },
    "heavy-ad": { boots: STEELCAPS, any: [KNIGHTS_VOW] },
    assassins: { any: [ZHONYAS_HOURGLASS] },
    // shielders: same as mage -- no AP shield-reduction item exists.
  },
};

/** Every id this table is willing to name, for the catalogue test and for the
 *  "the block never names an item outside the table" assertion. */
export const ALL_SCENARIO_ITEM_IDS: ReadonlySet<number> = new Set(
  Object.values(CLASS_SCENARIO_ITEMS).flatMap((byScenario) =>
    Object.values(byScenario).flatMap((c: ScenarioCandidate) => [
      ...(c.boots ?? []),
      ...(c.any ?? []),
      ...(c.ad ?? []),
      ...(c.ap ?? []),
    ])
  )
);

/** The item-channel candidate list for one cell, resolved against OUR OWN
 *  damage type. `any` wins when present; a `mixed` champion reaches only `any`.
 *  Empty means the cell names no item, which is a refusal and not a gap. */
export function itemCandidates(
  candidate: ScenarioCandidate | undefined,
  ownDamage: DamageType
): readonly number[] {
  if (!candidate) return [];
  if (candidate.any) return candidate.any;
  if (ownDamage === "ad") return candidate.ad ?? [];
  if (ownDamage === "ap") return candidate.ap ?? [];
  return [];
}

/**
 * Pick one id out of an ordered candidate list.
 *
 * PREFER THE MEASURED, FALL BACK TO THE CURATED. The first candidate that
 * appears in `universe` -- every id the champion's own /api/build response
 * mentions for this champion and lane -- wins, because an item the champion's
 * own data already offers is a recommendation with evidence behind it. When
 * none of them does, the FIRST candidate is taken anyway, and that branch is
 * exactly why the block is labelled JUDGMENT rather than MEASURED. It is
 * reported (`measured: false`) rather than hidden.
 *
 * Returns null only for an empty list, which is a refusal.
 */
export function chooseCandidate(
  candidates: readonly number[],
  universe: ReadonlySet<number>
): { itemId: number; measured: boolean } | null {
  if (candidates.length === 0) return null;
  for (const id of candidates) if (universe.has(id)) return { itemId: id, measured: true };
  return { itemId: candidates[0], measured: false };
}
