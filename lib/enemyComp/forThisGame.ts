// ─────────────────────────────────────────────────────────────────────────────
// forThisGame.ts -- the "For this game" decision, and the line it produces.
//
// WHAT THIS BLOCK IS. A full six-item build line -- starter excluded, boots
// included, exactly one pair of boots -- built from the champion's own WPA
// build line as the SPINE, with at most two slots swapped for items chosen
// against the enemy composition and placed at sensible purchase positions.
//
// WHAT IT IS DELIBERATELY NOT. A delta row of counter items. The `Situational`
// block already is a swap menu and says so; a second menu next to it would be
// two answers to the same question. This block answers a different question --
// "what do I actually build in THIS game" -- and the only honest form of that
// answer is a build you could play start to finish.
//
// TWO FUNCTIONS, AND THE SPLIT IS LOAD-BEARING:
//
//   resolveForThisGamePlan()  the DECISION. Pure over (enemy ids, our champion,
//                             our lane, our /api/build items). Knows nothing
//                             about how a line is assembled. This is what the
//                             dedup key is built from and what the Builds page
//                             card renders.
//   applyForThisGameLine()    the LINE. Pure over (the WPA line's ids, a plan,
//                             the boots id set). Knows nothing about enemy
//                             comps.
//
// Keeping them apart is what lets the export key describe the DECISION while
// the block describes the LINE, and it is what makes both testable without the
// other. It also means a champion whose build data is thin still produces a
// plan (and a Builds-page card) even when the line comes out short.
//
// JUDGMENT, AND THE APP SAYS SO. The scenario read is a curated kit
// classification (kitAxes.ts, compRatings.ts) and the item choice is an
// editorial table (scenarioItems.ts). Neither is measured. What keeps that
// honest rather than merely disclaimed is `chooseCandidate`, which PREFERS an
// item the champion's own /api/build data already offers and reports
// `measured: false` when it had to fall back to the curated pick.
//
// PURE. No React, no fetch, no wall clock. Every input is a champion id visible
// in champ select before the game starts, plus our own build response; nothing
// here reads, infers or uses anything about what enemies buy DURING a game.
// ─────────────────────────────────────────────────────────────────────────────

import type { ItemsBlock } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";
import { getDamageType } from "@/lib/enemyComp/damageType";
import { resolveChampionItemClass, type ChampionItemClass } from "@/lib/enemyComp/championClass";
import {
  CLASS_SCENARIO_ITEMS,
  chooseCandidate,
  itemCandidates,
} from "@/lib/enemyComp/scenarioItems";
import {
  classifyEnemyComp,
  scenarioReason,
  SCENARIO_PRIORITY,
  type CompEvidence,
  type CompScenario,
} from "@/lib/enemyComp/scenarios";

/** The block's title, in exactly one place. It is a NOUN PHRASE, never an
 *  instruction: the block presents a build, it does not tell a player to do
 *  something in their game. */
export const FOR_THIS_GAME_BLOCK_TITLE = "For this game";

/** How many of the line's item slots the comp may claim.
 *
 *  Two. One is not enough for the common real case (a comp is routinely two
 *  scenarios at once -- two healers AND two tanks), and three starts replacing
 *  the build rather than adjusting it: the spine is what makes this block a
 *  recommendation for THIS champion rather than a generic anti-comp shopping
 *  list. Boots are NOT counted against this budget; they have their own slot in
 *  the line and swapping them costs no item. */
export const MAX_ITEM_SWAPS = 2;

/** Six, the same `LINE_LEN` every other build line in the set holds. Not
 *  imported from itemSetBody.ts: that module imports THIS one, and a build-line
 *  length is a fact about the game (six inventory slots minus the trinket), not
 *  a fact either module owns. A test asserts the two agree. */
export const FOR_THIS_GAME_LINE_LEN = 6;

/**
 * Where each scenario's item wants to be BOUGHT, as a 1-based position among
 * the line's non-boots items.
 *
 * A build line is read left to right as a buy order -- that is the entire
 * reason the in-game shop panel exists -- so these are claims about WHEN, not
 * layout choices.
 *
 *   healers   2nd  Anti-heal that arrives 5th has spent the whole mid-game not
 *                  applying. It is cheap and it is the first thing that stops
 *                  mattering if you delay it.
 *   tanks     3rd  Penetration is worth nothing before the enemy has
 *                  resistances to penetrate, and they have them by the third
 *                  item.
 *   heavy-ap  3rd  Same shape: a defensive item bought first gives up the lane.
 *   heavy-ad  3rd
 *   shielders 3rd
 *   assassins 4th  The latest of the five, because the threat it answers is a
 *                  teamfight threat and the item that answers it is expensive.
 *
 * `heavy-cc` has no entry: its answer is boots, and boots have their own slot.
 */
