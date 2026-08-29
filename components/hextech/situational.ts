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
 *  order with the enemy-comp promotion applied, capped at
 *  SITUATIONAL_DISPLAY_LIMIT.
 *
 *  ORDER OF OPERATIONS IS THE WHOLE POINT, and getting it wrong is how the
 *  page and the shop would silently disagree. The promotion runs BEFORE the
 *  slice, so a comp-relevant pick sitting at position 7 on raw WPA can reach
 *  the visible six. Slicing first and promoting after would make the promotion
 *  a no-op in exactly the cases it exists for, AND it would produce a
 *  different six than the Builds page shows, for the same champion, in the
 *  same champ select. One function, one order, both surfaces.
 *
 *  `promotedIds` is REQUIRED, not optional with a `[]` default. A caller that
 *  has no comp must say `[]` out loud. An optional parameter here would let a
 *  fixture exercise a path production does not take (or the reverse), which is
 *  the failure this codebase has already paid for elsewhere.
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
export function situationalShortlist(
  items: ItemsBlock,
  promotedIds: readonly number[]
): PickType[] {
  return orderSituationalForComp(flattenSituational(items), promotedIds).slice(
    0,
    SITUATIONAL_DISPLAY_LIMIT
  );
}

/** Moves every pick whose id is in `promotedIds` to the front, preserving the
 *  relative order of both groups.
 *
 *  APPLIED TO THE FULL FLATTENED LIST, BEFORE THE TOP-6 SLICE, and that order
 *  of operations is the whole reason this is a named function rather than a
 *  sort comparator: a comp-relevant pick sitting at position 7 on raw WPA has
 *  to be able to reach the visible window. Slicing first would make the
 *  promotion a no-op in exactly the cases it exists for.
 *
 *  CONTENT-PRESERVING BY CONSTRUCTION. It partitions the input and
 *  concatenates, so the output is always a permutation of the input: same
 *  members, same length, no id introduced and none dropped. That is the
 *  structural form of RC-5b's rule (a prior may PERMUTE a block, never
 *  re-select it) and it is what lets the block keep a title that claims a
 *  source. An id in `promotedIds` that is not in `picks` is silently ignored,
 *  because it cannot be added.
 *
 *  ONE DEFINITION, and it has to stay that way. The Builds page's
 *  SituationalCard, the live panel and (from phase 2) itemSetBody's shop block
 *  all order the same row; two implementations of "promote these" is how the
 *  page and the shop come to disagree about what a named block contains, which
 *  is a defect class this file's header already documents. */
export function orderSituationalForComp(
  picks: readonly PickType[],
  promotedIds: readonly number[]
): PickType[] {
  if (promotedIds.length === 0) return [...picks];
  const set = new Set(promotedIds);
  const promoted = picks.filter((p) => set.has(p.id));
  const rest = picks.filter((p) => !set.has(p.id));
  return [...promoted, ...rest];
}
