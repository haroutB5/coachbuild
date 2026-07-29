// ─────────────────────────────────────────────────────────────────────────────
// altKeystone.ts — "the keystone we did NOT pick"
//
// Pure helper (no JSX, so a plain .ts vitest file can import it — same
// constraint runesPage.ts / StatBadge.ts document).
//
// WHY THIS EXISTS
// ───────────────
// lib/recommend.ts returns the top 3 viable setups and its header states the
// contract: "Variants prefer different primary trees." The engine's entire
// design for "a genuinely different keystone exists" is *put it in a later
// variant*. v0.51.0 collapsed the Builds page to `data[0]` and deleted that
// consumer while the engine kept relying on it, so the escape hatch has been
// computed-and-discarded on every request since.
//
// Measured consequence (live sweep, patch 16.13, tiers [5,6,7], the 500
// champion/role pairs with >=2,000 games — INVESTIGATION-ziggs-wpa.md §B and
// re-run here): 83 pairs, 16.6%, display a NEGATIVE-WPA keystone while a
// positive, adoption-cleared alternative sits in an unrendered variant.
//
// WHAT THIS IS NOT
// ────────────────
// It does not re-rank anything. `builds[0]` remains the recommendation on every
// card, unconditionally. This module only answers "is there a withheld keystone
// worth telling the user about", and the UI presents it as an exception, never
// as a second recommendation.
//
// ── THE TRIGGER PREDICATE, AND WHY ───────────────────────────────────────────
//
// Fires iff ALL of:
//   (1) the shown keystone's WPA is  < 0
//   (2) the alternative's WPA is     > 0
//   (3) the gap between them is      > ALT_KEYSTONE_MIN_GAP (0.04)
//   (4) the alternative cleared the engine's own adoption bar (!lowSample)
//
// (1)+(2) make the trigger a SIGN FLIP, and that is the load-bearing choice.
// Coachless's per-rune WPA figures are marginal contributions measured inside
// their own rune pages, not independent terms on a shared scale — so "+2.50 is
// 2.77 better than -0.27" is not a statement the data supports, and any
// predicate keyed on gap SIZE would be quietly asserting it. Which side of zero
// a reading falls on survives that caveat: it is a property of the one number,
// not a comparison between two. So the card can honestly say "this one is above
// zero, the pick is below" and stop there.
//
// It also keeps the surface an exception rather than furniture. Measured over
// the same 500 pairs:
//
//     alt.wpa > shown.wpa (bare)                       146  29.2%
//     alt.wpa > 0 AND gap > 0.04                       144  28.8%
//     shown renders red AND alt renders green           78  15.6%
//     SIGN FLIP + gap > 0.04            <-- chosen      83  16.6%
//
// The 29% predicates fire on cases like Amumu SUP (+0.376 shown, +0.416
// alternative on 1,022 games) where the pick is already good and the difference
// is not decision-relevant — a permanent second block on a third of all cards
// during a 30-second champ select. The "renders red" variant (shown < -0.02, the
// wpaClass red cutoff) is a strict SUBSET of the chosen one (measured: zero
// cases fire it that the sign flip does not) and it drops Caitlyn BOT, whose
// -0.011 sits in wpaClass's neutral-grey dead zone while a +0.807 First Strike
// on 65,776 games goes unrendered. That is a real case to show and a bad one to
// lose, so the trigger keys on the SIGN of the number, not the colour it prints.
//
// (3) is a DISPLAY-INTEGRITY guard, not a filter. wpaText rounds to 2 decimals,
// so two readings within 0.01 print identically; a card claiming one is the
// higher of the two while showing the same string twice is a visible lie. A gap
// wider than the neutral dead zone is wide (+/-0.02) makes that unreachable.
// Measured: it excludes ZERO of today's 83 cases (E and F both return 83) — it
// exists for the day the data produces a hairline flip, not to shape the set.
//
// (4) is likewise defensive. `pickRecommended` only ever selects a keystone out
// of `adopted` (occurrence >= the adoption bar), so every variant keystone
// clears the bar BY CONSTRUCTION and `lowSample` is false. Verified, not
// assumed: swept all 319 pairs that have a distinct alternative keystone, zero
// below the bar. It is checked anyway because the card makes an adoption claim
// in its copy, and a claim should rest on a check rather than on an invariant
// two modules away.
//
// ── WHY IT SCANS EVERY VARIANT, NOT builds[1] ────────────────────────────────
//
// This is the part that is easy to get wrong, and the obvious implementation
// IS wrong. `primaryConfigs` is ordered by raw tree adoption, so `builds[1]` is
// the SECOND-MOST-PLAYED tree — which has no relationship to which withheld
// keystone is the best one.
//
// JHIN BOT, run through the real buildRecommendations (2026-07-29):
//     [0] Fleet Footwork   (Precision)     wpa -0.272   387,410 games
//     [1] Dark Harvest     (Domination)    wpa -0.725   131,012 games   <-- WORSE
//     [2] Deathfire Touch  (Sorcery)       wpa +2.500    81,053 games   <-- the one
//
// A `builds[1]`-only read finds -0.725 on the app's single most extreme case and
// correctly shows nothing, hiding +2.500 exactly as before the fix. Measured
// across the 83 firing pairs: in 11 of them the best alternative is NOT in
// `builds[1]`, and in 5 of those `builds[1]` is worse than what is already
// shown (Jhin BOT, Malphite SUP, Rumble JG, Teemo MID, Ambessa TOP).
//
// So: scan every later variant, take the best WPA among those that qualify.
//
// ── WHY IT DEDUPES ON KEYSTONE ID ────────────────────────────────────────────
//
// `buildRecommendations` fills its 3 pages from distinct primary trees FIRST and
// falls back to secondary-tree variations of the top config when fewer than 3
// trees are viable. Those filler pages carry variant #1's OWN keystone. Observed
// on Ziggs BOT [2], Caitlyn BOT [2], Sylas MID [2], Ahri MID [2], Garen TOP [2],
// Lux SUP [2] — six of the nine champions probed. Without the id check the card
// would offer the user the rune it is already showing them.
//
// ── THE bestAboveFloor DEFECT DOES NOT REACH THIS SURFACE ────────────────────
//
// `secondariesFor`'s `bestAboveFloor` falls back to the most-played entry when
// no rune in a row clears `noiseFloor`, defeating its own floor — on Ziggs BOT
// that puts variant #3's Resolve secondary at Bone Plating (322 games) and
// Overgrowth (203) out of 153,475. Surfacing a whole alternative PAGE would put
// those on screen. This module deliberately exposes only the KEYSTONE, its WPA,
// its game count and its tree, all of which come from `pickRecommended` over
// `keystoneData` — a path that never calls `bestAboveFloor`. The defect is
// therefore untouched and unexposed here; see HANDOFF-engy.md for why it was not
// fixed in passing.
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse, Pick, TreeRef } from "@/lib/types";

