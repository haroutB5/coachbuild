// Pure helper, split out of SituationalCard.tsx so it can be unit-tested
// from a .ts test file — vitest 4's oxc transform can't parse JSX in files
// outside its default jsx scope, so any module a plain .ts test imports
// from must itself contain no JSX (same constraint StatBadge.tsx documents;
// see components/__tests__/StatBadge.test.ts for the established pattern).
import type { ItemsBlock, Pick as PickType } from "@/lib/types";

/** How many situational picks any SURFACE shows. Owned here, not by a caller,
 *  because there are now TWO consumers and they must agree:
 *
 *    1. components/hextech/SituationalCard.tsx — the Builds page's SITUATIONAL
 *       panel (the thing the user is looking at).
 *    2. components/hextech/itemSetBody.ts — the "Situational" block inside the
 *       LCU item set (the thing that reaches the in-game shop).
 *
 *  The shop and the page disagreeing about what a named block contains is a
 *  defect class this codebase has paid for before (see itemSetBody.ts's
 *  Hidden gem note: "One definition, computed from data both surfaces hold").
 *  A test pins BOTH call sites against this constant, and mutating it must
 *  fail both — a shared constant proven at one consumer proves nothing about
 *  the other, which could still be carrying a hardcoded 6. */
export const SITUATIONAL_DISPLAY_LIMIT = 6;

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
  return out.sort((a, b) => b.wpa - a.wpa || a.id - b.id);
}

/** The exact window EVERY situational surface renders: `flattenSituational`'s
 *  order, capped at SITUATIONAL_DISPLAY_LIMIT.
 *
 *  ── NO LONGER COMP-ORDERED (0.120.0), AND THE REMOVAL IS THE DECISION ─────
 *  From 0.118.0 to 0.119.0 this took a `promotedIds` argument and moved the
 *  enemy-comp signal's picks to the front before the slice. That is gone, and
 *  `orderSituationalForComp` with it. The reasons, in order of weight:
 *
 *    1. The item set now carries a `For this game` block, which is a whole
 *       comp-adjusted BUILD. Two comp-driven opinions inside one set cannot be
 *       reconciled by the reader: the situational promotion was gated on the
 *       item existing in the champion's own pool AND on costing at most
 *       MAX_WPA_COST, and the new block is gated on neither, so the two could
 *       legitimately disagree about the same comp with nothing on screen
 *       explaining why.
 *    2. It mostly did not do anything. Measured over 4,900 held-out trials in
 *       scripts/sweep-enemycomp.mts: a 7.3% fire rate, of which 58.2% only
 *       RELABELLED an item that was already at the head of the row.
 *    3. It retires MAX_WPA_COST, which sat at the median of a smooth
 *       distribution with no natural break and was the top open decision on
 *       the whole feature. Nothing depends on it now.
 *
 *  So this row is a pure SOURCE claim again -- "the alternatives this
 *  champion's own per-slot data offers, WPA-ordered" -- which is the standing
 *  rule in itemSetBody.ts and the thing its title has always promised.
 *
 *  ORDER IS THE ONLY THING CARRYING THE DELTA. The Builds page prints each
 *  pick's WPA next to it (`wpaText`); an LCU item-set block carries nothing but
 *  `{id, count}` — there is no field to put a number in. So descending WPA is
 *  the only signal that survives the trip into the shop, which is why this
 *  returns the sorted list verbatim rather than, say, boots-first or
 *  cheapest-first. It also puts any negative-delta pick LAST by construction.
 *
 *  NOT FILTERED on WPA sign, deliberately — see itemSetBody.ts's
 *  `situationalBlockPicks` for the measurement behind that call and the open
 *  recommendation attached to it. */
export function situationalShortlist(items: ItemsBlock): PickType[] {
  return flattenSituational(items).slice(0, SITUATIONAL_DISPLAY_LIMIT);
}
