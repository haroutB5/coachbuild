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
import { isKeystoneOf, primaryMinorRow, SHARD_ROWS } from "./perkSlots";

export interface RuneApplyBody {
  name: string;
  primaryStyleId: number;
  subStyleId: number;
  /** keystone, 3 primary, 2 secondary, then shards offense -> flex ->
   *  defense — always exactly 9, matching the LCU POST /lol-perks/v1/pages
   *  selectedPerkIds contract (plan §1 / research §A). */
  selectedPerkIds: number[];
  current: true;
  /** Champ-scoped (NOT champ+role-scoped) stale-removal prefix for the
   *  companion's /apply-runes handler (companion 1.6.3+). Mirrors the
   *  item-sets side's own `replacePrefix` (itemSetBody.ts's
   *  champScopedReplacePrefix): `"CoachBuild <champ> "` — the trailing space
   *  is load-bearing (stops `"CoachBuild Vi "` from also matching
   *  `"CoachBuild Viktor …"`). The companion uses it to delete OUR OWN rune
   *  pages for OTHER champions on a champ change while keeping ALL of the
   *  current champion's pages — the WPA page (`"CoachBuild <champ> <role>"`),
   *  the Pro page (`"CoachBuild <champ> <role> Pro"`) and the OTP page
   *  (`"CoachBuild <champ> <role> OTP"`), which all start with this prefix.
   *  Deliberately champ-only (not role- or variant-scoped) so a champ change
   *  catches every variant page. See public/companion.ps1's
   *  Invoke-ApplyRunes. */
  replacePrefix: string;
}

const EXPECTED_PERK_COUNT = 9;

/** Options for the three rune-page variants that share this builder:
 *  - WPA recommendation (RunesSummonersCard / auto-export) — no `pageSuffix`,
 *    title `"CoachBuild <champ> <role>"`.
 *  - Pro consensus (ProConsensusCard's "Apply pro runes") — `pageSuffix:"Pro"`,
 *    title `"CoachBuild <champ> <role> Pro"`.
 *  - OTP consensus (the OTP card's "Apply OTP runes", web v0.70.1) —
 *    `pageSuffix:"OTP"`, title `"CoachBuild <champ> <role> OTP"`.
 *  The three titles are DELIBERATELY distinct so the companion writes them to
 *  three separate LCU rune pages that coexist — before this, the WPA and Pro
 *  variants used the same `"CoachBuild <champ> <role>"` title, so the WPA
 *  auto-export and the manual pro apply fought over ONE physical page (any WPA
 *  re-apply reverted the pro runes the user just applied). The suffix goes AFTER champ/role so ALL
 *  titles still start with the champ-scoped `replacePrefix` (`"CoachBuild
 *  <champ> "`) and the companion's champ-change stale-cleanup catches every variant. */
export interface RuneApplyBodyOptions {
  /** Appended after `"CoachBuild <champ> <role>"` (space-separated) to name a
   *  distinct variant page — e.g. `"Pro"` -> `"CoachBuild <champ> <role> Pro"`.
   *  Omit/empty for the default WPA page. */
  pageSuffix?: string;
}

/** Builds the exact JSON body companionClient.applyRunes() POSTs to the
 *  bridge. Throws (does not silently truncate/pad) if `runes.primary`/
 *  `runes.secondary` aren't the wire contract's documented lengths (3 and 2)
 *  — a malformed count here would silently write the WRONG rune page
 *  in-client, which is worse than a caught, user-facing "couldn't build a
 *  rune page" error. Callers (RunesSummonersCard's click handler) catch this
 *  and surface it rather than letting it reach the network call. */
export function buildRuneApplyBody(
  championName: string,
  roleLabel: string,
  runes: RunesBlock,
  opts: RuneApplyBodyOptions = {}
): RuneApplyBody {
  const selectedPerkIds = [
    runes.keystone.id,
    ...runes.primary.map((p) => p.id),
    ...runes.secondary.map((p) => p.id),
    runes.shards.offense.id,
    runes.shards.flex.id,
    runes.shards.defense.id,
  ];

  if (selectedPerkIds.length !== EXPECTED_PERK_COUNT || runes.primary.length !== 3 || runes.secondary.length !== 2) {
    throw new Error(
      `buildRuneApplyBody: expected ${EXPECTED_PERK_COUNT} perk ids, got ${selectedPerkIds.length} ` +
        `(primary=${runes.primary.length}, secondary=${runes.secondary.length})`
    );
  }

  const primaryTree = runes.primaryTree.id;
  const secondaryTree = runes.secondaryTree.id;
  const secondaryRows = runes.secondary.map((p) => primaryMinorRow(secondaryTree, p.id));
  if (
    primaryTree === secondaryTree ||
    !isKeystoneOf(primaryTree, runes.keystone.id) ||
    runes.primary.some((p, index) => primaryMinorRow(primaryTree, p.id) !== index) ||
    secondaryRows.some((row) => row === null) ||
    new Set(secondaryRows).size !== 2 ||
    selectedPerkIds.slice(6).some((id, index) => !SHARD_ROWS[index].includes(id))
  ) {
    throw new Error("buildRuneApplyBody: invalid rune tree or slot selection");
  }

  const baseName = `CoachBuild ${championName} ${roleLabel}`;
  const suffix = opts.pageSuffix?.trim();
  return {
    name: suffix ? `${baseName} ${suffix}` : baseName,
    primaryStyleId: runes.primaryTree.id,
    subStyleId: runes.secondaryTree.id,
    selectedPerkIds,
    current: true,
    // Champ-scoped, NOT role- or variant-scoped — see RuneApplyBody.replacePrefix.
    // Kept identical for the WPA, Pro and OTP variants of the same champion so the
    // companion protects every variant page and only prunes OTHER champions' pages.
    replacePrefix: `CoachBuild ${championName} `,
  };
}
