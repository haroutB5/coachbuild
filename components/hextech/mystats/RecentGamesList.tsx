"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RecentGamesList — /mystats' "RECENT GAMES" list (mockup 6.png). Consumes
// the v0.51 wave-B EXTENDED /api/mystats/summary's `recentGames[]` (engo) —
// each row's `onWpaBuild` is a nullable tri-state (true/false/unknown), not a
// boolean, so an old/unresolved game degrades to "no chip" rather than a
// fabricated "off-build" label.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import { myStatsRoleLabel, type IconLookup } from "@/components/hextech/myStats";

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
}

export interface RecentGamesListProps {
  games: RecentGameRow[];
  iconOf: IconLookup;
}

function BuildChip({ onWpaBuild }: { onWpaBuild: boolean | null | undefined }) {
  if (onWpaBuild === true) {
    return (
      <span className="flex-shrink-0 text-[9.5px] font-bold uppercase tracking-[0.05em] px-2 py-1 rounded-md bg-teal/15 text-teal border border-teal/30">
        WPA build
      </span>
    );
  }
  if (onWpaBuild === false) {
    return (
      <span className="flex-shrink-0 text-[9.5px] font-bold uppercase tracking-[0.05em] px-2 py-1 rounded-md bg-panel2 text-mut border border-line">
        Off-build
      </span>
    );
  }
  return null;
}

export default function RecentGamesList({ games, iconOf }: RecentGamesListProps) {
  if (games.length === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-8 text-center">
        <p className="text-mut text-[12px]">No recent games recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-panel border border-line rounded-xl px-5">
      <p className="pt-4 pb-2 text-[11px] tracking-[0.12em] uppercase text-mut font-semibold">Recent games</p>
      {games.map((g, i) => {
        const entry = iconOf(g.championId);
        const name = entry?.name ?? `Champion #${g.championId}`;
        return (
          <div
            key={`${g.championId}-${i}`}
            className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0"
          >
            <span
              className={`w-5 text-center text-[13px] font-extrabold tabular-nums flex-shrink-0 ${
                g.win ? "text-good" : "text-bad"
              }`}
              aria-label={g.win ? "Win" : "Loss"}
            >
              {g.win ? "W" : "L"}
            </span>

            <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback src={entry?.icon ?? ""} alt="" fallbackGlyph={name} className="w-full h-full object-cover" size={32} />
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
