// ─────────────────────────────────────────────────────────────────────────────
// purchasePositions.ts — WHEN an item was bought, as opposed to HOW OFTEN it
// ended up in the inventory.
//
// ── The defect this module exists to close ──────────────────────────────────
//
// Every consensus aggregation in this repo read FINAL INVENTORY and threw the
// purchase timeline away, then presented the resulting frequency ranking as a
// BUY ORDER in the in-game shop panel. Measured on live prod, patch 16.16
// (HANDOFF-core-build-order.md, 2026-08-27):
//
//   Jinx Bot, "Pro build" block, frequency order:
//       Infinity Edge 70% -> Hexoptics 55% -> Runaan's 53% -> Yun Tal 43%
//   The same 51 games' actual median purchase positions:
//       Hexoptics #1 -> Yun Tal #1 -> Runaan's #2 -> Infinity Edge #3
//
// The panel told an ADC to buy Infinity Edge FIRST. In the very games that
// produced the 70%, it is bought THIRD. Frequency and order are different
// questions and IE is the item where they disagree most: high frequency,
// late position.
//
// ── Why the timeline cannot be read naively ─────────────────────────────────
//
// Riot's match-v5 timeline fires ITEM_PURCHASED for a thing you BUY. It does
// not fire for a thing that UPGRADES IN PLACE. So the id that ends the game in
// the inventory is frequently an id that was never purchased, and a filter of
// the form `finalItems.includes(purchase.itemId)` silently deletes it.
// Measured over the four named fixtures (2026-08-27, 424 games with timelines):
//
//   final id                     n   purchased directly   resolved from a
//                                                          consumed ancestor
//   Crimson Lucidity            85            0                85  (Ionian Boots)
//   Spellslinger's Shoes        26            0                26  (Sorcerer's)
//   Chainlaced Crushers         16            0                16  (Mercury's)
//   Solstice Sleigh             84            3                 0
//   Celestial Opposition        59            2                 0
//
// Two DIFFERENT classes, and conflating them is what makes the naive repair
// dangerous:
//
//  (a) TIER-3 BOOT ENCHANTS and other in-place upgrades. The consumed parent
//      (Ionian Boots of Lucidity) IS a purchase event, IS a legitimate
//      standalone item, and sits at exactly the right moment. Resolving the
//      final id forward to that purchase is correct, and it is always ONE
//      recipe step (`from: ["3158"]`).
//
//  (b) THE SUPPORT-QUEST CHAIN. World Atlas -> Runic Compass -> Bounty of
//      Worlds -> one of the five finals. The predecessor's brief warned that
//      ancestor-resolution would anchor Solstice Sleigh to World Atlas at
//      0:00 and put a 14-minute item at position 1. MEASURED, and the warning
//      does not apply, for a stronger reason than expected: across 145 Thresh
//      Support games with timelines, `World Atlas`, `Runic Compass` and
//      `Bounty of Worlds` fire **ZERO** purchase events between them. The
//      whole chain is invisible. There is nothing to anchor to, so the
//      hazard cannot occur — and it is double-guarded anyway, because Runic
//      Compass and Bounty of Worlds are both `purchasable: false` and so fail
//      the anchor test below on their own.
//
//      Where the quest final DOES fire a purchase event (11 games across
//      Thresh/Nautilus/Lulu) it lands at ts 744-894s — a remarkably tight
//      window, because the quest completes on a fixed gold schedule — which is
//      right beside the first legendary, NOT at position 1 and NOT last. That
//      is the independent corroboration for the median this module reports
//      from the 3-observation Thresh sample.
//
// ── The anchor test is the whole safety property ────────────────────────────
//
// "Resolve a final id forward through its recipe" is WRONG as a general rule.
// Kindlegem is an ancestor of Locket, Knight's Vow and Mikael's; a Thresh game
// buys three of them; anchoring Locket to the first Kindlegem purchase would
// place it minutes too early. The distinguishing property of a legitimate
// anchor is that it is an item the player STOPPED at — a standalone build
// choice that a later free upgrade consumed — not a component whose recipe
// completion is itself a purchase event. That is exactly what `isAnchorItem`
// tests (callers pass the same `isBuildItem` rule the rest of the app uses),
// and it excludes Kindlegem (`into` non-empty), Bounty of Worlds
// (`purchasable: false`) and every other component, while admitting Ionian
// Boots of Lucidity (a final boot) and Manamune (`into: []`).
//
// ── No metadata is invented ─────────────────────────────────────────────────
//
// This module walks `ItemDetail.from` only. ddragon's `specialRecipe` (the
// transform pointer that links Muramana -> Manamune and the quest chain) is
// NOT on `ItemDetail` and is deliberately not added: it would change nothing
// measurable. Muramana is `purchasable: false` and so never enters a consensus
// block in the first place, and the quest chain has no purchase event at
// either end. Adding a field to buy nothing is how catalog rot starts.
// ─────────────────────────────────────────────────────────────────────────────

