"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MatchPerformancePanel — the reference's lower-RIGHT panel:
// "Match Performance: (Last 20 Games)" with "Last Active: 33 minutes ago" at
// the right, three large KPIs, a right-hand chip cluster, and a 20-bar chart
// with a champion portrait under each bar.
//
// ── WHICH METRIC THE BARS CARRY: KDA. ───────────────────────────────────────
// The choice was between the two per-game numbers we hold, KDA and CS/min, and
// KDA wins on COVERAGE, not on preference. `csPerMin` is null on every row
// ingested before engy's 2026-07-30 CS ship and is deliberately withheld on any
// game under 5 minutes (engy §1c/§2), so a CS/min chart drawn against today's
// real data is a row of gaps. KDA has been stored per row since v0.51 and is
// populated for every game in the window. A chart with holes in it reads as
// broken; a chart of a metric we actually have for every bar does not.
// The axis says so out loud — "Bar height = KDA" — and CS/min is not thrown
// away, it is the panel's second KPI.
//
// Bar heights are NOT computed here. `normalizeKdaBars`
// (components/hextech/myStats.ts) already normalises against a FIXED ceiling of
// 10 rather than the window's own max, precisely so one 0-death stomp cannot
// flatten every other bar toward invisibility. Do not renormalise.
//
// ── WHAT THE REFERENCE HAS HERE THAT THIS DOES NOT ──────────────────────────
// · `Avg Score` — TrackDIFF's proprietary composite. There is no equivalent in
//   this app and inventing one is precisely the defect this page spent a night
//   removing. The third KPI slot holds the window's win rate instead, which is
//   real and is the number the composite is mostly a proxy for anyway.
// · `MVP` / `ACE` chips — derived from a full per-game scoreboard (every
//   participant's damage, gold, KP, objectives). `my_matches` stores champion
//   ids and a win flag for the other nine players and nothing else, on purpose
//   (migration 0012's privacy posture). Uncomputable without changing what this
//   app is willing to store about other people. DROPPED.
// · the per-bar PLACEMENT label ("10th", "4th") — there is no placement in the
//   pipeline. The row beneath each portrait is gone; the champion portrait and
//   the value label above the bar, which the brief asked to keep, both stay.
// · `Avg Game ELO` — not fetched, not stored. DROPPED.
//
// ── DENOMINATORS ────────────────────────────────────────────────────────────
// EVERY figure in this panel is over `games` — the recent window — and the
// heading says how many. The KPI strip above this panel on the page is SEASON
// totals over a different array. The two must never borrow numbers from each
// other (v0.73.1). The one exception is the ranked W-L inside `chips.rank`,
// which is Riot's own split-long tally and is labelled as such.
// ─────────────────────────────────────────────────────────────────────────────

import KpiStrip, { type KpiItem } from "@/components/hextech/KpiStrip";
import PanelHeading from "@/components/hextech/PanelHeading";
import RecentGamesChart from "./RecentGamesChart";
import type { RecentGameRow } from "./RecentGamesList";
import {
  computeAverageKda,
  type IconLookup,
} from "@/components/hextech/myStats";
import {
  csRateIsQuotable,
  formatCsPerMin,
  type MatchPerformanceChips,
} from "./profileModel";

function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "bad" | "accent" | "muted";
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-line bg-white/[0.05] text-txt/85",
    good: "border-good/35 bg-good/12 text-good",
    bad: "border-bad/35 bg-bad/12 text-bad",
    accent: "border-line-gold bg-teal/12 text-teal",
    muted: "border-line bg-white/[0.03] text-mut",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center h-[20px] px-2 rounded-full border text-[9.5px] font-bold uppercase tracking-[0.06em] whitespace-nowrap tabular-nums ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export interface MatchPerformancePanelProps {
  games: RecentGameRow[];
  iconOf: IconLookup;
  chips: MatchPerformanceChips;
  /** Account-wide CURRENT-SPLIT CS/min and its denominator (engy §1d). A
   *  different window from `games` — labelled as such in the cell's note, never
   *  silently presented as a figure over the bars below. */
  splitCsPerMin: number | null;
  splitCsGames: number;
  /** "33 minutes ago", or null when nothing is known. */
  lastActive: string | null;
}

