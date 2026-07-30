"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RecentGamesList — /mystats' "RECENT GAMES" panel. Consumes the v0.51 wave-B
// EXTENDED /api/mystats/summary's `recentGames[]` (engo) — each row's
// `onWpaBuild` is a nullable tri-state (true/false/unknown), not a boolean, so
// an old/unresolved game degrades to "no chip" rather than a fabricated
// "off-build" label.
//
// 2026-07-29 redesign: the panel now leads with RecentGamesChart (shape of the
// run at a glance, one bar per game) and keeps the row list beneath it (the
// detail the chart cannot carry — raw K/D/A, role, the build chip in words).
// Both read the SAME `games` array, so the two can never disagree.
//
// Its heading meta states the window ("last N games") because these rows are a
// short recent slice, NOT the season totals the KPI strip above shows — the two
// denominators must stay visibly different. See RecentGamesChart's header.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import { computeRecentWinLoss, myStatsRoleLabel, type IconLookup } from "@/components/hextech/myStats";
import PanelHeading from "@/components/hextech/PanelHeading";
import RecentGamesChart from "./RecentGamesChart";

export interface RecentGameRow {
  championId: number;
  role: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  /** null/undefined = build-adherence not resolved for this game (old data,
   *  or the pipeline hasn't backfilled it yet) — renders no chip at all. */
  onWpaBuild: boolean | null | undefined;
  /** engy §1c (2026-07-30). Kept structurally identical to
   *  MyStatsRecentGame so the two interfaces stay mutually assignable — see
   *  that type's doc comment. `csPerMin` is deliberately withheld (null) on a
   *  game under 5 minutes while `cs`/`gameDurationSec` survive, so a surface can
   *  still say "12 CS in 3:41" without quoting a meaningless rate. */
  cs: number | null;
  gameDurationSec: number | null;
  csPerMin: number | null;
}

export interface RecentGamesListProps {
  games: RecentGameRow[];
  iconOf: IconLookup;
  /**
   * Render the bar chart above the rows. ON by default so this component is
   * still complete on its own.
   *
   * /mystats passes FALSE as of the 2026-07-30 profile redesign: the chart moved
   * to `MatchPerformancePanel` (the reference's lower-right panel) and both
   * panels stay mounted behind the tab strip, so leaving it on rendered the SAME
   * five bars twice on one page — measured, 10 bars in the DOM where there
   * should be 5. Same data, two charts, one of them redundant.
   */
  showChart?: boolean;
}

function BuildChip({ onWpaBuild }: { onWpaBuild: boolean | null | undefined }) {
  if (onWpaBuild === true) {
    return (
      <span className="flex-shrink-0 text-[9px] font-bold uppercase tracking-[0.05em] px-1.5 py-1 rounded-md bg-teal/15 text-teal border border-teal/30">
        WPA build
      </span>
    );
  }
  if (onWpaBuild === false) {
    return (
      <span className="flex-shrink-0 text-[9px] font-bold uppercase tracking-[0.05em] px-1.5 py-1 rounded-md bg-white/[0.04] text-mut border border-line">
        Off-build
      </span>
    );
  }
  return null;
}

export default function RecentGamesList({ games, iconOf, showChart = true }: RecentGamesListProps) {
  if (games.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-mut text-[12px]">No recent games recorded yet.</p>
      </div>
    );
  }

  // `computeRecentWinLoss` rather than a local filter: its `n` is always the
  // exact length of the window it counted, so the counts can never be rendered
  // apart from the sample that produced them.
  const wl = computeRecentWinLoss(games);

  return (
    <div className="bg-panel border border-line rounded-xl px-4 sm:px-5 pt-4 pb-1">
      <PanelHeading meta={`Last ${wl.n} games · ${wl.wins}W-${wl.losses}L`}>Recent games</PanelHeading>

      {showChart && (
        <div className="pt-4 pb-4 border-b border-line">
          <RecentGamesChart games={games} iconOf={iconOf} />
        </div>
      )}

      {games.map((g, i) => {
        const entry = iconOf(g.championId);
        const name = entry?.name ?? `Champion #${g.championId}`;
        return (
          <div
            key={`${g.championId}-${i}`}
            className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0"
          >
            <span
              className={`w-4 text-center text-[13px] font-extrabold tabular-nums flex-shrink-0 ${
                g.win ? "text-good" : "text-bad"
              }`}
              aria-label={g.win ? "Win" : "Loss"}
            >
              {g.win ? "W" : "L"}
            </span>

            <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback
                src={entry?.icon ?? ""}
                alt=""
                fallbackGlyph={name}
                className="w-full h-full object-cover"
                size={32}
              />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] text-txt font-semibold truncate">{name}</p>
              <p className="text-[10px] text-mut uppercase tracking-[0.05em]">{myStatsRoleLabel(g.role)}</p>
            </div>

            <span className="text-[12px] text-txt tabular-nums flex-shrink-0">
              {g.kills} / {g.deaths} / {g.assists}
            </span>

            <BuildChip onWpaBuild={g.onWpaBuild} />
          </div>
        );
      })}
    </div>
  );
}