import type { ItemDetail } from "@/components/itemDetail";
import { isFinalBootsItem, type ItemCatalog } from "@/lib/bootsItems";

/** One `ITEM_PURCHASED` event, in the shape `lib/pro/extract.ts` stores it
 *  (`ts` in SECONDS). Structural rather than an import of `ProGamePurchase` so
 *  this module stays free of the components/ graph. */
export interface PurchaseEvent {
  itemId: number;
  ts: number;
}

/** A final-inventory item, placed on the game's own purchase timeline. */
export interface ResolvedPurchase {
  /** The id that ENDED the game in the inventory. */
  itemId: number;
  /** Seconds into the game at which it (or the item it consumed) was bought. */
  ts: number;
  via: "direct" | "upgrade";
  /** The purchase event this position came from. Equals `itemId` when
   *  `via === "direct"`; the consumed parent otherwise. Kept because a
   *  position with no traceable cause is exactly the kind of number this
   *  project does not ship. */
  anchorId: number;
}

export interface PurchasePositionOptions {
  catalog: ItemCatalog;
  /** May this id occupy a slot in a build line / consensus block? Injected
   *  rather than re-derived: the caller's partition (proConsensus.ts's
   *  `isBuildItem` chain) is THE rule, and a second copy of it here would be
   *  the exact drift CLAUDE.md gotcha (dd) warns about. */
  isSlotItem: (itemId: number) => boolean;
  /** May this id be the anchor an in-place upgrade consumed? See the module
   *  header — this predicate is the safety property, not a detail. */
  isAnchorItem: (itemId: number) => boolean;
}

/** How far up a recipe an in-place upgrade may be resolved.
 *
 *  Every upgrade class measured on live data is depth 1 — a tier-3 boot
 *  enchant's `from` is exactly its tier-2 boot (85/85 Crimson Lucidity,
 *  26/26 Spellslinger's Shoes, 16/16 Chainlaced Crushers, 14/14 Swiftmarch,
 *  48/48 Sorcerer's-to-Spellslinger's on Viktor). 2 is one step of headroom
 *  for a future two-stage upgrade; it is not licence to walk a recipe tree,
 *  and the anchor test does the real work regardless of this number. */
const MAX_UPGRADE_DEPTH = 2;

/** Sample floor for CLAIMING an order at all. Below this, the block keeps its
 *  frequency order and (per itemSetBody.ts's standing rule that a block title
 *  is a claim about its contents) says so in its title.
 *
 *  Absolute, NOT relative to the sample. Timeline coverage across the 14
 *  measured champion-roles ranges 35%-100% with no visible bias — Lulu Support
 *  has 37 timelines out of 105 games and Thresh has 145 of 151 — because the
 *  gap is which matches the ingest fetched a timeline for, not which games had
 *  one. A relative floor would reject 37 perfectly good games for a reason
 *  that has nothing to do with the games. */
export const MIN_POSITION_GAMES = 10;

/** Per-item floor. An item needs at least this many positioned observations
 *  before its median is allowed to move it.
 *
 *  Three is the smallest count at which a median is a MIDDLE observation
 *  rather than a lone point or the mean of two. It is deliberately low: the
 *  items it protects are rare BY MECHANIC, not by choice — the support-quest
 *  final fires a purchase event in only 3 of 84 Thresh games, and the honest
 *  answer for it is the position those 3 games measured (#2, beside the first
 *  legendary), independently corroborated by the 11-game ts window in the
 *  module header. Raising this floor would push a mid-build item to the END of
 *  the block, which is a NEW ordering bug, not a conservative one. */
