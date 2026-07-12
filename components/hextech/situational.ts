// Pure helper, split out of SituationalCard.tsx so it can be unit-tested
// from a .ts test file — vitest 4's oxc transform can't parse JSX in files
// outside its default jsx scope, so any module a plain .ts test imports
// from must itself contain no JSX (same constraint StatBadge.tsx documents;
// see components/__tests__/StatBadge.test.ts for the established pattern).
import type { ItemsBlock, Pick as PickType } from "@/lib/types";

/** Flattens every per-slot "or" alternative (items.alts, keyed by slot) into
 *  one deduped, WPA-descending list — the situational swap set the spec's
 *  chip row shows. */
export function flattenSituational(items: ItemsBlock): PickType[] {
  const alts = items.alts;
  if (!alts) return [];
  const seen = new Set<number>();
  const out: PickType[] = [];
  for (const slotPicks of Object.values(alts)) {
    for (const pick of slotPicks) {
      if (seen.has(pick.id)) continue;
      seen.add(pick.id);
      out.push(pick);
    }
  }
  return out.sort((a, b) => b.wpa - a.wpa);
}