/** Minimum WPA gap between the shown keystone and the alternative. Wider than
 *  the neutral dead zone in StatBadge's wpaClass (+/-0.02), so the two rendered
 *  2-decimal numbers can never print the same string. */
export const ALT_KEYSTONE_MIN_GAP = 0.04;

export interface AltKeystone {
  /** The withheld keystone, with the engine's own wpa/occurrence/lowSample. */
  keystone: Pick;
  /** The primary tree it belongs to (NOT the shown build's primary tree). */
  tree: TreeRef;
  /** 1-based position in the /api/build response array (2 or 3) — the variant
   *  this keystone was taken from. Diagnostic; the UI does not show it. */
  variantRank: number;
}

/**
 * The best withheld keystone worth surfacing, or null when there is none.
 *
 * Null is the common case (measured 83 of 500 populated champion/role pairs
 * qualify) and the card must render EXACTLY as it did before this feature when
 * it comes back null — no empty slot, no placeholder.
 */
export function resolveAltKeystone(builds: BuildResponse[]): AltKeystone | null {
  if (!Array.isArray(builds) || builds.length < 2) return null;
  const shown = builds[0]?.runes?.keystone;
  if (!shown || typeof shown.wpa !== "number") return null;

  // (1) Only speak up when the displayed keystone is on the negative side.
  if (!(shown.wpa < 0)) return null;

  const candidates: AltKeystone[] = [];
  for (let i = 1; i < builds.length; i++) {
    const runes = builds[i]?.runes;
    const k = runes?.keystone;
    if (!k || typeof k.wpa !== "number") continue;
    // A filler page repeating variant #1's keystone is not an alternative.
    if (k.id === shown.id) continue;
    // (2) positive, (3) outside display rounding, (4) adoption-cleared.
    if (!(k.wpa > 0)) continue;
    if (!(k.wpa - shown.wpa > ALT_KEYSTONE_MIN_GAP)) continue;
    if (k.lowSample) continue;
    candidates.push({ keystone: k, tree: runes.primaryTree, variantRank: i + 1 });
  }
  if (candidates.length === 0) return null;

  // Best WPA wins. Ties break on the larger sample, then on the earlier variant
  // — deterministic ordering matters because two variants can legitimately
  // carry different keystones at the same WPA.
  candidates.sort(
    (a, b) =>
      b.keystone.wpa - a.keystone.wpa ||
      b.keystone.occurrence - a.keystone.occurrence ||
      a.variantRank - b.variantRank
  );
  return candidates[0];
}
