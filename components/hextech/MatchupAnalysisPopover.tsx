"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MatchupAnalysisPopover — inline "MATCHUP ANALYSIS" panel for the resolved
// lane opponent (draft redesign, mockup 3). Deliberately INLINE, not a
// portal/modal/floating-positioned tooltip — /draft does NOT use pushState
// (see app/draft/page.tsx's own header comment: "Back-nav: MATCHUP ANALYSIS
// popover must be inline, no history entry"), so this renders directly in
// the page flow.
//
// v0.51.0: rethemed from the retired cyan `.draft-tactical`/`.dt-*` HUD
// (including its `.dt-energy-line` tether) to the app-wide navy/gold tokens —
// a simple left border tether instead of the dedicated connector class.
// ─────────────────────────────────────────────────────────────────────────────

import { findLaneOpponentAnalysis, winRateVsYouLine, hasAnyMatchupSignal, type EnemyAnalysis } from "./matchupAnalysis";

interface MatchupAnalysisPopoverProps {
  enemyAnalysis: EnemyAnalysis[] | undefined | null;
  laneOpponentId: number | null;
  laneOpponentName: string;
  hoverSelected: boolean;
}

export default function MatchupAnalysisPopover({
  enemyAnalysis,
  laneOpponentId,
  laneOpponentName,
  hoverSelected,
}: MatchupAnalysisPopoverProps) {
  const entry = findLaneOpponentAnalysis(enemyAnalysis, laneOpponentId);

  const wrLine = entry ? winRateVsYouLine(entry) : null;
  const anySignal = entry ? hasAnyMatchupSignal(entry) : false;

  return (
    <div className="flex gap-3 mt-2">
      <div className="w-0.5 flex-shrink-0 ml-3.5 rounded-full bg-gradient-to-b from-teal to-transparent" aria-hidden="true" />
      <div className="bg-panel2 border border-line-gold rounded-lg flex-1 p-3.5">
        <p className="text-[10px] tracking-[0.12em] uppercase font-bold text-teal mb-2">
          Matchup analysis — {laneOpponentName}
        </p>

        {!entry || !anySignal ? (
          <p className="text-[11px] text-mut">
            {hoverSelected ? "Not enough matchup data yet for this pairing." : "Pick your champion to see your record vs this lane opponent."}
          </p>
        ) : (
          <div className="space-y-2">
            <div>
              <p className="text-[9.5px] uppercase tracking-[0.06em] text-mut">Win rate vs you</p>
              {wrLine ? (
                <p className="text-[13px] font-bold tabular-nums text-txt">{wrLine}</p>
              ) : (
                <p className="text-[11px] text-mut">
                  {hoverSelected ? "No recorded games in this exact matchup yet." : "Pick your champion to see this."}
                </p>
              )}
            </div>

            {entry.laneThreatBand && (
              <div>
                <p className="text-[9.5px] uppercase tracking-[0.06em] text-mut">Lane threat</p>
                <p className="text-[12px] font-semibold text-txt">
                  {entry.laneThreatBand} <span className="text-[10px] font-normal text-mut">(derived from matchup record)</span>
                </p>
              </div>
            )}

            {entry.suggestedDefense && (
              <div>
                <p className="text-[9.5px] uppercase tracking-[0.06em] text-mut">Suggested defense</p>
                <p className="text-[12px] font-semibold text-txt">{entry.suggestedDefense.label}</p>
                <p className="text-[10px] text-mut">
                  {entry.suggestedDefense.reason} (derived from their damage type)
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
