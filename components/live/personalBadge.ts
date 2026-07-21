// ─────────────────────────────────────────────────────────────────────────────
// components/live/personalBadge.ts — pure render-model + list filter for the
// Draft page's "My Stats" personal-record badges (My Stats backend, 2026-07-21
// — see draftRecommend.ts's PersonalRecord doc comment for the wire shape).
//
// HARD USER DIRECTIVE (ratified 2026-07-21, "Don't mix my data with the
// sample size"): personal record data is DISPLAY-ONLY. Neither function here
// touches `score` or reorders anything by outcome:
//   - buildPersonalBadgeModel only formats text: never returns anything that
//     influences which row renders first.
//   - filterToMyPool is a FILTER, never a re-scorer — Array.prototype.filter
//     preserves the relative order of surviving elements, so a caller that
//     already has a score-ranked list gets back the same ranking, just with
//     some rows removed.
// Kept JSX-free (plain .ts, not .tsx) so it's directly unit-testable without
// a DOM harness — same convention as runesPage.ts / StatBadge.tsx's exported
// helpers (see those files' header comments).
// ─────────────────────────────────────────────────────────────────────────────

import type { PersonalRecord } from "./draftRecommend";

export interface PersonalBadgeModel {
  /** "you: 8-3" — my record vs the resolved lane opponent specifically.
   *  Null when there's nothing to show (no lane opponent resolved, or
   *  resolved but I've never played that exact matchup). */
  vsLabel: string | null;
  /** "you: 25W-14L overall" — my record on this champion in this lane vs
   *  ANY opponent. Null only when I've genuinely never played it (0 games)
   *  — the whole badge is suppressed in that case (see below), so in
   *  practice a non-null model always has at least one of these two set. */
  overallLabel: string | null;
  /** Shared a11y/tooltip text for both lines — always the same directive
   *  regardless of which line(s) are present. */
  tooltip: string;
}

const TOOLTIP = "Your Season 2026 record — shown for context, never affects ranking";

/** Null (no badge at all — no clutter on a row with nothing to show) when
 *  both `personal` (or its absence) and `personalOverall` have zero games.
 *  Otherwise populates whichever of the two lines has real data; the other
 *  degrades to null rather than a fabricated "0-0". */
export function buildPersonalBadgeModel(personal: PersonalRecord | null, personalOverall: PersonalRecord): PersonalBadgeModel | null {
  const hasVs = personal !== null && personal.games > 0;
  const hasOverall = personalOverall.games > 0;
  if (!hasVs && !hasOverall) return null;

  return {
    vsLabel: hasVs ? `you: ${personal!.wins}-${personal!.games - personal!.wins}` : null,
    overallLabel: hasOverall ? `you: ${personalOverall.wins}W-${personalOverall.games - personalOverall.wins}L overall` : null,
    tooltip: TOOLTIP,
  };
}

/** "My pool" filter (app/draft/page.tsx toggle) — keeps only candidates I've
 *  played at least once in this lane (personalOverall.games >= 1), in the
 *  SAME order the input arrived in. Generic over any shape carrying
 *  `personalOverall` so it works identically for `plays` and
 *  `potentialPlays` without duplicating the function. */
export function filterToMyPool<T extends { personalOverall: PersonalRecord }>(items: T[]): T[] {
  return items.filter((item) => item.personalOverall.games >= 1);
}
