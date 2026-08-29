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
  /** 0..1 — the ban target's winrate vs your pick (how often they beat you). */
  winVsYou: number | null;
  /** v0.51 redesign wave A (mockup's REASON column) — see banReason()'s doc
   *  comment for exactly what drives each variant and the one deliberate
   *  deviation from the mockup's copy. */
  reason: string;
}

/** Lane-bully threshold — same magnitude BAN_PRIORITY_BAR_CEILING's own
 *  comment cites as "real range" (winVsYou this high is a genuine, repeated
 *  matchup advantage, not sampling noise at typical ban-list sample sizes). */
const LANE_BULLY_WIN_FLOOR = 0.55;

/** Builds the ban row's REASON string. Two of the mockup's three copy
 *  patterns map directly onto `winVsYou`, which is real per-matchup data:
 *    - >= LANE_BULLY_WIN_FLOOR  -> "lane bully, 56.0%"
 *    - present, below the floor -> "56.0% into you"
 *  The third mockup pattern ("denies your sustain") stays out, and the reason
 *  was RESTATED 2026-08-29 because the one it used to give expired. It used to
 *  cite compHighlight.ts's header for "no per-champion damage-type/kit-tag
 *  classification exists here". That file is deleted, and the claim had already
 *  stopped being true: lib/draft/compRatings.ts curates six kit axes and
 *  lib/enemyComp/damageType.ts carries a damage-type row per champion.
 *
 *  The refusal survives on a better argument. "Denies your sustain" is an
 *  ANTI-HEAL claim, and anti-heal is the one axis that was measured and found
 *  undeliverable: across 24 production champion-roles an anti-heal item is
 *  reachable anywhere in a champion's own data for only 9, and for none of the
 *  AP champions sampled (see lib/enemyComp/counterItems.ts's ANTI_HEAL note and
 *  the 2026-08-29 user decision). So the copy would be asserting a counter the
 *  reader frequently cannot act on, which is worse than generic, and it would
 *  contradict this file's own "data-honest, no fabricated stats" brief.
 *  So the no-matchup-data fallback below is an honest, category-neutral
 *  string instead of literally reproducing that mockup line — flagged here
 *  as a deliberate contract deviation, not an oversight. */
export function banReason(winVsYou: number | null): string {
  if (winVsYou === null) return "High ban priority";
  const pct = (winVsYou * 100).toFixed(1);
  return winVsYou >= LANE_BULLY_WIN_FLOOR ? `lane bully, ${pct}%` : `${pct}% into you`;
}

/** Format winVsYou as a whole-percent string, or "—" when absent. */
export function banWinVsYouLabel(winVsYou: number | null): string {
  return winVsYou === null ? "—" : `${Math.round(winVsYou * 100)}%`;
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
      winVsYou: ban.winVsYou ?? null,
      reason: banReason(ban.winVsYou ?? null),
    };
  });
}

/** Bar width % clamped [2, 100] — the 2% floor keeps a genuinely nonzero
 *  priority visible instead of a bar that reads as empty/broken. */
export function banPriorityBarPct(score: number): number {
  return Math.min(100, Math.max(2, (score / BAN_PRIORITY_BAR_CEILING) * 100));
}
