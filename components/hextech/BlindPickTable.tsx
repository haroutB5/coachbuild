"use client";

// ─────────────────────────────────────────────────────────────────────────────
// BlindPickTable — semantic, static-ranked table for the Draft page's blind-
// pick section. The server owns ordering; this component only renders the
// safety figures and the same champion icon treatment as DraftPicksTable.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import type { ChampionIconEntry } from "@/components/proAssets";
import type { BlindPickResult } from "@/lib/draft/blindPick";

interface BlindPickTableProps {
  picks: BlindPickResult[];
}

function pct(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

export default function BlindPickTable({ picks, champIcons }: BlindPickTableProps & { champIcons: Map<number, ChampionIconEntry> }) {
  return (
    <div className="bg-panel border border-line rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        {/* 540, matching the sibling DraftPicksTable. It was 720 while the
            column that holds it is 560px at 1440 and 708px at 1920 — so RISKY
            and GAMES were cut off at EVERY desktop size with no visible scroll
            hint (2026-08-01 audit P1). Six columns fit 540 comfortably; the
            seventh (RISKY) was dropped in the same pass, see below. */}
        <table className="hidden w-full min-w-[540px] border-collapse sm:table" aria-label="Blind pick champions">
          <caption className="sr-only">Top blind picks ranked by matchup safety before seeing the enemy lane pick</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-mut">
                #
              </th>
              <th scope="col" className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-mut">
                Champion
              </th>
              <th
                scope="col"
                title="Expected win rate over the worst 10% of opponent probability mass"
                className="py-2 px-2.5 text-right text-[10px] tracking-[0.1em] uppercase font-bold text-mut"
              >
                Floor
              </th>
              <th scope="col" className="py-2 px-2.5 text-right text-[10px] tracking-[0.1em] uppercase font-bold text-mut">
                Field WR
              </th>
              <th
                scope="col"
                title="Lowest shrunk matchup estimate among opponents with a lane-wide prior"
                className="py-2 px-2.5 text-left text-[10px] tracking-[0.1em] uppercase font-bold text-mut"
              >
                Worst matchup
              </th>
              {/* RISKY (badMass) was here and is deliberately gone. Measured
                  across the mid top 10 it spans 0.0%–7.5% — near-constant, so
                  it cost a column of width while separating nothing, and it
                  restated in aggregate what WORST MATCHUP already says
                  concretely. `badMass` stays on the wire; if it earns a place
                  later it can come back with a range worth reading. */}
              <th scope="col" className="py-2 px-2.5 text-right text-[10px] tracking-[0.1em] uppercase font-bold text-mut">
                Games
              </th>
            </tr>
          </thead>
          <tbody>
            {picks.map((pick) => {
              const champ = champIcons.get(pick.champId);
              const name = champ?.name ?? `Champion #${pick.champId}`;
              const worst = pick.worstMatchup;
              const worstName = worst ? champIcons.get(worst.oppId)?.name ?? `Champion #${worst.oppId}` : "—";
              return (
                <tr key={pick.champId} className="border-b border-line last:border-b-0">
                  <td className="py-2 px-2.5 text-[11px] font-bold tabular-nums text-mut">{pick.rank}</td>
                  <td className="py-2 px-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex-shrink-0">
                        <IconWithFallback src={champ?.icon ?? ""} alt={name} fallbackGlyph={name} className="w-full h-full object-cover" size={32} />
                      </span>
                      <span className="text-[12.5px] font-semibold text-txt truncate">{name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-2.5 text-right">
                    <span className="text-[12px] font-bold tabular-nums text-teal">{pct(pick.es10)}</span>
                  </td>
                  <td className="py-2 px-2.5 text-right text-[11.5px] font-semibold tabular-nums text-txt">{pct(pick.fieldWr)}</td>
                  <td className="py-2 px-2.5">
                    {worst ? (
                      // The matchup's OWN game count, not the row's lane total.
                      // This is the most concrete claim on the row ("loses to
                      // Aurora") and routinely rests on a fraction of the games
                      // in the Games column — Singed mid: 137 vs 11,476. The
                      // rate is already shrunk toward baseline, so a thin cell
                      // cannot render as alarming; showing n is what lets the
                      // reader tell a measured counter from a hint of one.
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="text-[11.5px] font-semibold text-txt truncate">{worstName}</span>
                        <span className="text-[10.5px] tabular-nums text-mut flex-shrink-0">{pct(worst.wr)}</span>
                        {/* text-mut, NOT text-mut/70 — the faded variant measured
                            3.19:1 against the panel at 9px, under WCAG AA's 4.5:1.
                            Full text-mut is 5.17:1 and every other cell in this
                            table already clears it (2026-08-01 audit P2). */}
                        <span className="text-[9px] tabular-nums text-mut flex-shrink-0">
                          {worst.games.toLocaleString()}g
                        </span>
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-mut">—</span>
                    )}
                  </td>
                  <td className="py-2 px-2.5 text-right text-[11.5px] tabular-nums text-mut">{pick.totalGames.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="divide-y divide-line sm:hidden">
          {picks.map((pick) => {
            const champ = champIcons.get(pick.champId);
            const name = champ?.name ?? `Champion #${pick.champId}`;
            const worst = pick.worstMatchup;
            const worstName = worst ? champIcons.get(worst.oppId)?.name ?? `Champion #${worst.oppId}` : "—";
            return (
              <article key={pick.champId} className="grid grid-cols-[24px_minmax(0,1fr)_auto] gap-x-2 px-3 py-3">
                <span className="pt-1 text-[11px] font-bold tabular-nums text-mut">{pick.rank}</span>
                <div className="flex min-h-[44px] min-w-0 items-center gap-2">
                  <span className="h-8 w-8 shrink-0 overflow-hidden rounded-lg border border-line bg-black/30">
                    <IconWithFallback src={champ?.icon ?? ""} alt={name} fallbackGlyph={name} className="h-full w-full object-cover" size={32} />
                  </span>
                  <span className="min-w-0 truncate text-[12.5px] font-semibold text-txt">{name}</span>
                </div>
                <span className="pt-1 text-right text-[12px] font-bold tabular-nums text-teal">{pct(pick.es10)}</span>
                <div className="col-start-2 col-span-2 mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 border-t border-line pt-2">
                  <span className="min-w-0 truncate text-[10px] text-mut">Worst: {worstName}{worst ? ` · ${pct(worst.wr)}` : ""}</span>
                  <span className="text-right text-[10.5px] font-semibold tabular-nums text-txt">{pct(pick.fieldWr)}</span>
                  <span className="text-right text-[10.5px] tabular-nums text-mut">{pick.totalGames.toLocaleString()}g</span>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
