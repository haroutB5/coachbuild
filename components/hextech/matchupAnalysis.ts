// ─────────────────────────────────────────────────────────────────────────────
// matchupAnalysis.ts — pure lookup/formatting for MatchupAnalysisPopover.tsx
// (draft redesign plan §2.3/§4). JSX-free .ts module, same vitest-import
// reason as draftRadarGeom.ts.
//
// `EnemyAnalysis` here is a type ALIAS for engo's landed
// components/live/draftRecommend.ts `DraftEnemyAnalysis` (Stage 0 landed
// mid-ship — this module originally declared a structural-duplicate local
// interface as a defensive stand-in while that file was still in flight;
// now that it's real, importing it directly is strictly better: one
// definition, no risk of silent drift).
// ─────────────────────────────────────────────────────────────────────────────

import type { DraftEnemyAnalysis } from "@/components/live/draftRecommend";

export type EnemyAnalysis = DraftEnemyAnalysis;

/** Finds the analysis entry for the resolved lane opponent (matched by
 *  champId — `isLaneOpponent` is a secondary sanity check, not the primary
 *  key, since the caller already knows WHICH champId it's asking about).
 *  Null when there's no lane opponent resolved, or the array doesn't carry
 *  an entry for it (older cached response / Stage 0 not landed yet — never
 *  crashes, just renders nothing to show). */
export function findLaneOpponentAnalysis(
  enemyAnalysis: EnemyAnalysis[] | undefined | null,
  laneOpponentId: number | null
): EnemyAnalysis | null {
  if (laneOpponentId === null || !Array.isArray(enemyAnalysis)) return null;
  return enemyAnalysis.find((e) => e.champId === laneOpponentId) ?? null;
}

/** "62.0% (n=340)" — null when there's no real record to show (no hover
 *  selected, or genuinely zero games), never a fabricated percentage. */
export function winRateVsYouLine(entry: EnemyAnalysis): string | null {
  if (entry.winRateVsYou === null || entry.winRateVsYouGames === null || entry.winRateVsYouGames <= 0) return null;
  return `${(entry.winRateVsYou * 100).toFixed(1)}% (n=${entry.winRateVsYouGames})`;
}

export function laneThreatLine(entry: EnemyAnalysis): string | null {
  return entry.laneThreatBand;
}

/** True when the popover has genuinely nothing to show for this entry (every
 *  line null) — the caller uses this to render a quiet "not enough data yet"
 *  line instead of an empty-looking panel that could read as broken. */
export function hasAnyMatchupSignal(entry: EnemyAnalysis): boolean {
  return winRateVsYouLine(entry) !== null || entry.laneThreatBand !== null || entry.suggestedDefense !== null;
}