const SCENARIO_TARGET_POSITION: Partial<Record<CompScenario, number>> = {
  healers: 2,
  tanks: 3,
  "heavy-ap": 3,
  "heavy-ad": 3,
  shielders: 3,
  assassins: 4,
};

/** Fallback for a scenario with no declared position. Cannot be reached today
 *  (`heavy-cc` is the only entry-less scenario and it is boots-only), and it
 *  exists so a future scenario added without a position lands somewhere
 *  defensible instead of at index NaN. */
const DEFAULT_TARGET_POSITION = 3;

/** One item the comp claimed, with everything needed to explain it. */
export interface ForThisGamePick {
  itemId: number;
  scenario: CompScenario;
  /** The scenario's reason with its own number in it, e.g. `2 healers`.
   *  Derived HERE, once, and handed to every surface -- the shop's
   *  `companion.log` caption and the Builds page card must not be able to say
   *  different things about the same swap. */
  reason: string;
  /** True when this id already appears somewhere in the champion's own
   *  /api/build data. False means the curated fallback was taken, which is the
   *  branch that makes this block JUDGMENT rather than MEASURED. Reported
   *  rather than hidden. */
  measured: boolean;
}

export interface ForThisGamePlan {
  /** In SCENARIO_PRIORITY order. Every scenario the comp presents, including
   *  ones that claimed no slot -- a surface that wants to say "also heavy CC"
   *  should be able to. */
  scenarios: CompScenario[];
  evidence: CompEvidence;
  /** The class the item table was read from. */
  itemClass: ChampionItemClass;
  /** The boot the comp asks for, or null when no scenario named one (or when
   *  the champion's own boot is already it). */
  boots: ForThisGamePick | null;
  /** At most MAX_ITEM_SWAPS, in the order they were claimed. */
  items: ForThisGamePick[];
}

/**
 * Every item id the champion's own /api/build response mentions for this
 * champion and lane: the starter, the boots, all three named legendary slots,
 * every `fourthPlus`, every `optimizedPath` entry, and every id in every
 * `alts` slot.
 *
 * THIS IS THE "MEASURED" IN `measured: true`. An item in here is one the
 * model's own data surfaced for this champion, so recommending it is a choice
 * between things the data already offered. An item outside it is the curated
 * table's opinion and nothing more.
 *
 * The starter is deliberately included even though HARD RULE 2 keeps it out of
 * every build line: this set answers "has the data seen this item", not "may
 * this item ship". No scenario candidate is a starter, so the inclusion cannot
 * put one in a line.
 */
export function measuredItemUniverse(items: ItemsBlock): Set<number> {
  const ids = new Set<number>([
    items.starter.id,
    items.boots.id,
    items.first.id,
    items.second.id,
    items.third.id,
  ]);
  for (const p of items.fourthPlus) ids.add(p.id);
  for (const p of items.optimizedPath ?? []) ids.add(p.id);
  for (const slot of Object.values(items.alts ?? {})) for (const p of slot) ids.add(p.id);
  return ids;
}

/**
 * The decision, or null when there is nothing honest to say.
 *
 * FOUR WAYS TO GET NULL, and every one of them means the export ships exactly
 * as it does without this feature, byte identical:
 *   1. The comp is not complete, or is mostly guessed at (classifyEnemyComp).
 *   2. The champion has no row in championClass.ts -- a brand-new champion,
 *      before someone adds one.
 *   3. No scenario fired at all.
 *   4. Every scenario that fired named nothing for this class. That is the
 *      table's refusals doing their job: a tank facing two tanks and two
 *      assassins genuinely has no swap to make, and inventing one would be the
 *      fabrication HARD RULE 4 exists to stop.
 */
