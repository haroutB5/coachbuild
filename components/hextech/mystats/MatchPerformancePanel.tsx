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
// which is Riot's own ranked-record tally and is labelled as such.
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
  formatCsNote,
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
  /** Account-wide current-season CS/min and its denominator (engy §1d). A
   *  different window from `games` — labelled as such in the cell's note, never
   *  silently presented as a figure over the bars below. */
  seasonCsPerMin: number | null;
  seasonCsGames: number;
  /** Coverage-aware season phrase supplied by the page's shared scope helper. */
  scopeLabel: string;
  /** Total games played THIS SEASON (e.g. `computeMyStatsOverall(records).games`)
   *  — NOT `games.length`/`chips.n`, which is the capped 20-game display
   *  window and can be smaller than the real season total. This is the honest
   *  denominator `formatCsNote` compares `seasonCsGames` against to decide
   *  whether "only" belongs in the CS tile's caption (2026-07-31 audit P2
   *  re-score follow-up — see that function's doc comment). */
  totalSeasonGames: number;
  /** "33 minutes ago", or null when nothing is known. */
  lastActive: string | null;
}

export default function MatchPerformancePanel({
  games,
  iconOf,
  chips,
  seasonCsPerMin,
  seasonCsGames,
  scopeLabel,
  totalSeasonGames,
  lastActive,
}: MatchPerformancePanelProps) {
  const avg = computeAverageKda(games);
  const winrate = chips.n > 0 ? chips.wins / chips.n : 0;
  const csQuotable = csRateIsQuotable(seasonCsPerMin, seasonCsGames);

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
      value: csQuotable ? seasonCsPerMin : null,
      format: (n) => n.toFixed(1),
      countUp: true,
      // The note carries this cell's OWN denominator, which is deliberately not
      // the window the bars below are drawn over. formatCsNote only says
      // "only" when csGames is a genuine subset of totalSeasonGames (2026-07-31
      // audit P2 re-score follow-up) -- when quotable, the season-total phrasing
      // is identical either way, so this always calls the same helper.
      note: formatCsNote(seasonCsGames, totalSeasonGames, scopeLabel),
    },
    {
      key: "winrate",
      // NOT "last N games <scopeLabel>". The panel heading directly above
      // already reads "(last N games this season)", so repeating the scope here
      // bought nothing and cost the strip's baseline: at 1440px the longer
      // string wrapped to 3 lines against the neighbouring cells' 1, and on an
      // account still filling history ("...so far this season") to 4, dropping
      // this cell's note 13-26px below the others. KpiStrip reserves a fixed
      // label row precisely so the labels DON'T stair-step -- see its header.
      // 2026-08-01 audit P2.
      label: `Win rate, last ${chips.n}`,
      value: chips.n > 0 ? winrate * 100 : null,
      format: (n) => `${n.toFixed(1)}%`,
      valueClassName: chips.lowSample ? "text-mut" : winrate >= 0.5 ? "text-good" : "text-bad",
      countUp: true,
      note: chips.n > 0 ? `${chips.wins}W ${chips.losses}L` : undefined,
    },
  ];

  return (
    // `min-w-0` IS LOad-BEARING, do not drop it as redundant. This panel is a
    // grid child, and a grid/flex child defaults to `min-width: auto`, meaning
    // it refuses to shrink below its content. The bar chart inside has its own
    // `overflow-x-auto`, but that container can only scroll if it is ALLOWED to
    // be narrower than its contents — without this the chart's real width wins,
    // the panel grows past its column, and the overflow escapes all the way to
    // the document. Shipped exactly that way in v0.84.0: the chart's own
    // `overflow-x-auto` looked correct in isolation while `/mystats` scrolled
    // sideways 383px at 390px wide. Note `document.body` measured CLEAN in that
    // state and only `documentElement` showed it, which is why a scrollWidth
    // check on the body alone passed.
    <div className="min-w-0 bg-panel border border-line rounded-xl px-3.5 sm:px-4 pt-3.5 pb-3.5">
      <PanelHeading meta={lastActive ? `Last active: ${lastActive}` : undefined}>
        {/* 2026-07-31 audit P2 (#3): `games` (and therefore chips.n) is now
            scoped to the CURRENT SEASON (app/api/mystats/summary/route.ts) —
            the season phrase makes that scope explicit rather than implying a
            fixed rolling window of N games regardless of when they were
            played. */}
        Match performance {chips.n > 0 ? `(last ${chips.n} games ${scopeLabel})` : ""}
      </PanelHeading>

      {/*
        ONE ROW at `xl`, not two stacked bands.

        In the reference the three big numerals and the chip cluster share a
        single line — numerals left, chips right — and that pairing is what makes
        the panel read as a dense scoreboard header rather than as two unrelated
        strips. Ours shipped with the chips on their own row ABOVE the KPI strip,
        which cost ~34px and, worse, separated the standing (a chip) from the
        numbers it qualifies.

        It stays STACKED below `xl`: at 390px five chips and a 3-column KPI grid
        cannot share a line without one of them shrinking past legibility, and
        the panel is full-width there anyway so nothing is gained.

        DOM ORDER IS CHIPS-THEN-KPIS at every width, and the visual swap at `xl`
        is `order`, not a re-render — a screen reader still hears the standing
        before the figures, which is the order the copy was written in.
      */}
      <div className="pt-3 flex flex-col xl:flex-row xl:items-center gap-2.5 xl:gap-4">
      <div className="flex items-center gap-1.5 flex-wrap xl:order-2 xl:justify-end xl:flex-shrink xl:min-w-0">
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
          <Chip tone="neutral" title="Riot's own ranked solo/duo record — a longer window than the games charted below">
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

        {/* `min-w-0` lets the strip shrink inside the flex row instead of
            forcing the chips to wrap off the end — the same `min-width:auto`
            hazard this file's root comment is about. `xl:min-w-[360px]` is the
            FLOOR under that, and it is not a guess: three cells of a 26px
            tabular value plus `px-4` gutters need ~100px each, and without the
            floor the third cell clipped "45.0%" mid-glyph at 1290px. Measured,
            not reasoned about. */}
        <div className="min-w-0 xl:order-1 xl:flex-1 xl:min-w-[360px]">
          <KpiStrip items={items} columns={3} />
        </div>
      </div>

      {games.length > 0 && (
        <div className="pt-3.5">
          <RecentGamesChart games={games} iconOf={iconOf} />
        </div>
      )}

      {games.length === 0 && (
        <p className="pt-4 text-[12px] text-mut">No recent games recorded yet for this account.</p>
      )}
    </div>
  );
}
