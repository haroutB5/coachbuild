// ─────────────────────────────────────────────────────────────────────────────
// supportFinalGroup.ts — the support-quest FINAL item FAMILY as a mutually-
// exclusive group, and the "top one wins, the rest are alternatives" collapse.
//
// ── The bug this exists to close (user-reported, screenshot-confirmed) ──────
// Pro Consensus's ITEMS grid rendered Zaz'Zak's Realmspike 80% AND Solstice
// Sleigh 20% side by side. Both are support-quest finals. A player can hold
// exactly ONE of the five — Bounty of Worlds (3867) has
// `into: [3869,3870,3871,3876,3877]` and upgrades into precisely one of them
// (verified against a live 16.13.1 item.json pull, 2026-07-26, same coachless
// CDN mirror itemDetail.ts reads). So a grid showing two of them is not
// showing two build choices a pro made together; it is showing ONE choice
// split across a sample, while burning two of six item slots and pushing a
// real item out.
//
// Structurally identical to the v0.28.0 boots carve-out (a split boots
// preference eating two slots) — same fix shape: partition the family OUT of
// the main `items` list into its own field, render it as ONE slot with the
// runners-up stacked under the top pick. This module is the pure, testable
// half of that: membership + ranking, no rendering, no aggregation.
//
// ── Why the ids come from supportItem.ts and are NOT re-declared here ───────
// `SUPPORT_FINAL_ITEMS` (components/hextech/supportItem.ts) is already the
// single source of truth for the five ids, complete with the live-verified
// upgrade-tree derivation in that module's header. This module imports it.
// The dependency runs one way only (supportFinalGroup -> supportItem, never
// back), so there is no cycle; supportItem.ts keeps its own private
// `ALL_FINAL_IDS` untouched. Re-verify the ids each patch the way that
// module's header describes — a specialRecipe/into/from re-pull.
//
// ── Why this is its OWN module and not part of supportItem.ts ──────────────
// supportItem.ts is the BUILD-page archetype resolver: it pulls in
// `lib/draft/compRatings` and `components/proAssets` to answer "which final
// SHOULD this champion upgrade to." That is a judgment call over champion
// kits. This module answers a different, purely mechanical question — "which
// of these already-COUNTED ids belong to the same mutually-exclusive family,
// and which one did the sample actually pick most" — over data that is
// already measured. proConsensus.ts (a pure frequency aggregator) needs the
// second and has no business importing the first.
// ─────────────────────────────────────────────────────────────────────────────

import { SUPPORT_FINAL_ITEMS } from "./supportItem";

/** The five mutually-exclusive support-quest finals. Derived from
 *  `SUPPORT_FINAL_ITEMS`, never re-declared — see the module header. */
export const SUPPORT_FINAL_ITEM_IDS: ReadonlySet<number> = new Set<number>(
  Object.values(SUPPORT_FINAL_ITEMS).map((i) => i.id)
);

/** Family membership test — "is this id one of the five items a player can
 *  only ever own one of." Deliberately id-only: unlike `isBuildItem`, this
 *  needs NO ddragon metadata, because the family is a closed, known set
 *  rather than something inferred from a recipe tree. That also means it
 *  cannot silently degrade when an item-metadata fetch fails (the failure
 *  mode `isBootsTag` has to guard against). */
export function isSupportFinalItem(itemId: number): boolean {
  return SUPPORT_FINAL_ITEM_IDS.has(itemId);
}

/** The minimum an entry must carry to be ranked here — structurally the same
 *  prefix as `ItemFrequency` (proConsensus.ts), so that type satisfies it
 *  without any adapter. Generic rather than hardcoded to `ItemFrequency` so
 *  this module never has to import the aggregation it serves. */
export interface SupportFinalRankable {
  itemId: number;
  count: number;
}

/** The collapse result: the family occupies ONE slot, and that slot has a
 *  primary pick plus the runners-up it beat.
 *
 *  `alternatives` are the OTHER finals the sample actually observed — real,
 *  separately-counted picks, kept as their own entries with their own counts.
 *  They are NEVER merged with `top` into a combined "the family was built
 *  X% of the time" stat: that number would describe a choice nobody made,
 *  and this data path's whole posture is "never assume, never invent." */
export interface SupportFinalRanking<T extends SupportFinalRankable> {
  top: T;
  alternatives: T[];
}

/** Collapses a mixed list of item entries down to the support-final family,
 *  ranked. Pure, total, and order-independent.
 *
 *  Contract:
 *   - Filters `entries` to family members (`isSupportFinalItem`). Non-family
 *     ids are ignored, never returned — the caller keeps them.
 *   - Re-sorts the survivors itself: count DESC, then itemId ASC. The
 *     deterministic itemId tie-break matches every other ranking in this data
 *     path (proConsensus.ts's `sortEntries`), so a two-way 50/50 split always
 *     renders the same way instead of following Map insertion order. Sorting
 *     here rather than trusting the caller's order means a caller that hands
 *     over an unsorted list still gets a correct answer.
 *   - Returns `null` — not an empty object — when the sample contains NO
 *     family member. Null is what makes "absent, not empty" expressible at
 *     the call site: a champion who never built a support final renders no
 *     slot at all, the same convention `boots`/`starters` already use.
 *   - Does NOT mutate `entries`.
 *   - Applies no display cap. A cap is a rendering decision and belongs with
 *     the other display limits (proConsensus.ts's TOP_* constants), not in
 *     the logic that decides what the sample actually contained. */
export function rankSupportFinals<T extends SupportFinalRankable>(
  entries: readonly T[]
): SupportFinalRanking<T> | null {
  const family = entries
    .filter((e) => isSupportFinalItem(e.itemId))
    .slice()
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.itemId - b.itemId));
  if (family.length === 0) return null;
  return { top: family[0], alternatives: family.slice(1) };
}
