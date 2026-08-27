import type { ProGame } from "@/components/proGames.types";
import type { ItemDetail } from "@/components/itemDetail";
import { resolveFinalItemPositions } from "@/lib/purchasePositions";
import { formatSharePct, isBuildItem, type ProConsensusModel } from "./proConsensus";

export interface ConsensusPathEntry {
  itemId: number;
  count: number;
  denominator: number;
}

export function pathEntryPct(entry: ConsensusPathEntry): string {
  return formatSharePct(entry.denominator > 0 ? entry.count / entry.denominator : 0);
}

/** The purchase path is display-only. The aggregation contract remains the
 * final-inventory model in proConsensus.ts; when a stored game has a purchase
 * timeline we use it to answer the path question, and otherwise fall back to
 * the same honest final-item frequencies the old card already exposed.
 * Timeline positions are resolved left to right, greedily excluding item ids
 * already placed because a player can only own one copy of an item and the
 * strip represents a purchase path rather than independent position modals.
 *
 * ── RC-3, 2026-08-27: this used to DELETE every item upgraded in place ─────
 * The filter was `finalIds.has(purchase.itemId)`, and Riot's timeline fires
 * ITEM_PURCHASED only for a thing you BUY. A tier-3 boot enchant is not
 * bought — the tier-2 boot becomes it — so the purchased id and the final id
 * never intersect and the item was dropped from the path entirely. Measured
 * live on patch 16.16: 85 of 127 Ahri Mid timelines end holding Crimson
 * Lucidity and ZERO of them purchased it, so this strip rendered with no boots
 * in it at all.
 *
 * `resolveFinalItemPositions` closes it by walking the recipe FORWARD from the
 * final id to the purchase that put it on the board — and, critically, only
 * when the consumed parent was a legitimate standalone item rather than a
 * recipe component. That guard is why a support-quest final still cannot land
 * at position 1 off its 0:00 chain root; see that module's header for the
 * 145-game measurement showing the chain fires no events at all. */
export function mostBuiltPath(
  games: readonly ProGame[],
  model: ProConsensusModel,
  itemMeta: Map<number, ItemDetail>
): ConsensusPathEntry[] {
  const positionCounts = new Map<number, Map<number, number>>();
  let pathGames = 0;
  // The card's own partition, unchanged: allowlist-inclusive `isBuildItem`, so
  // a starter still opens the path the way the no-timeline fallback below
  // does. Both the slot test and the anchor test use it — the anchor test is
  // what excludes a shared component like Kindlegem.
  const isPathItem = (id: number) => isBuildItem(id, itemMeta.get(id), itemMeta);

  games.forEach((game) => {
    const ordered = resolveFinalItemPositions(game.finalItems ?? [], game.purchaseOrder ?? [], {
      catalog: itemMeta,
      isSlotItem: isPathItem,
      isAnchorItem: isPathItem,
    })
      .map((entry) => entry.itemId)
      .slice(0, 6);

    if (ordered.length === 0) return;
    pathGames += 1;
    ordered.forEach((itemId, position) => {
      const counts = positionCounts.get(position) ?? new Map<number, number>();
      counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
      positionCounts.set(position, counts);
    });
  });

  if (pathGames > 0) {
    const used = new Set<number>();
    return Array.from({ length: 6 }, (_, position) => {
      const counts = positionCounts.get(position);
      if (!counts) return null;

      const candidate = Array.from(counts.entries())
        .filter(([itemId]) => !used.has(itemId))
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (!candidate) return null;

      const [itemId, count] = candidate;
      used.add(itemId);
      return { itemId, count, denominator: pathGames };
    }).filter((entry): entry is ConsensusPathEntry => entry !== null);
  }

  const fallback = [
    ...model.starters.slice(0, 1),
    ...model.boots.slice(0, 1),
    ...model.items,
  ];
  const seen = new Set<number>();
  return fallback
    .filter((entry) => {
      if (seen.has(entry.itemId)) return false;
      seen.add(entry.itemId);
      return true;
    })
    .slice(0, 6)
    .map((entry) => ({ itemId: entry.itemId, count: entry.count, denominator: model.itemsSampleSize }));
}
