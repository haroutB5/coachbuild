import type { ChampionRef } from "@/lib/types";
import type { DraftCounterSuggestion } from "@/components/live/draftCounters";

export const UGG_LANES = ["top", "jungle", "mid", "adc", "support"] as const;
export const UGG_BEST_LIMIT = 15;
export const UGG_WORST_LIMIT = 10;

/** Match u.gg's CountersContainer: exclude rounded pick rate <0.5%,
 * flip the page champion's WR and GD15, then preserve source order on ties.
 * No independent sample gate or personal-pool reordering. */
export function rankUggCounters(raw: unknown, champions: readonly ChampionRef[]) {
  if (!Array.isArray(raw)) throw new Error("u.gg matchup rows missing");
  const names = new Map(champions.map(c => [c.id, c.name]));
  const seen = new Set<number>();
  const rows: DraftCounterSuggestion[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") throw new Error("Invalid u.gg matchup");
    const { champion_id: id, win_rate: wr, gold_adv_15: gold, matches: games, pick_rate: pick } = row;
    if (![id, wr, gold, games, pick].every(x => typeof x === "number" && Number.isFinite(x)) ||
        !Number.isInteger(id) || id <= 0 || games <= 0 || wr < 0 || wr > 100 || pick < 0) {
      throw new Error("Invalid u.gg matchup statistics");
    }
    if (pick < 0.5 || seen.has(id)) continue;
    const name = names.get(id);
    if (!name) throw new Error(`Champion ${id} is missing from the champion directory`);
    seen.add(id);
    rows.push({ champId: id, name, winRate: Math.round((100 - wr) * 100) / 10000,
      goldAt15: -gold, games });
  }
  return {
    bestLaneCounters: [...rows].sort((a, b) => b.goldAt15 - a.goldAt15).slice(0, UGG_BEST_LIMIT),
    worstPicks: [...rows].sort((a, b) => a.winRate - b.winRate).slice(0, UGG_WORST_LIMIT),
  };
}
