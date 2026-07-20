// ─────────────────────────────────────────────────────────────────────────────
// runeApplyBody.ts — pure builder for the companion's POST /apply-runes body
// (live-companion-plan.md §2c / §5 wire contract). Split out from
// RunesSummonersCard.tsx (which owns the button + click handler) so the
// shaping logic is unit-testable without a DOM, per this repo's established
// "pure logic in a .ts sibling, JSX stays in the .tsx" convention (see
// situational.ts / runesPage.ts's own header comments).
//
// §0 pre-flight finding (verified in repo, RISK #4 RESOLVED): lib/coachless.ts
// -> lib/recommend.ts's runeEntryToPick -> Pick.id carries RAW Riot perk ids
// end to end, and LCU's selectedPerkIds use that exact same id space — so
// this builder does ZERO remapping, it only reorders/concatenates ids already
// on the wire.
// ─────────────────────────────────────────────────────────────────────────────

import type { RunesBlock } from "@/lib/types";

export interface RuneApplyBody {
  name: string;
  primaryStyleId: number;
  subStyleId: number;
  /** keystone, 3 primary, 2 secondary, then shards offense -> flex ->
   *  defense — always exactly 9, matching the LCU POST /lol-perks/v1/pages
   *  selectedPerkIds contract (plan §1 / research §A). */
  selectedPerkIds: number[];
  current: true;
}

const EXPECTED_PERK_COUNT = 9;

/** Builds the exact JSON body companionClient.applyRunes() POSTs to the
 *  bridge. Throws (does not silently truncate/pad) if `runes.primary`/
 *  `runes.secondary` aren't the wire contract's documented lengths (3 and 2)
 *  — a malformed count here would silently write the WRONG rune page
 *  in-client, which is worse than a caught, user-facing "couldn't build a
 *  rune page" error. Callers (RunesSummonersCard's click handler) catch this
 *  and surface it rather than letting it reach the network call. */
export function buildRuneApplyBody(championName: string, roleLabel: string, runes: RunesBlock): RuneApplyBody {
  const selectedPerkIds = [
    runes.keystone.id,
    ...runes.primary.map((p) => p.id),
    ...runes.secondary.map((p) => p.id),
    runes.shards.offense.id,
    runes.shards.flex.id,
    runes.shards.defense.id,
  ];

  if (selectedPerkIds.length !== EXPECTED_PERK_COUNT) {
    throw new Error(
      `buildRuneApplyBody: expected ${EXPECTED_PERK_COUNT} perk ids, got ${selectedPerkIds.length} ` +
        `(primary=${runes.primary.length}, secondary=${runes.secondary.length})`
    );
  }

  return {
    name: `CoachBuild ${championName} ${roleLabel}`,
    primaryStyleId: runes.primaryTree.id,
    subStyleId: runes.secondaryTree.id,
    selectedPerkIds,
    current: true,
  };
}