export function resolveForThisGamePlan(params: {
  enemyChampionIds: readonly number[];
  championId: number;
  lane: LaneId;
  items: ItemsBlock;
}): ForThisGamePlan | null {
  const classification = classifyEnemyComp(params.enemyChampionIds);
  if (!classification) return null;

  const itemClass = resolveChampionItemClass(params.championId, params.lane);
  if (!itemClass) return null;

  const ownDamage = getDamageType(params.championId);
  const universe = measuredItemUniverse(params.items);
  const table = CLASS_SCENARIO_ITEMS[itemClass];

  let boots: ForThisGamePick | null = null;
  const picks: ForThisGamePick[] = [];
  const claimed = new Set<number>();

  // ONE walk, TWO budgets. A candidate whose channel is full is SKIPPED and the
  // walk continues -- that is what lets heavy-cc still take Mercury's Treads
  // after healers and tanks have taken both item slots, without a second
  // priority order existing anywhere for boots to be sorted by.
  for (const scenario of classification.scenarios) {
    const cell = table[scenario];
    if (!cell) continue;
    const reason = scenarioReason(scenario, classification.evidence);

    if (cell.boots && boots === null) {
      const chosen = chooseCandidate(cell.boots, universe);
      // The champion's own boot already being the answer is not a swap. Saying
      // "Mercury's Treads: heavy CC" about a build that already opened on
      // Mercury's Treads would claim a change that did not happen.
      if (chosen && chosen.itemId !== params.items.boots.id) {
        boots = { ...chosen, scenario, reason };
        claimed.add(chosen.itemId);
      }
    }

    if (picks.length < MAX_ITEM_SWAPS) {
      const chosen = chooseCandidate(itemCandidates(cell, ownDamage), universe);
      // A single id can legitimately answer two scenarios (a mage's Zhonya's
      // answers both heavy-ad and assassins). Taking it twice would spend two
      // slots on one item, so the second scenario simply does not claim a slot.
      if (chosen && !claimed.has(chosen.itemId)) {
        picks.push({ ...chosen, scenario, reason });
        claimed.add(chosen.itemId);
      }
    }

    if (boots !== null && picks.length >= MAX_ITEM_SWAPS) break;
  }

  if (boots === null && picks.length === 0) return null;

  return {
    scenarios: classification.scenarios,
    evidence: classification.evidence,
    itemClass,
    boots,
    items: picks,
  };
}

/** One change the line actually took, for the caption channel and the card. */
export interface ForThisGameSwap {
  itemId: number;
  scenario: CompScenario;
  reason: string;
  measured: boolean;
  channel: "boots" | "item";
  /** The id this pick displaced, or null when nothing was dropped -- either
   *  because the item was already in the line and only MOVED, or because the
   *  line was short and had room. */
  replacedId: number | null;
  /** 1-based purchase position in the finished line, boots included. Reported
   *  so a surface can say "buy it 3rd" instead of leaving the reader to count. */
  position: number;
}

export interface ForThisGameLine {
  /** Exactly one boots, at most FOR_THIS_GAME_LINE_LEN entries, no duplicates.
   *  Shorter only when the spine it was given was shorter -- this function
   *  never invents an item to reach six, the same rule `buildLine` follows. */
  ids: number[];
  swaps: ForThisGameSwap[];
}

/**
 * Apply a plan to the WPA build line.
 *
 * THE SPINE IS THE POINT. Everything outside the swapped positions is the WPA
 * line verbatim, in its own order, including where it put the boots. This
 * function may substitute the boots id, move an item the line already held, or
 * replace the line's LAST item with a scenario pick -- and nothing else.
 *
 * WHY THE LAST ITEM IS WHAT GETS DROPPED. It is the one you buy last, so it is
 * the one you are least likely to reach and the cheapest thing in the build to
 * give up. Replacing the item AT the target position instead would drop a
 * second- or third-item pick -- a core part of the build -- to make room for a
 * situational one, which is a much larger claim than the evidence supports.
 * Dropping the tail and inserting earlier is exactly the trade a real player
 * makes.
 *
 * CONTENT RULES, all structural rather than remembered:
 *   - the result holds exactly as many boots as the spine did (one, in
 *     practice), because a boots pick SUBSTITUTES rather than inserts;
 *   - no id appears twice, because an id already in the line is moved rather
 *     than added;
 *   - the length never grows past the spine's own length or
 *     FOR_THIS_GAME_LINE_LEN, whichever is smaller.
 */
