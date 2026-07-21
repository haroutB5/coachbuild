// ─────────────────────────────────────────────────────────────────────────────
// draftBansTable.ts — pure row-shaping for DraftBansTable.tsx (draft redesign
// plan §3/§5.3). JSX-free .ts module for the same vitest-import reason as
// draftRadarGeom.ts/draftPicksTable.ts (see either file's header).
// ─────────────────────────────────────────────────────────────────────────────

import type { DraftBanResult, DraftConfidence } from "@/components/live/draftRecommend";
import type { ChampionIconEntry } from "@/components/proAssets";
import type { DifficultyBand } from "@/lib/draft/difficulty";

type ChampEntryWithMeta = ChampionIconEntry & { difficultyBand?: DifficultyBand | null };

/** Same ceiling DraftResultRow's ban variant uses (lib/draft/score.ts's
 *  rankBans scores are a priority MAGNITUDE, not a winrate — observed live
 *  range ~0.02-0.07; 0.12 gives headroom before any real score maxes the
 *  bar). Kept as its own constant here (not imported from DraftResultRow)
 *  since that file isn't a shared module by design. */
export const BAN_PRIORITY_BAR_CEILING = 0.12;

export interface BanRow {
  champId: number;
  rank: number;
  name: string;
  icon: string;
  score: number;
  confidence: DraftConfidence;
  minGames: number | null;
  difficultyBand: DifficultyBand | null;
}

export function buildBanRows(bans: DraftBanResult[], champIcons: Map<number, ChampionIconEntry>): BanRow[] {
  return bans.map((ban, i) => {
    const entry = champIcons.get(ban.champId) as ChampEntryWithMeta | undefined;
    return {
      champId: ban.champId,
      rank: i + 1,
      name: entry?.name ?? `Champion #${ban.champId}`,
      icon: entry?.icon ?? "",
      score: ban.score,
      confidence: ban.confidence,
      minGames: ban.minGames,
      difficultyBand: entry?.difficultyBand ?? null,
    };
  });
}

/** Bar width % clamped [2, 100] — the 2% floor keeps a genuinely nonzero
 *  priority visible instead of a bar that reads as empty/broken. */
export function banPriorityBarPct(score: number): number {
  return Math.min(100, Math.max(2, (score / BAN_PRIORITY_BAR_CEILING) * 100));
}
