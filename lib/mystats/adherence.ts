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

// ─────────────────────────────────────────────────────────────────────────────
// WHY IS on_wpa_build NULL? (2026-07-31 audit P2 fix, #4 — "build not
// recorded" everywhere, misattributed.)
//
// lib/mystats/ingest.ts's resolveRecommendedBuild gates resolution on
// `patch === currentPatchLabel`, where currentPatchLabel comes from
// lib/staticData.ts's getLatestPatch() -- which does NOT resolve to
// "whatever patch the client is live on today," despite its name and this
// file's own prior assumption. It resolves to the newest patch coachless
// actually has DATA for (it probes candidates newest-first and returns the
// first with a populated response) -- see getLatestPatch's doc comment.
// Ddragon (and therefore every real match's own `patch` column) can be, and
// regularly is, ahead of that: live-probed 2026-07-31, ddragon's newest was
// 16.15 while coachless had nothing past 16.13 (16.15 -> [], 16.14 -> 403).
// Every match played on 16.15 therefore got on_wpa_build: null for a reason
// that has NOTHING to do with that match or that champion -- coachless
// simply hasn't caught up to the patch yet -- but the UI's only null copy
// ("build not recorded") reads as if the app failed to record THIS game,
// which is a different and wrong claim.
//
// THE FIX IS DELIBERATELY NOT a resolution change. Comparing a 16.15 match
// against 16.13's recommendation would be exactly the fabricated cross-patch
// data lib/mystats/ingest.ts's header already refuses to produce (HARD RULE
// 4) -- on_wpa_build stays null, unchanged, for both causes below. This is a
// READ-TIME classification of an already-null value, so the copy can tell the
// user WHICH kind of null they're looking at, nothing more.
//
// resolveRecommendedBuild's OWN two null-without-even-trying causes map onto
// exactly two answers here:
//  - role outside 0-4 (ARAM/remake, no per-role recommendation exists at
//    all) -> genuinely unresolvable, "not-recorded" stays honest.
//  - patch mismatch -> ambiguous on its own (ingest.ts's gate fires the same
//    way whether the match is NEWER than the populated patch (upstream lag,
//    "waiting-for-patch-data") or OLDER (a real historical patch this
//    feature deliberately doesn't have a cross-patch override for -- see
//    that file's header -- "not-recorded" is still the honest label there,
//    since there IS no comparison to describe as pending). The NEWER case is
//    the one this fix targets: it is upstream data lag, not the user's
//    history, and saying so is the whole point.
// A third cause (patch matches, but buildRecommendations itself threw
// NotPlayedInRoleError for a genuinely off-meta champ/role) is
// indistinguishable from the historical-patch case at this read-time layer
// with the data available, and both correctly fall through to
// "not-recorded" -- a real "no comparison exists for this exact combo," not
// a lie either way.
// ─────────────────────────────────────────────────────────────────────────────

/** "16.15" -> {major:16, minor:15}. Null on anything that doesn't parse as
 *  at least two dot-separated integers (matches this app's patch-label
 *  convention everywhere else -- see lib/draft/patch.ts's patchSegment for
 *  the sibling "only the first two segments matter" convention). */
function parsePatchLabel(label: string): { major: number; minor: number } | null {
  const parts = label.split(".");
  if (parts.length < 2) return null;
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/** 1 if `a` is a newer patch than `b`, -1 if older, 0 if equal OR either
 *  label fails to parse (an unparseable label is "can't tell," never a false
 *  claim in either direction). Numeric major.minor comparison, NOT lexical
 *  string comparison -- "16.9" < "16.14" would misorder as a plain string
 *  (see lib/draft/ingest.ts's pruneOldPatches for the same trap already
 *  documented once in this codebase). */
export function comparePatchLabels(a: string, b: string): number {
  const pa = parsePatchLabel(a);
  const pb = parsePatchLabel(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  return 0;
}

/** True exactly when an already-null on_wpa_build should read "waiting for
 *  patch data" instead of "build not recorded" -- see this section's header
 *  for the full reasoning. Pure; never mutates `onWpaBuild` and never turns
 *  a non-null value into anything else. */
export function isWaitingForPatchData(input: {
  onWpaBuild: boolean | null;
  /** This game's own role, 0-4 concrete or -1/anything else unresolved. */
  role: number;
  /** This game's own patch label, or null if never stored (pre-migration row). */
  matchPatch: string | null;
  /** The newest patch coachless actually has data for right now --
   *  lib/staticData.ts's getLatestPatch().label, the SAME resolution
   *  lib/mystats/ingest.ts's resolveRecommendedBuild gates on. Null if that
   *  resolution itself failed (degrades to "not-recorded," never a guess). */
  populatedPatch: string | null;
}): boolean {
  if (input.onWpaBuild !== null) return false; // a real comparison was made -- nothing to reclassify
  if (input.role < 0 || input.role > 4) return false; // genuinely unresolvable lane, not a patch-lag question
  if (!input.matchPatch || !input.populatedPatch) return false; // nothing to compare -- stay honestly "not-recorded"
  return comparePatchLabels(input.matchPatch, input.populatedPatch) > 0;
}
