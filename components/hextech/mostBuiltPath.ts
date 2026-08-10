import type { ProGame } from "@/components/proGames.types";
import type { ItemDetail } from "@/components/itemDetail";
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
 * strip represents a purchase path rather than independent position modals. */
export function mostBuiltPath(
  games: readonly ProGame[],
  model: ProConsensusModel,
  itemMeta: Map<number, ItemDetail>
): ConsensusPathEntry[] {
  const positionCounts = new Map<number, Map<number, number>>();
  let pathGames = 0;

  games.forEach((game) => {
    const finalIds = new Set((game.finalItems ?? []).filter((id) => id > 0));
    if (finalIds.size === 0 || !Array.isArray(game.purchaseOrder) || game.purchaseOrder.length === 0) return;

    const seen = new Set<number>();
    const ordered = [...game.purchaseOrder]
      .sort((a, b) => a.ts - b.ts)
      .map((purchase) => purchase.itemId)
      .filter((id) => {
        if (seen.has(id) || !finalIds.has(id) || !isBuildItem(id, itemMeta.get(id), itemMeta)) return false;
        seen.add(id);
        return true;
      })
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
