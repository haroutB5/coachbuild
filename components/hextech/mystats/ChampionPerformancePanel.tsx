"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ChampionPerformancePanel — the reference's lower-LEFT panel, "Most played
// champions:". Five rows, each: portrait | name + CS/min (gold) | a centre
// stat column | win% over games at the right.
//
// ── THE ONE COLUMN THAT IS NOT THE REFERENCE'S, AND WHY ─────────────────────
// The reference's centre column is a per-champion KDA over a K / D / A
// breakdown. We do not have it. `my_matches` stores kills/deaths/assists per
// row, but the only per-champion aggregate the summary route computes is
// `summarizeByChampion` (games / wins / lastPlayed / CS), so `records[]` reaches
// this page with no KDA on it whatsoever.
//
// Computing it here from `recentGames[]` — which DOES carry K/D/A — would be
// the v0.73.1 bug verbatim: that array is a short account-wide window, while
// every other figure on this row is the season, so a champion's "KDA" would be
// quoted over a couple of games and sit on the same row as a win rate over
// dozens. Two denominators, one row, no label. Not done.
//
// So the centre column is the account's RECORD on that champion — real, already
// in `records[]`, and the same visual shape the reference uses (one large
// coloured figure over a smaller breakdown). Every column is HEADED, which is
// what makes the swap read as a decision rather than as a mislabelled KDA.
//
// ── CS/MIN ALWAYS SHOWS, AND SHOWS ITS SAMPLE ───────────────────────────────
// HARD USER DIRECTIVE (2026-08-01): "Some stats like cs/min aren't showing for
// all champs. I want that included always."
//
// This column used to hide any rate backed by fewer than
// MYSTATS_LOW_SAMPLE_THRESHOLD games behind an em dash. On the account that
// prompted the change that suppressed 34 of 35 rows — every one of which had a
// real, measured, time-weighted rate. Corki read "—" while holding 7.0 over 9
// games. A blanket em dash is not more honest than a number; it destroys a real
// measurement to avoid a misreading the row already prevents by printing its own
// denominator ("9g") directly beneath the figure.
//
// The thin-sample concern was legitimate and is kept — as WEIGHT, not as
// absence. Below the threshold the figure renders in muted grey rather than
// gold, the same lowSample-forces-grey convention `wrColorClass` and
// ChampionPoolCard already use for win rates on this page. One page, one way of
// saying "true, but thin".
//
// An em dash now means exactly one thing: `csPerMin === null`, i.e. NOTHING was
// measured (rows ingested before migration 0021, or every game under
// CS_MIN_GAME_SEC). Not measured and measured-over-few are different statements
// and no longer share a glyph.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { IconWithFallback } from "@/components/IconWithFallback";
import PanelHeading from "@/components/hextech/PanelHeading";
import { csRateIsQuotable, formatCsPerMin, formatPct, type ChampionPerformanceRow } from "./profileModel";

function wrColorClass(winrate: number, lowSample: boolean): string {
  // Same bands and the same lowSample-forces-grey rule as ChampionPoolCard —
  // two lists of the same champions on one page must not disagree about which
  // win rates are worth colouring.
  if (lowSample) return "text-mut";
  const pct = winrate * 100;
  if (pct >= 52) return "text-good";
  if (pct < 45) return "text-bad";
  return "text-txt";
}

export interface ChampionPerformancePanelProps {
  rows: ChampionPerformanceRow[];
  /** Names the denominator these rows are over — "this season", "recorded so
   *  far" when the history is known incomplete. Never omitted. */
  scopeLabel: string;
}

