// Pure helper, split out of RunesSummonersCard.tsx so it can be unit-tested
// from a .ts test file — vitest 4's oxc transform can't parse JSX in files
// outside its default jsx scope, so any module a plain .ts test imports from
// must itself contain no JSX (same constraint StatBadge.tsx documents; see
// components/__tests__/StatBadge.test.ts / components/hextech/situational.ts
// for the established pattern).
//
// Assembles the FULL rune page (primary tree's 3 minors + secondary tree's 2
// picks + labeled stat shards) from the /api/build wire contract
// (lib/types.ts's RunesBlock) — the pre-redesign Builds page rendered this
// via RunePage.tsx; the Hextech RunesSummonersCard only showed the keystone +
// secondary tree icon + mini shard dots. This restores full content while
// keeping the shaping logic testable without a DOM.
import type { RunesBlock, Pick as PickType, TreeRef } from "@/lib/types";

export interface RunesPageModel {
  primaryTree: TreeRef;
  secondaryTree: TreeRef;
  /** runes.primary, defensively defaulted to [] — the wire contract says
   *  "exactly 3" but this module never assumes a fixed length so a short or
   *  empty array degrades to fewer tiles instead of throwing. */
  primaryMinors: PickType[];
  /** runes.secondary, same defensive default as primaryMinors. */
  secondaryPicks: PickType[];
  /** Offense -> Flex -> Defense, the fixed reading order the pre-redesign
   *  RunePage.tsx used (ShardSet's own key order isn't guaranteed to survive
   *  a JSON round-trip, so this is spelled out explicitly rather than
   *  Object.values()'d). */
  shards: { label: string; pick: PickType }[];
}

export function buildRunesPageModel(runes: RunesBlock): RunesPageModel {
  return {
    primaryTree: runes.primaryTree,
    secondaryTree: runes.secondaryTree,
    primaryMinors: Array.isArray(runes.primary) ? runes.primary : [],
    secondaryPicks: Array.isArray(runes.secondary) ? runes.secondary : [],
    shards: buildShardRow(runes.shards),
  };
}

export function buildShardRow(shards: RunesBlock["shards"]): { label: string; pick: PickType }[] {
  return [
    { label: "Offense", pick: shards.offense },
    { label: "Flex", pick: shards.flex },
    { label: "Defense", pick: shards.defense },
  ];
}
