"use client";

// ─────────────────────────────────────────────────────────────────────────────
// StatTiles — /mystats' KPI band. 2026-07-29 redesign: four separate bordered
// tiles became one hairline-separated strip (components/hextech/KpiStrip), the
// same one the Builds page's FeaturedOtpCard renders under its hero, so the two
// surfaces read as one product.
//
// The MAIN tile is gone from here on purpose, not dropped: the main champion is
// now the /mystats hero — its splash art, its portrait, its name — which is a
// stronger place for it than a text tile. Nothing else was removed.
//
// Two deltas, both REAL comparisons that exist in the data:
//   · win rate vs the prior split (`priorSplitWinrate`)
//   · win rate on the WPA build vs off it, via engo's `computeBuildWinrateDelta`
//     (components/hextech/myStats.ts) — the most interesting number on the page.
//
// THE ON-BUILD CHIP NEVER GUESSES. `computeBuildWinrateDelta` is a discriminated
// union with FOUR non-comparable reasons, and every one of them renders as a
// visibly non-numeric chip plus a caption clause saying what is missing. A `0`
// or a `0.0pp` in that slot would be a confident lie about the user's own
// record, and hiding the chip would reflow the strip depending on how much data
// an account happens to have. Both are forbidden; KpiStrip reserves the row
// either way.
//
// Passing `nOnBuild`/`nOffBuild` is NOT optional in practice: without the third
// and fourth arguments the helper answers "sample-unknown" on every load, which
// is exactly the state v0.74 existed to get out of. And when the comparison IS
// made, both sample sizes are printed in the caption — the helper hands them
// back precisely so a percentage never appears without the n behind it.
//
// EVERY number here is season-scoped, summed over the same `records[]` the
// tables below list. None of it comes from `recentGames[]`, which is a short
// recent window with a different denominator — keep it that way.
// ─────────────────────────────────────────────────────────────────────────────

import KpiStrip, { type KpiItem, type KpiDelta } from "@/components/hextech/KpiStrip";
import {
  computeBuildWinrateDelta,
  MYSTATS_LOW_SAMPLE_THRESHOLD,
  type MyStatsBuildWinrateDelta,
} from "@/components/hextech/myStats";

export interface StatTilesProps {
  games: number;
  seasonLabel: string;
  winrate: number;
  /** Fraction 0-1, or null when there's no prior-split baseline to compare
   *  against yet. */
  priorSplitWinrate: number | null;
  /** 0-100, or null when the build-adherence pipeline hasn't backfilled this
   *  account yet. */
  buildAdherencePct: number | null;
  /** Fractions 0-1. */
  winrateOnBuild: number | null;
  winrateOffBuild: number | null;
  /** Row counts BEHIND those two winrates (v0.74, `GET /api/mystats/summary`).
   *  Optional in the TYPE only, so an older cached wire response degrades to an
   *  honest "sample unknown" instead of crashing — always pass them. */
  nOnBuild?: number | null;
  nOffBuild?: number | null;
}

type NotComparable = Extract<MyStatsBuildWinrateDelta, { comparable: false }>["reason"];

function pct1(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** One chip per non-comparable reason. Text is short and visibly NON-numeric;
 *  the title carries the specific why for hover + assistive tech. */
function unknownChip(reason: NotComparable): KpiDelta {
  switch (reason) {
    case "no-on-build-data":
      return {
        kind: "unknown",
        text: "No comparison",
        title: "No games recorded on the WPA build this split, so there is nothing to compare against",
      };
    case "no-off-build-data":
      return {
        kind: "unknown",
        text: "No comparison",
        title: "No games recorded off the WPA build this split, so there is nothing to compare against",
      };
    case "low-sample":
      return {
        kind: "unknown",
        text: "Too few games",
        title: `Fewer than ${MYSTATS_LOW_SAMPLE_THRESHOLD} games in one of the two buckets — not enough to compare`,
      };
    case "sample-unknown":
    default:
      return {
        kind: "unknown",
        text: "Sample unknown",
        title: "The number of games behind each win rate wasn't reported, so the difference can't be quoted honestly",
      };
  }
}

/**
 * The adherence half of the caption.
 *
 * This caption stays a caption rather than moving into the chips (2026-07-29
 * review). On the featured card the equivalent grey paragraph WAS removable,
 * because what it said could be carried by labels on the things it described.
 * Here it cannot: a KPI cell is ~101px wide at 390px, and the two sample sizes
 * behind the comparison have to be legible on screen — a percentage never
 * appears without its n. The chip's `title` alone is not "legible", it is
 * hover-only. So the caption is written as ONE compact clause per chip instead,
 * which reads as a caption rather than as a block of prose.
 */
function buildCaption(d: MyStatsBuildWinrateDelta): string {
  if (d.comparable) {
    return `adherence = ${pct1(d.onBuild.winrate)} on-build (${d.onBuild.n} games) vs ${pct1(
      d.offBuild.winrate
    )} off (${d.offBuild.n} games)`;
  }
  switch (d.reason) {
    case "no-on-build-data":
      return "adherence needs games played on the WPA build to compare";
    case "no-off-build-data":
      return "adherence needs games played off the WPA build to compare";
    case "low-sample":
      return `adherence needs ${MYSTATS_LOW_SAMPLE_THRESHOLD}+ games both on and off the WPA build to compare`;
    case "sample-unknown":
    default:
      return "adherence can't compare — the sample sizes behind those win rates weren't reported";
  }
}

export default function StatTiles({
  games,
  seasonLabel,
  winrate,
  priorSplitWinrate,
  buildAdherencePct,
  winrateOnBuild,
  winrateOffBuild,
  nOnBuild,
  nOffBuild,
}: StatTilesProps) {
  // Four-arg on purpose — see this file's header. Two-arg answers
  // "sample-unknown" forever.
  const buildDelta = computeBuildWinrateDelta(winrateOnBuild, winrateOffBuild, nOnBuild, nOffBuild);

  const items: KpiItem[] = [
    {
      key: "games",
      label: seasonLabel ? `Games, ${seasonLabel}` : "Games",
      value: games,
      countUp: true,
    },
    {
      key: "winrate",
      label: "Win rate",
      value: winrate * 100,
      format: (n) => `${n.toFixed(1)}%`,
      valueClassName: winrate >= 0.5 ? "text-good" : "text-bad",
      countUp: true,
      delta:
        priorSplitWinrate !== null
          ? { kind: "delta", pp: (winrate - priorSplitWinrate) * 100, title: "vs your last split" }
          : null,
    },
    {
      key: "adherence",
      label: "Build adherence",
      value: buildAdherencePct,
      format: (n) => `${Math.round(n)}%`,
      countUp: true,
      delta: buildDelta.comparable
        ? {
            kind: "delta",
            // `delta` is a FRACTION difference — both winrates are 0-1.
            pp: buildDelta.delta * 100,
            title: `win rate on the WPA build (${buildDelta.onBuild.n} games) vs off it (${buildDelta.offBuild.n} games)`,
          }
        : unknownChip(buildDelta.reason),
    },
  ];

  return (
    <div>
      <KpiStrip items={items} columns={3} />
      {/* Every chip above is a bare signed number or a bare phrase; this is
          where each says what it compared, and over how many games. One clause
          per chip, dot-separated — see buildCaption's doc comment for why this
          stays a caption instead of collapsing into the chips. */}
      <p className="mt-2 text-[10px] text-mut/70 leading-[1.5]">
        Chips: {priorSplitWinrate !== null && <>win rate vs last split · </>}
        {buildCaption(buildDelta)}.
      </p>
    </div>
  );
}
