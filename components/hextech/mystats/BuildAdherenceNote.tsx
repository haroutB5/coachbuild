"use client";

// ─────────────────────────────────────────────────────────────────────────────
// BuildAdherenceNote — where build adherence went when the KPI strip was
// deleted (2026-07-30 user directive: "this red section is useless just add the
// percentage WR into the account section above").
//
// The directive named the win rate's destination and said nothing about the
// other two cells, so the choice was: move adherence, or drop it and say so.
// It moved, for one reason — it is the only figure on this page derived from
// CoachBuild's OWN recommendation. Everything else here (games, win rate, KDA,
// CS, rank) is Riot's data restated. Adherence is the app checking whether the
// user actually built what it told them to and what happened when they did, and
// dropping it would delete the only line connecting My Stats to the rest of the
// product.
//
// It moved to the MATCH HISTORY tab rather than to another band on the Accounts
// tab, and that is not a compromise. `RecentGamesList` prints a per-game "on
// WPA build" / "off build" chip on every row directly below this — so the
// summary of those chips now sits with the chips it summarises, instead of
// floating three panels above them beside a games count and a win rate it has
// nothing to do with. It is also, correctly, out of the way: the user called
// that band useless in the position it was in.
//
// ── WHAT IT MAY NOT DO ──────────────────────────────────────────────────────
// Never guess. `computeBuildWinrateDelta` is a discriminated union with four
// non-comparable reasons, and each one renders as a plain sentence saying what
// is missing. A `0.0pp` in that slot would be a confident lie about the user's
// own record. Both sample sizes are printed whenever the comparison IS made — a
// percentage never appears here without the n behind it.
//
// DISPLAY ONLY, like everything else under /mystats (CLAUDE.md HARD RULE 3).
// ─────────────────────────────────────────────────────────────────────────────

import {
  computeBuildWinrateDelta,
  MYSTATS_LOW_SAMPLE_THRESHOLD,
  type MyStatsBuildWinrateDelta,
} from "@/components/hextech/myStats";

export interface BuildAdherenceNoteProps {
  /** 0-100, or null when the adherence pipeline has not backfilled this
   *  account. Null renders an em dash, never a 0 — 0% adherence is a real and
   *  very different fact. */
  buildAdherencePct: number | null;
  /** Fractions 0-1. */
  winrateOnBuild: number | null;
  winrateOffBuild: number | null;
  /** The row counts behind those two rates. Without BOTH, the comparison
   *  answers "sample-unknown" and says so — see the header. */
  nOnBuild?: number | null;
  nOffBuild?: number | null;
  /** "this season" / "recorded so far" — the page's single coverage-aware scope
   *  wording, passed in rather than re-derived so this can never claim a season
   *  the hero has already withdrawn. */
  scopeLabel: string;
}

/** The sentence under the figure. Every branch states a sample size or states
 *  that it is missing; none of them implies a comparison that was not made. */
function comparisonSentence(d: MyStatsBuildWinrateDelta): string {
  if (d.comparable) {
    const on = (d.onBuild.winrate * 100).toFixed(1);
    const off = (d.offBuild.winrate * 100).toFixed(1);
    const pp = (d.delta * 100).toFixed(1);
    const dir = d.delta >= 0 ? "better" : "worse";
    return `${on}% on the recommended build over ${d.onBuild.n} games, ${off}% off it over ${d.offBuild.n} — ${Math.abs(Number(pp))}pp ${dir}.`;
  }
  switch (d.reason) {
    case "no-on-build-data":
      return "No games recorded on the recommended build yet, so there is nothing to compare against.";
    case "no-off-build-data":
      return "No games recorded off the recommended build yet, so there is nothing to compare against.";
    case "low-sample":
      return `Fewer than ${MYSTATS_LOW_SAMPLE_THRESHOLD} games in one of the two groups — not enough to compare honestly.`;
    case "sample-unknown":
    default:
      return "The number of games behind each rate was not reported, so the difference cannot be quoted.";
  }
}

export default function BuildAdherenceNote({
  buildAdherencePct,
  winrateOnBuild,
  winrateOffBuild,
  nOnBuild,
  nOffBuild,
  scopeLabel,
}: BuildAdherenceNoteProps) {
  // Four-arg on purpose: the two-arg call answers "sample-unknown" forever.
  const delta = computeBuildWinrateDelta(winrateOnBuild, winrateOffBuild, nOnBuild, nOffBuild);

  return (
    <div className="bg-panel border border-line rounded-xl px-4 sm:px-5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] tracking-[0.13em] uppercase text-mut font-semibold">
          Build adherence
        </span>
        <span className="text-[20px] font-semibold tabular-nums text-txt tracking-[-0.01em] leading-none">
          {buildAdherencePct === null ? (
            <span className="text-mut/50">&mdash;</span>
          ) : (
            `${Math.round(buildAdherencePct)}%`
          )}
        </span>
        <span className="text-[11px] text-mut">of games {scopeLabel}</span>
      </div>
      <p className="mt-1 text-[11.5px] text-mut leading-relaxed">
        {buildAdherencePct === null
          ? "Not worked out for this account yet — adherence only resolves on games ingested after the build-tracking migration, and only when the game's patch matches the live recommendation."
          : comparisonSentence(delta)}
      </p>
    </div>
  );
}