export default function MatchPerformancePanel({
  games,
  iconOf,
  chips,
  splitCsPerMin,
  splitCsGames,
  lastActive,
}: MatchPerformancePanelProps) {
  const avg = computeAverageKda(games);
  const winrate = chips.n > 0 ? chips.wins / chips.n : 0;
  const csQuotable = csRateIsQuotable(splitCsPerMin, splitCsGames);

  const items: KpiItem[] = [
    {
      key: "kda",
      label: "Avg. KDA",
      value: avg.n > 0 ? avg.kda : null,
      format: (n) => n.toFixed(2),
      countUp: true,
      note: avg.n > 0 ? `${avg.avgKills.toFixed(1)}/${avg.avgDeaths.toFixed(1)}/${avg.avgAssists.toFixed(1)}` : undefined,
    },
    {
      key: "cs",
      label: "Avg. CS/min",
      // Null renders KpiStrip's em dash — an honest absence. Never a 0, which
      // is a real farming figure.
      value: csQuotable ? splitCsPerMin : null,
      format: (n) => n.toFixed(1),
      countUp: true,
      // The note carries this cell's OWN denominator, which is deliberately not
      // the window the bars below are drawn over.
      note: csQuotable ? `${splitCsGames}g this split` : splitCsGames > 0 ? `only ${splitCsGames}g with CS` : "no CS recorded",
    },
    {
      key: "winrate",
      label: `Win rate, last ${chips.n}`,
      value: chips.n > 0 ? winrate * 100 : null,
      format: (n) => `${n.toFixed(1)}%`,
      valueClassName: chips.lowSample ? "text-mut" : winrate >= 0.5 ? "text-good" : "text-bad",
      countUp: true,
      note: chips.n > 0 ? `${chips.wins}W ${chips.losses}L` : undefined,
    },
  ];

  return (
    <div className="bg-panel border border-line rounded-xl px-4 sm:px-5 pt-4 pb-4">
      <PanelHeading meta={lastActive ? `Last active: ${lastActive}` : undefined}>
        Match performance {chips.n > 0 ? `(last ${chips.n} games)` : ""}
      </PanelHeading>

      {/* Chip cluster. `flush` on the strip below would fight the panel's own
          frame, so the strip keeps its border and the chips sit above it. */}
      <div className="pt-3 flex items-center gap-1.5 flex-wrap">
        <Chip
          tone={chips.rank.state === "ranked" ? "accent" : "muted"}
          title={chips.rank.title}
        >
          {chips.rank.label}
        </Chip>
        {chips.rank.lp && (
          <Chip tone="neutral" title="League points, ranked solo/duo">
            {chips.rank.lp}
          </Chip>
        )}
        {chips.rank.record && (
          <Chip tone="neutral" title="Riot's own ranked solo/duo record for the current split — a longer window than the games charted below">
            Ranked {chips.rank.record}
          </Chip>
        )}
        {chips.n > 0 && (
          <>
            <Chip tone="good" title={`Wins in the last ${chips.n} recorded games`}>
              Win {chips.wins}
            </Chip>
            <Chip tone="bad" title={`Losses in the last ${chips.n} recorded games`}>
              Lose {chips.losses}
            </Chip>
          </>
        )}
      </div>

      <div className="pt-3">
        <KpiStrip items={items} columns={3} />
      </div>

      {games.length > 0 && (
        <div className="pt-4">
          <RecentGamesChart games={games} iconOf={iconOf} />
        </div>
      )}

      {games.length === 0 && (
        <p className="pt-4 text-[12px] text-mut">No recent games recorded yet for this account.</p>
      )}
    </div>
  );
}
