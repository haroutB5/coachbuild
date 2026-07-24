"use client";

// ─────────────────────────────────────────────────────────────────────────────
// StatTiles — /mystats' 4-tile row (mockup 6.png): GAMES / WIN RATE / MAIN /
// BUILD ADHERENCE. Consumes the v0.51 wave-B EXTENDED /api/mystats/summary
// fields (buildAdherencePct, priorSplitWinrate) — both may be null/undefined
// on a response from before engo's migration backfills, so every derived
// sub-line is optional and simply omitted rather than showing a fabricated
// "0" or "—" where a real absence is more honest as "nothing shown."
// ─────────────────────────────────────────────────────────────────────────────

function pctText(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function ppText(diff: number): string {
  const pp = diff * 100;
  return `${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp`;
}

export interface StatTilesProps {
  games: number;
  seasonLabel: string;
  winrate: number;
  /** Fraction 0-1, or null when there's no prior-split baseline to compare
   *  against yet. */
  priorSplitWinrate: number | null;
  mainChampionName: string | null;
  mainChampionGames: number | null;
  mainChampionWinrate: number | null;
  /** 0-100, or null when the build-adherence pipeline hasn't backfilled this
   *  account yet. */
  buildAdherencePct: number | null;
}

function Tile({
  label,
  value,
  valueClassName,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="bg-panel border border-line rounded-xl p-4">
      <p className="text-[10px] tracking-[0.1em] uppercase text-mut font-semibold">{label}</p>
      <p className={`text-[22px] font-extrabold tracking-[-0.02em] tabular-nums mt-1.5 ${valueClassName ?? "text-txt"}`}>
        {value}
      </p>
      {sub && <p className="text-[10.5px] text-mut mt-1">{sub}</p>}
    </div>
  );
}

export default function StatTiles({
  games,
  seasonLabel,
  winrate,
  priorSplitWinrate,
  mainChampionName,
  mainChampionGames,
  mainChampionWinrate,
  buildAdherencePct,
}: StatTilesProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Tile label="Games" value={games} sub={seasonLabel ? `ranked, ${seasonLabel.toLowerCase()}` : "ranked"} />

      <Tile
        label="Win rate"
        value={pctText(winrate)}
        valueClassName={winrate >= 0.5 ? "text-good" : "text-bad"}
        sub={priorSplitWinrate !== null ? `${ppText(winrate - priorSplitWinrate)} vs last split` : undefined}
      />

      <Tile
        label="Main"
        value={mainChampionName ?? "—"}
        sub={
          mainChampionName && mainChampionGames !== null && mainChampionWinrate !== null
            ? `${mainChampionGames}g · ${pctText(mainChampionWinrate)} WR`
            : undefined
        }
      />

      <Tile
        label="Build adherence"
        value={buildAdherencePct !== null ? `${Math.round(buildAdherencePct)}%` : "—"}
        sub="games on the WPA build"
      />
    </div>
  );
}
