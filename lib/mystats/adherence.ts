// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/adherence.ts — pure "was this game on the recommended WPA
// build?" check. No I/O — lib/mystats/ingest.ts resolves the recommendation
// (via the existing recommend pipeline) and the match's own extracted items/
// keystone, then hands both here.
//
// DISPLAY ONLY (hard rule, ratified 2026-07-21 for every My Stats field — see
// app/api/mystats/summary/route.ts's doc comment): the boolean this produces
// never feeds any score/ranking anywhere in the app.
//
// THRESHOLDS (brief-specified, documented here since there's no other home
// for the "why 2 items" rationale):
//  - Keystone must match EXACTLY. A build with the wrong keystone is a
//    different playstyle, not a partial match on this axis.
//  - Core items: >= 2 of the recommended CORE items (the top-pick's 3-item
//    legendary path — see ingest.ts's resolveRecommendedBuild) must appear
//    among the match's own final item slots. Exact-3 is too strict (a
//    genuinely on-build game can still swap the 3rd/situational slot for a
//    matchup-specific pick); >=1 is too loose (barely more than chance for a
//    3-item recommended set against a 6-slot final build). 2-of-3 is the
//    smallest threshold that still requires the CORE of the build, not just
//    one incidental shared item.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdherenceInput {
  /** The match's own final item ids (all 6 build slots; trinket excluded —
   *  see the migration's column comment). Riot's empty-slot sentinel (0)
   *  simply never matches a real recommended item id, so no filtering is
   *  needed here. */
  matchItemIds: number[];
  /** The match's own primary-tree keystone rune id, or null when unresolved
   *  (missing/malformed perks — shouldn't happen on a real match-v5 row). */
  matchKeystone: number | null;
  /** The top-pick recommendation's core item ids (items.first/second/third),
   *  or [] when no recommendation was available at all. */
  recommendedCoreItemIds: number[];
  /** The top-pick recommendation's keystone id, or null when no
   *  recommendation was available. */
  recommendedKeystoneId: number | null;
}

/** Minimum number of the recommended core items that must appear in the
 *  match's final items — see this file's header for why 2 (of 3). */
export const ADHERENCE_MIN_CORE_ITEM_HITS = 2;

/**
 * `null` = recommendation unavailable (nothing to compare against — see
 * lib/mystats/ingest.ts's header for every reason this can happen: unresolved
 * role, no coachless data for that champ/role/patch, or the match's own patch
 * isn't today's live patch). Distinct from `false`, which means a real
 * comparison WAS made and this game simply wasn't on the recommended build.
 */
export function computeAdherence(input: AdherenceInput): boolean | null {
  if (input.recommendedKeystoneId === null || input.recommendedCoreItemIds.length === 0) {
    return null;
  }
  const keystoneMatch =
    input.matchKeystone !== null && input.matchKeystone === input.recommendedKeystoneId;
  const coreHits = input.recommendedCoreItemIds.filter((id) => input.matchItemIds.includes(id)).length;
  return keystoneMatch && coreHits >= ADHERENCE_MIN_CORE_ITEM_HITS;
}
