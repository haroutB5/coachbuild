"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RecentGamesChart — one bar per recent game, champion icon beneath, value
// above, win/loss colouring. The reference layout (TrackDIFF) plots per-game
// "Avg Score" with a placement label; we do NOT have score, placement, CS/min,
// game ELO or LP-per-game anywhere in this pipeline, so this plots what IS in
// `recentGames[]`: the game's KDA, with the existing WPA-build chip standing in
// for the reference's placement label. Nothing here is invented.
//
// THE MATH IS NOT LOCAL. Bar heights come from `normalizeKdaBars` (engo,
// components/hextech/myStats.ts) and are used as-is:
//   · `fraction` is already 0..1 against a FIXED ceiling of 10
//     (MYSTATS_KDA_BAR_CEILING), NOT against this window's own max. That is the
//     point — max-based scaling lets one 0-death stomp flatten every other bar
//     toward invisibility. DO NOT renormalise it here.
//   · zero-death games floor to divide-by-1, so `kda` is always finite and
//     `perfect` is the flag for badging them. No Infinity, no NaN.
// This component's only jobs are pixels and words.
//
// DENOMINATOR (the trap this repo has already been bitten by, v0.73.1):
// `recentGames[]` is a SHORT RECENT WINDOW, while MyStatsChampionRow.games is
// the full season record. Everything shown here is labelled with this window
// ("last N games") and never sits on a row with a season total. Any summary
// number added to this component must be computed over these games and carry
// that label — do not borrow one from the KPI strip.
//
// Accessibility: colour is never the only carrier. Every column has an
// `sr-only` sentence with champion, role, outcome, raw K/D/A and build status,
// and the visible KDA number sits above each bar.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import {
  computeAverageKda,
  myStatsRoleLabel,
  normalizeKdaBars,
  MYSTATS_KDA_BAR_CEILING,
  type IconLookup,
} from "@/components/hextech/myStats";
import type { RecentGameRow } from "./RecentGamesList";

/** Fixed track height — bars are sized inside it, so the chart occupies the
 *  same box before and after data resolves. CLS 0 by construction. */
const TRACK_PX = 84;

function BuildMark({ onWpaBuild }: { onWpaBuild: boolean | null | undefined }) {
  // Tri-state, same as BuildChip in RecentGamesList: unresolved renders an
  // EMPTY box of the same height rather than nothing, so a column with no
  // adherence data is still the same height as its neighbours.
  if (onWpaBuild === true) {
    return <span className="block h-[3px] w-5 rounded-full bg-teal" aria-hidden="true" />;
  }
  if (onWpaBuild === false) {
    return <span className="block h-[3px] w-5 rounded-full bg-white/15" aria-hidden="true" />;
  }
  return <span className="block h-[3px] w-5" aria-hidden="true" />;
}

export interface RecentGamesChartProps {
  games: RecentGameRow[];
  iconOf: IconLookup;
}

export default function RecentGamesChart({ games, iconOf }: RecentGamesChartProps) {
  if (games.length === 0) return null;

  const bars = normalizeKdaBars(games);
  const avg = computeAverageKda(games);
  const anyBuildData = games.some((g) => g.onWpaBuild === true || g.onWpaBuild === false);
  const anyAtCeiling = bars.some((b) => b.kda >= MYSTATS_KDA_BAR_CEILING);

  return (
    <div>
      {/* Horizontal scroll is scoped to this container — the page body never
          scrolls sideways at 390px, however many games land here. */}
      <ul
        className="flex items-end gap-1 overflow-x-auto pb-1 -mx-1 px-1"
        aria-label={`KDA for your last ${games.length} recorded games, most recent first`}
      >
        {games.map((g, i) => {
          const bar = bars[i];
          const entry = iconOf(g.championId);
          const name = entry?.name ?? `Champion #${g.championId}`;
          const height = Math.max(4, Math.round(bar.fraction * TRACK_PX));
          const buildText =
            g.onWpaBuild === true
              ? "on the WPA build"
              : g.onWpaBuild === false
                ? "off the WPA build"
                : "build not recorded";

          return (
            <li key={`${g.championId}-${i}`} className="flex flex-col items-center gap-1.5 w-[34px] flex-shrink-0">
              {/* A 0-death game is accented rather than annotated — there is no
                  room for the word "perfect" in a 34px column, and the sr-only
                  line below says it in full. */}
              <span
                className={`text-[9px] leading-none tabular-nums h-[10px] ${bar.perfect ? "text-teal" : "text-mut"}`}
                title={bar.perfect ? "Perfect KDA — no deaths" : undefined}
              >
                {bar.kda.toFixed(1)}
              </span>

              {/* No track behind the bar: a full-height grey column reads as
                  the other half of a STACKED bar, i.e. as data. The fixed-height
                  wrapper still reserves the space. */}
              <span className="w-full flex items-end justify-center" style={{ height: TRACK_PX }}>
                <span
                  className={`w-[20px] rounded-[3px] ${g.win ? "bg-good/85" : "bg-bad/80"}`}
                  style={{ height }}
                  aria-hidden="true"
                />
              </span>

              <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center">
                <IconWithFallback
                  src={entry?.icon ?? ""}
                  alt=""
                  fallbackGlyph={name}
                  className="w-full h-full object-cover"
                  size={28}
                />
              </span>

              <BuildMark onWpaBuild={g.onWpaBuild} />

              <span className="sr-only">
                {name} {myStatsRoleLabel(g.role)}, {g.win ? "win" : "loss"}, {g.kills}/{g.deaths}/{g.assists},
                KDA {bar.kda.toFixed(1)}
                {bar.perfect ? " (perfect, no deaths)" : ""}, {buildText}.
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex items-center gap-3 flex-wrap text-[9.5px] text-mut">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[2px] bg-good/85" aria-hidden="true" />
          Win
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[2px] bg-bad/80" aria-hidden="true" />
          Loss
        </span>
        {anyBuildData && (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-4 h-[3px] rounded-full bg-teal" aria-hidden="true" />
            On WPA build
          </span>
        )}
        {/* The ceiling is only worth explaining once a game has actually hit it
            — otherwise it is a rule about bars nobody is looking at. */}
        <span className="ml-auto">
          Bar height = KDA{anyAtCeiling ? `, full at ${MYSTATS_KDA_BAR_CEILING}+` : ""}
        </span>
      </div>

      {/* Averaged over THESE games only — the same window the panel heading
          names. `computeAverageKda` divides summed components once rather than
          averaging per-game ratios, so one low-death game can't dominate it. */}
      <p className="mt-1.5 text-[10px] text-mut/80 tabular-nums">
        Average {avg.avgKills.toFixed(1)} / {avg.avgDeaths.toFixed(1)} / {avg.avgAssists.toFixed(1)} ·{" "}
        {avg.kda.toFixed(2)} KDA over {avg.n} games
      </p>
    </div>
  );
}