export default function ChampionPerformancePanel({ rows, scopeLabel }: ChampionPerformancePanelProps) {
  if (rows.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-mut text-[12px]">No champions recorded yet.</p>
      </div>
    );
  }

  return (
    // `min-w-0` for the same reason as MatchPerformancePanel's root — this is a
    // grid child, and `min-width: auto` would let long champion names push the
    // column wider than its track instead of truncating inside it.
    <div className="min-w-0 bg-panel border border-line rounded-xl px-3.5 sm:px-4 pt-3.5 pb-1">
      <PanelHeading meta={`Top ${rows.length} · ${scopeLabel}`}>Most played champions</PanelHeading>

      {/* Column headers. The reference has none, but the reference's centre
          column is a KDA and ours is not — an unheaded column that differs from
          the thing it visually resembles is how a reader mistakes one for the
          other. `aria-hidden` because every row already carries its own labelled
          sr-only sentence. */}
      <div
        className="flex items-center gap-2.5 pt-2 pb-1 text-[8px] uppercase tracking-[0.08em] text-mut/70 font-semibold"
        aria-hidden="true"
      >
        <span className="w-8 flex-shrink-0" />
        <span className="min-w-0 flex-1">Champion</span>
        <span className="w-[42px] text-right flex-shrink-0">CS/min</span>
        <span className="w-[50px] text-right flex-shrink-0">Record</span>
        <span className="w-[50px] text-right flex-shrink-0">Win rate</span>
      </div>

      {rows.map((row) => {
        // Rendered whenever a rate EXISTS — see this file's header. `quotable`
        // no longer gates visibility, only colour weight.
        const cs = row.csPerMin !== null ? formatCsPerMin(row.csPerMin) : null;
        const csThinSample = !csRateIsQuotable(row.csPerMin, row.csGames);
        return (
          <Link
            key={`${row.championId}-${row.role}`}
            href={`/?championId=${row.championId}&role=${row.role}`}
            // py-2 + a 32px portrait puts the row pitch at ~50px, which is the
            // reference's ~52px on its wider page. py-2.5 + 36px was 57px, and
            // five rows of that is what made this panel read as a list where the
            // reference reads as a table.
            className="flex items-center gap-2.5 py-2 border-b border-line last:border-b-0 rounded-md transition-colors motion-reduce:transition-none hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
          >
            <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback src={row.icon} alt="" fallbackGlyph={row.name} className="w-full h-full object-cover" size={32} />
            </span>

            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] text-txt font-semibold truncate tracking-[-0.01em] leading-[1.25]">
                {row.name}
              </span>
              <span className="block text-[9.5px] text-mut tabular-nums leading-[1.3]">
                {row.roleLabel} · {row.games}g
              </span>
            </span>

            {/* The reference's gold CS/min figure. */}
            <span className="w-[42px] text-right flex-shrink-0">
              {cs !== null ? (
                <>
                  <span
                    className={`block text-[12.5px] font-bold tabular-nums ${csThinSample ? "text-mut" : "text-teal"}`}
                    title={
                      csThinSample
                        ? `Time-weighted CS per minute over ${row.csGames} game${row.csGames === 1 ? "" : "s"} — a real average, but a thin sample.`
                        : `Time-weighted CS per minute over ${row.csGames} games.`
                    }
                  >
                    {cs}
                  </span>
                  <span className="block text-[9px] text-mut/75 tabular-nums">{row.csGames}g</span>
                </>
              ) : (
                <span
                  className="block text-[12.5px] font-bold tabular-nums text-mut/50"
                  title="No CS recorded for this champion yet — games ingested before CS tracking landed carry none, and games under 5 minutes are excluded from every rate."
                >
                  &mdash;
                </span>
              )}
            </span>

            {/* Centre column — the account's record, NOT a KDA. See header. */}
            <span className="w-[50px] text-right flex-shrink-0">
              <span className={`block text-[12.5px] font-bold tabular-nums leading-[1.25] ${wrColorClass(row.winrate, row.lowSample)}`}>
                {row.wins}&ndash;{row.losses}
              </span>
              <span className="block text-[9px] text-mut/75 tabular-nums leading-[1.3]">
                {row.wins}W {row.losses}L
              </span>
            </span>

            <span className="w-[50px] text-right flex-shrink-0">
              <span className={`block text-[13px] font-bold tabular-nums leading-[1.25] ${wrColorClass(row.winrate, row.lowSample)}`}>
                {formatPct(row.winrate)}
              </span>
              <span className="block text-[9px] text-mut/75 tabular-nums leading-[1.3]">{row.games}g</span>
            </span>

            <span className="sr-only">
              {row.name} {row.roleLabel}: {row.games} games, {row.wins} wins {row.losses} losses,{" "}
              {formatPct(row.winrate)} win rate
              {cs !== null
                ? `, ${cs} CS per minute over ${row.csGames} game${row.csGames === 1 ? "" : "s"}${csThinSample ? " (thin sample)" : ""}`
                : ", CS per minute not recorded"}
              .
            </span>
          </Link>
        );
      })}
    </div>
  );
}