export function applyForThisGameLine(
  wpaLineIds: readonly number[],
  plan: ForThisGamePlan,
  bootsIds: ReadonlySet<number>
): ForThisGameLine {
  const swaps: ForThisGameSwap[] = [];
  const bootsIndex = wpaLineIds.findIndex((id) => bootsIds.has(id));
  let boots: number | null = bootsIndex >= 0 ? wpaLineIds[bootsIndex] : null;
  const others = wpaLineIds.filter((_, i) => i !== bootsIndex);
  // The spine's own boots position, preserved verbatim. Not this module's
  // constant: itemSetBody's BOOTS_LINE_INDEX is measured against real purchase
  // timelines and re-deriving it here would be a second answer to a question
  // that already has one.
  const bootsAt = bootsIndex >= 0 ? Math.min(bootsIndex, others.length) : Math.min(1, others.length);

  // The length the finished line must not exceed. The spine's own length when
  // it is short (buildLine ships short rather than inventing, and this function
  // must not quietly repair that), FOR_THIS_GAME_LINE_LEN otherwise.
  const targetLen = Math.min(FOR_THIS_GAME_LINE_LEN, wpaLineIds.length);

  if (plan.boots) {
    let replacedId = boots;
    boots = plan.boots.itemId;
    // Defensive: if the spine somehow already carried this exact boot, the plan
    // would not have named it (resolveForThisGamePlan compares against
    // items.boots), but a spine whose boots came from a padding pool can differ
    // from items.boots. Dropping the duplicate keeps the no-duplicates rule
    // structural rather than assumed.
    const dupe = others.indexOf(boots);
    if (dupe >= 0) others.splice(dupe, 1);
    // A spine with NO boots (buildLine's never-invent branch, live on Yuumi
    // Support before v0.36.0) gains one here, so something has to leave or the
    // line grows to seven and stops being a loadout. Same rule as an item
    // swap: the thing you buy last is the thing you give up.
    if (replacedId === null && others.length + 1 > targetLen) {
      replacedId = others.pop() ?? null;
    }
    swaps.push({
      itemId: plan.boots.itemId,
      scenario: plan.boots.scenario,
      reason: plan.boots.reason,
      measured: plan.boots.measured,
      channel: "boots",
      replacedId,
      position: Math.min(bootsAt, others.length) + 1,
    });
  }

  const capacity = targetLen - (boots === null ? 0 : 1);
  const taken = new Set<number>();

  for (const pick of plan.items) {
    if (pick.itemId === boots) continue; // never a second pair of boots
    const target = SCENARIO_TARGET_POSITION[pick.scenario] ?? DEFAULT_TARGET_POSITION;
    const existing = others.indexOf(pick.itemId);
    let replacedId: number | null = null;

    if (existing >= 0) {
      // Already in the build. Move it to where it should be BOUGHT rather than
      // replacing anything: the useful information here is the timing, and
      // dropping an item to re-add one already present would shrink the build
      // for nothing.
      others.splice(existing, 1);
    } else {
      // Full line: give up the last item, the one bought last. Short line: no
      // need, there is room.
      if (others.length >= capacity) replacedId = others.pop() ?? null;
    }

    // Where the target position lands once the boots go back in. Positions in
    // SCENARIO_TARGET_POSITION count NON-BOOTS items, so a target of 3 means
    // "the third item you buy", not "index 3".
    let at = Math.min(Math.max(target - 1, 0), others.length);
    while (taken.has(at) && at < others.length) at++;
    others.splice(at, 0, pick.itemId);
    taken.add(at);

    swaps.push({
      itemId: pick.itemId,
      scenario: pick.scenario,
      reason: pick.reason,
      measured: pick.measured,
      channel: "item",
      replacedId,
      position: at + (boots !== null && bootsAt <= at ? 1 : 0) + 1,
    });
  }

  const at = Math.min(bootsAt, others.length);
  const ids = boots === null ? others : [...others.slice(0, at), boots, ...others.slice(at)];
  return { ids, swaps };
}

/**
 * The DERIVED decision as one short stable string, for the export dedup key.
 *
 * It describes the EXPORT exactly: the scenarios (which are what the caption
 * line says) and the ids (which are what the block holds). Nothing else --
 * not the enemy list, not how many enemies have locked in, not the evidence
 * counts, all of which move without changing a single byte of what is written.
 *
 * This is deliberately LESS minimal than the `compSignalKey` it replaces, and
 * the reason that is safe is that the trigger changed underneath it. That key
 * gated a per-tick re-export budget, so every extra field it carried was
 * another whole-document LCU PUT; this one is only consulted at the single
 * finalization write (components/live/compFinalization.ts), where its whole job
 * is to answer "would this write change anything" -- and a changed caption IS
 * a change.
 *
 * `null` maps to a real key rather than to null, so "no plan" is an ordinary
 * value that compares like any other. Reverting a stale block back to no block
 * matters exactly as much as adding one.
 */
export function forThisGameKey(plan: ForThisGamePlan | null): string {
  if (!plan) return "none";
  const boots = plan.boots ? plan.boots.itemId : "-";
  const items = plan.items.map((p) => p.itemId).join(",");
  return `ftg:${plan.scenarios.join("+")}:${boots}:${items}`;
}

/** Every scenario, in priority order, for exhaustiveness tests. Re-exported so
 *  a consumer never has to import two modules to iterate them. */
export { SCENARIO_PRIORITY };
