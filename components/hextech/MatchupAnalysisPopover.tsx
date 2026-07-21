"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MatchupAnalysisPopover — inline "MATCHUP ANALYSIS" panel for the resolved
// lane opponent (draft redesign plan §2.3/§5.1/§5.2). Deliberately INLINE,
// not a portal/modal/floating-positioned tooltip — /draft does NOT use
// pushState (see app/draft/page.tsx's own header comment + plan's risk
// register §9: "Back-nav: MATCHUP ANALYSIS popover must be inline, no
// history entry"), so this renders directly in the page flow, tethered to
// its trigger by the `.dt-energy-line` connector (pure CSS, no JS
// measurement/position:fixed — avoids the exact class of overflow-clipped
// hit-area bug a getBoundingClientRect-positioned tooltip risks on a page
// this component-heavy).
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
      <div className="dt-energy-line flex-shrink-0 ml-3.5" aria-hidden="true" />
      <div className="dt-panel dt-chamfer-sm flex-1 p-3.5">
        <p className="text-[10px] tracking-[0.12em] uppercase font-bold text-[color:var(--dt-cyan)] mb-2">
          Matchup analysis — {laneOpponentName}
        </p>

        {!entry || !anySignal ? (
          <p className="text-[11px] text-[color:var(--dt-mut)]">
            {hoverSelected ? "Not enough matchup data yet for this pairing." : "Pick your champion to see your record vs this lane opponent."}
          </p>
        ) : (
          <div className="space-y-2">
            <div>
              <p className="text-[9.5px] uppercase tracking-[0.06em] text-[color:var(--dt-mut)]">Win rate vs you</p>
              {wrLine ? (
                <p className="text-[13px] font-bold tabular-nums text-[color:var(--dt-txt)]">{wrLine}</p>
              ) : (
                <p className="text-[11px] text-[color:var(--dt-mut)]">
                  {hoverSelected ? "No recorded games in this exact matchup yet." : "Pick your champion to see this."}
                </p>
              )}
            </div>

            {entry.laneThreatBand && (
              <div>
                <p className="text-[9.5px] uppercase tracking-[0.06em] text-[color:var(--dt-mut)]">Lane threat</p>
                <p className="text-[12px] font-semibold text-[color:var(--dt-txt)]">
                  {entry.laneThreatBand} <span className="text-[10px] font-normal text-[color:var(--dt-mut)]">(derived from matchup record)</span>
                </p>
              </div>
            )}

            {entry.suggestedDefense && (
              <div>
                <p className="text-[9.5px] uppercase tracking-[0.06em] text-[color:var(--dt-mut)]">Suggested defense</p>
                <p className="text-[12px] font-semibold text-[color:var(--dt-txt)]">{entry.suggestedDefense.label}</p>
                <p className="text-[10px] text-[color:var(--dt-mut)]">
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