export const MIN_POSITION_OBSERVATIONS = 3;

/** An order is a relation between at least two things. One positioned item
 *  among six is a fact about that item, not an ordering of the block. */
const MIN_POSITIONED_ITEMS = 2;

function fromIdsOf(meta: ItemDetail | undefined): number[] {
  if (!meta || !Array.isArray(meta.from)) return [];
  return meta.from.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** Recipe ancestors of `itemId`, nearest first, `from` only. */
function ancestorsNearestFirst(itemId: number, catalog: ItemCatalog): number[] {
  const out: number[] = [];
  const seen = new Set<number>([itemId]);
  let frontier = [itemId];
  for (let depth = 0; depth < MAX_UPGRADE_DEPTH && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const cur of frontier) {
      for (const parent of fromIdsOf(catalog.get(cur))) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        out.push(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return out;
}

/** Place one game's FINAL inventory on its own purchase timeline.
 *
 *  Returns `[]` — never a partial guess — when the game carries no timeline,
 *  which is the honest reading of "we do not know when anything was bought"
 *  and is what keeps a timeline-less game out of every denominator below.
 *
 *  Deterministic: final ids are iterated in ascending numeric order so the
 *  anchor-claiming below cannot depend on a Set's insertion order, and the
 *  result is sorted by `ts` then `itemId`. */
export function resolveFinalItemPositions(
  finalItems: readonly number[],
  purchaseOrder: readonly PurchaseEvent[],
  opts: PurchasePositionOptions
): ResolvedPurchase[] {
  if (!Array.isArray(purchaseOrder) || purchaseOrder.length === 0) return [];

  const firstTs = new Map<number, number>();
  for (const p of [...purchaseOrder].sort((a, b) => a.ts - b.ts)) {
    if (!firstTs.has(p.itemId)) firstTs.set(p.itemId, p.ts);
  }

  const finalIds = new Set((finalItems ?? []).filter((id) => id > 0));
  const claimedAnchors = new Set<number>();
  const out: ResolvedPurchase[] = [];

  for (const itemId of Array.from(finalIds).sort((a, b) => a - b)) {
    if (!opts.isSlotItem(itemId)) continue;

    const direct = firstTs.get(itemId);
    if (direct !== undefined) {
      out.push({ itemId, ts: direct, via: "direct", anchorId: itemId });
      continue;
    }

    // Upgraded in place. The anchor must be (1) actually bought, (2) NOT part
    // of the final inventory itself — an id still held at the end was not
    // consumed by anything, (3) a legitimate standalone item rather than a
    // recipe component (the safety property; see the module header), and
    // (4) not already spent positioning a different final item.
    const anchor = ancestorsNearestFirst(itemId, opts.catalog).find(
      (a) => firstTs.has(a) && !finalIds.has(a) && !claimedAnchors.has(a) && opts.isAnchorItem(a)
    );
    if (anchor === undefined) continue;
    claimedAnchors.add(anchor);
    out.push({ itemId, ts: firstTs.get(anchor)!, via: "upgrade", anchorId: anchor });
  }

  return out.sort((a, b) => a.ts - b.ts || a.itemId - b.itemId);
}

export interface ItemPositionStat {
  /** 1-based median position among the game's own resolved build items. May
   *  be a `.5` for an even observation count — it is a median, not an index. */
  median: number;
  observations: number;
}

export interface PurchasePositionModel {
  /** Games in the sample that produced at least one resolved position. The
   *  denominator for `MIN_POSITION_GAMES`, and NOT the same number as
   *  `ProConsensusModel.itemsSampleSize` — a game can carry final items and no
   *  timeline. */
  sampleSize: number;
  positions: Map<number, ItemPositionStat>;
  /** Boots as PURCHASED, count-desc / id-asc. The FIRST final-boots purchase
   *  of each game — the tier-2 boot the player actually had to buy, not the
   *  tier-3 enchant it later became and not the pair an ADC sold at 30
   *  minutes. */
  boots: { itemId: number; count: number }[];
  /** Games contributing to `boots`. A separate denominator because a game can
   *  resolve item positions and still never buy a tracked boot. */
  bootsSampleSize: number;
}

const EMPTY_MODEL: PurchasePositionModel = {
  sampleSize: 0,
  positions: new Map(),
  boots: [],
  bootsSampleSize: 0,
};

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface PurchaseSampleGame {
  finalItems?: number[] | null;
  purchaseOrder?: PurchaseEvent[] | null;
}

/** Fold a sample of games into per-item median purchase positions plus the
 *  boots the sample actually BOUGHT. */
export function aggregatePurchasePositions(
  games: readonly PurchaseSampleGame[],
  opts: PurchasePositionOptions
): PurchasePositionModel {
  if (games.length === 0) return EMPTY_MODEL;

  const observed = new Map<number, number[]>();
  const bootCounts = new Map<number, number>();
  let sampleSize = 0;
  let bootsSampleSize = 0;

  for (const game of games) {
    const purchases = Array.isArray(game.purchaseOrder) ? game.purchaseOrder : [];
    const resolved = resolveFinalItemPositions(game.finalItems ?? [], purchases, opts);
    if (resolved.length > 0) {
      sampleSize += 1;
      resolved.forEach((entry, index) => {
        const list = observed.get(entry.itemId) ?? [];
        list.push(index + 1);
        observed.set(entry.itemId, list);
      });
    }

    // Boots come off the RAW timeline, not off `resolved`: an ADC who sold
    // their boots has no boot in `finalItems` at all, which is precisely the
    // case final-inventory aggregation gets wrong (Jinx Bot: 0 of 53 games
    // ended holding boots; 34 of 51 bought Berserker's Greaves).
    const firstBoot = [...purchases]
      .sort((a, b) => a.ts - b.ts)
      .find((p) => isFinalBootsItem(p.itemId, opts.catalog.get(p.itemId), opts.catalog));
    if (firstBoot) {
      bootsSampleSize += 1;
      bootCounts.set(firstBoot.itemId, (bootCounts.get(firstBoot.itemId) ?? 0) + 1);
    }
  }

  const positions = new Map<number, ItemPositionStat>();
  for (const [itemId, list] of observed) {
    positions.set(itemId, { median: median(list), observations: list.length });
  }

  return {
    sampleSize,
    positions,
    boots: Array.from(bootCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([itemId, count]) => ({ itemId, count })),
    bootsSampleSize,
  };
}

/** `ids`, re-ordered into real purchase order — or `null` when the sample
 *  cannot support the claim.
 *
 *  `null` is a first-class answer and the caller must have somewhere honest to
 *  put it: the block keeps its frequency order AND stops calling itself a
 *  build. Returning a half-informed order instead would be the same defect
 *  this module exists to fix, wearing a different number.
 *
 *  Items below `MIN_POSITION_OBSERVATIONS` are not dropped — they keep the
 *  relative order the caller gave them (share-desc) and follow every
 *  positioned item. Ties on the median go to the item with MORE observations,
 *  so a 3-game median can never outrank a 128-game median it merely ties. */
export function purchaseOrderedIds(
  ids: readonly number[],
  model: PurchasePositionModel
): number[] | null {
  if (model.sampleSize < MIN_POSITION_GAMES) return null;

  const rank = new Map<number, number>();
  ids.forEach((id, index) => rank.set(id, index));

  const positioned: number[] = [];
  const unpositioned: number[] = [];
  for (const id of ids) {
    const stat = model.positions.get(id);
    if (stat && stat.observations >= MIN_POSITION_OBSERVATIONS) positioned.push(id);
    else unpositioned.push(id);
  }
  if (positioned.length < MIN_POSITIONED_ITEMS) return null;

  positioned.sort((a, b) => {
    const sa = model.positions.get(a)!;
    const sb = model.positions.get(b)!;
    return sa.median - sb.median || sb.observations - sa.observations || rank.get(a)! - rank.get(b)!;
  });

  return [...positioned, ...unpositioned];
}
