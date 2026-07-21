"use client";

import { IconWithFallback } from "@/components/IconWithFallback";
import type { DraftConfidence, PersonalRecord } from "@/components/live/draftRecommend";
import { buildPersonalBadgeModel } from "@/components/live/personalBadge";

interface DraftResultRowProps {
  rank: number;
  championName: string;
  championIcon: string;
  /** score/winVsLaneOpp are 0-1 fractions (lib/draft/score.ts's own scale,
   *  plan §3) — this component owns the ×100 display formatting so no
   *  caller re-derives it inconsistently. For variant="ban", `scoreFraction`
   *  is NOT a winrate (see BAN_SCORE_BAR_CEILING's doc comment) and is never
   *  rendered as a percentage. */
  scoreFraction: number;
  winVsLaneOppFraction: number | null;
  confidence: DraftConfidence;
  /** Null when there's genuinely no sample to report (e.g. a ban target
   *  with no matchup row against the hovered champion) — never a
   *  fabricated 0 (audit P2-2). */
  minGames: number | null;
  /** Bans don't have a "vs lane opponent" comparison of their own (the
   *  score IS already computed against the hovered champion) — hides that
   *  second stat line rather than showing a redundant duplicate number. */
  variant?: "play" | "ban";
  /** My Stats decoration (2026-07-21) — omitted entirely for bans (personal
   *  records are only decorated onto PLAY candidates server-side, see
   *  lib/draft/recommend.ts's PersonalPlayResult). Absent/undefined renders
   *  no badge at all, same as a row with genuinely zero personal games —
   *  see components/live/personalBadge.ts's no-clutter rule. */
  personal?: PersonalRecord | null;
  personalOverall?: PersonalRecord;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** AUDIT P2-3 (2026-07-21): a ban's `score` is a priority MAGNITUDE
 *  (max(0, disadvantage) * presence — see lib/draft/score.ts's rankBans),
 *  not a winrate — observed live range is roughly 0.02-0.07. Rendering it
 *  as pct() in the same green "text-good" style as a play's winrate
 *  reads as a fabricated "2-7% winrate," which is meaningless and
 *  misleading. Bans instead get a relative priority BAR (width scaled
 *  against this ceiling, clamped at 100%) + the raw score as small muted
 *  subtext — never a percentage, never green. 0.12 is roughly 2x the
 *  highest score observed in live data, giving headroom before any real
 *  score visually maxes out the bar. */
const BAN_SCORE_BAR_CEILING = 0.12;

/** Rank row for both the PLAY and BAN result lists — same compact icon +
 *  name + right-aligned stat visual language as hextech/MoverRow.tsx, so
 *  /draft reads as part of the same Hextech shell rather than a bolted-on
 *  surface. */
export default function DraftResultRow({
  rank,
  championName,
  championIcon,
  scoreFraction,
  winVsLaneOppFraction,
  confidence,
  minGames,
  variant = "play",
  personal,
  personalOverall,
}: DraftResultRowProps) {
  const personalBadge =
    variant === "play" && personalOverall !== undefined ? buildPersonalBadgeModel(personal ?? null, personalOverall) : null;

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0">
      <span className="w-5 text-[11px] text-mut font-bold tabular-nums text-center flex-shrink-0" aria-hidden="true">
        {rank}
      </span>
      <span className="w-9 h-9 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={championIcon}
          alt={championName}
          fallbackGlyph={championName}
          className="w-full h-full object-cover"
          size={36}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-txt font-semibold truncate">{championName}</span>
          {confidence === "low" && (
            <span className="text-[9px] tracking-[0.06em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-mut border border-line flex-shrink-0">
              Low sample
            </span>
          )}
        </div>
        <div className="text-[10.5px] text-mut tabular-nums mt-0.5">n={minGames ?? "—"}</div>
      </div>

      {variant === "ban" ? (
        <div className="text-right flex-shrink-0 w-16" title={`Ban priority score: ${scoreFraction.toFixed(3)}`}>
          <div className="h-1.5 w-full rounded-full bg-panel2 overflow-hidden">
            <div
              className="h-full rounded-full bg-teal"
              style={{ width: `${Math.min(100, Math.max(0, (scoreFraction / BAN_SCORE_BAR_CEILING) * 100))}%` }}
            />
          </div>
          <div className="text-[10px] text-mut tabular-nums mt-1">priority {scoreFraction.toFixed(3)}</div>
        </div>
      ) : (
        <div className="text-right flex-shrink-0">
          <div className="text-[13.5px] font-bold tabular-nums text-good">{pct(scoreFraction)}</div>
          {winVsLaneOppFraction !== null && (
            <div className="text-[10px] text-mut tabular-nums mt-0.5">{pct(winVsLaneOppFraction)} vs lane opp</div>
          )}
          {personalBadge && (
            <div className="flex flex-col items-end gap-0.5 mt-1">
              {personalBadge.vsLabel && (
                <span
                  title={personalBadge.tooltip}
                  className="inline-block rounded border border-line-gold bg-panel2 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-mut whitespace-nowrap"
                >
                  {personalBadge.vsLabel}
                </span>
              )}
              {personalBadge.overallLabel && (
                <span
                  title={personalBadge.tooltip}
                  className="inline-block rounded border border-line bg-panel2 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-mut whitespace-nowrap"
                >
                  {personalBadge.overallLabel}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
