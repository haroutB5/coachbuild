// ─────────────────────────────────────────────────────────────────────────────
// draftPicksTable.ts — pure row-shaping/sort logic for DraftPicksTable.tsx
// (draft redesign plan §3/§4). Split into its own JSX-free .ts module for the
// same reason draftRadarGeom.ts is (this repo's vitest config can't parse a
// .tsx module's JSX from a .ts test importer — confirmed live on this ship,
// see that file's header comment).
//
// Defensive typing note: `DraftPlayResult` (components/live/draftRecommend.ts)
// and `ChampionIconEntry` (components/proAssets.ts) are engo's Stage-0 files
// — this module widens both LOCALLY with optional fields rather than editing
// those shared files directly, so it compiles regardless of merge order (see
// HANDOFF-fronty.md / the matchday tennis defensive-field pattern this
// mirrors). Once engo's additive fields land for real, these locals just
// become redundant (harmless) rather than wrong.
// ─────────────────────────────────────────────────────────────────────────────

import type { DraftPlayResult, DraftConfidence, PersonalRecord } from "@/components/live/draftRecommend";
import type { ChampionIconEntry } from "@/components/proAssets";
import type { DifficultyBand } from "@/lib/draft/difficulty";
import type { SynergyBand } from "@/lib/draft/score";

type PlayWithSynergy = DraftPlayResult & { synergyDelta?: number; synergyBand?: SynergyBand };
type ChampEntryWithMeta = ChampionIconEntry & {
  difficulty?: number | null;
  difficultyBand?: DifficultyBand | null;
};

export interface PickRow {
  champId: number;
  /** 1-based, server-ranked order — the table's DEFAULT sort and the only
   *  order the honesty gate (plan §5.4) treats as "CoachBuild's ranking". */
  rank: number;
  name: string;
  icon: string;
  /** 0..1 fraction, same scale as DraftResultRow's scoreFraction. */
  score: number;
  winVsLaneOpp: number | null;
  confidence: DraftConfidence;
  minGames: number | null;
  personal: PersonalRecord | null;
  personalOverall: PersonalRecord;
  difficulty: number | null;
  difficultyBand: DifficultyBand | null;
  /** = score - baselineWr (lib/draft/score.ts). Defaults to 0/"Even" when
   *  absent on the wire (older cached response, or Stage 0 not landed yet)
   *  — matches engo's own normalizer default exactly, never a fabricated
   *  non-zero value. */
  synergyDelta: number;
  synergyBand: SynergyBand;
}

/** Shapes the server-ranked `plays`/`potentialPlays` array into display rows
 *  — `rank` is always the INPUT order's index + 1 (never re-derived from a
 *  score sort), so the "server's honest rank" stays traceable even after a
 *  display-only client sort reorders the rendered rows. */
export function buildPickRows(plays: DraftPlayResult[], champIcons: Map<number, ChampionIconEntry>): PickRow[] {
  return plays.map((play, i) => {
    const p = play as PlayWithSynergy;
    const entry = champIcons.get(play.champId) as ChampEntryWithMeta | undefined;
    return {
      champId: play.champId,
      rank: i + 1,
      name: entry?.name ?? `Champion #${play.champId}`,
      icon: entry?.icon ?? "",
      score: play.score,
      winVsLaneOpp: play.winVsLaneOpp,
      confidence: play.confidence,
      minGames: play.winVsLaneOppGames ?? play.minGames,
      personal: play.personal,
      personalOverall: play.personalOverall,
      difficulty: entry?.difficulty ?? null,
      difficultyBand: entry?.difficultyBand ?? null,
      synergyDelta: p.synergyDelta ?? 0,
      synergyBand: p.synergyBand ?? "Even",
    };
  });
}

export type PickSortKey = "rank" | "winRate" | "difficulty" | "synergy";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: PickSortKey;
  dir: SortDir;
}
export const DEFAULT_PICK_SORT: SortState = { key: "rank", dir: "asc" };

export function isDefaultPickSort(sort: SortState): boolean {
  return sort.key === "rank";
}

function sortValue(row: PickRow, key: PickSortKey): number {
  switch (key) {
    case "winRate":
      return row.score;
    case "difficulty":
      return row.difficulty ?? -1; // unknown difficulty sorts lowest, never crashes a compare
    case "synergy":
      return row.synergyDelta;
    case "rank":
      return row.rank;
  }
}

/** Pure display transform — NEVER mutates `rows`, never touches server rank
 *  assignment. "rank" is always server order regardless of `dir` (toggling a
 *  "reverse" on the honest ranking isn't a meaningful sort). Ties on a
 *  non-rank key stable-tiebreak back to server rank, ASC, so a repeat sort
 *  is deterministic. */
export function sortPickRows(rows: PickRow[], sort: SortState): PickRow[] {
  if (sort.key === "rank") return rows;
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const d = sortValue(a, sort.key) - sortValue(b, sort.key);
    if (d !== 0) return factor * d;
    return a.rank - b.rank;
  });
}

/** Header-click reducer — clicking "Rank" always resets to the default
 *  (server) order; clicking a different numeric column starts at DESC
 *  ("biggest first" is the more useful first click for Win Rate/Synergy);
 *  clicking the SAME column again toggles direction. */
export function nextPickSortState(current: SortState, clickedKey: PickSortKey): SortState {
  if (clickedKey === "rank") return DEFAULT_PICK_SORT;
  if (current.key === clickedKey) return { key: clickedKey, dir: current.dir === "desc" ? "asc" : "desc" };
  return { key: clickedKey, dir: "desc" };
}

export function ariaSortFor(column: PickSortKey, sort: SortState): "ascending" | "descending" | "none" {
  if (sort.key !== column) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

const SORT_COLUMN_LABEL: Record<PickSortKey, string> = {
  rank: "Rank",
  winRate: "Win Rate",
  difficulty: "Difficulty",
  synergy: "Matchup Synergy",
};

/** Caption shown ONLY when a non-default sort is active (plan §5.4's
 *  honesty requirement — a sorted view must say so, and say the ranking
 *  itself is still CoachBuild's, not the user's re-sort). Null on default
 *  sort (nothing to caveat). */
export function pickSortCaption(sort: SortState): string | null {
  if (isDefaultPickSort(sort)) return null;
  return `Sorted by ${SORT_COLUMN_LABEL[sort.key]} — ranking is CoachBuild's own.`;
}

export function difficultyLabel(band: DifficultyBand | null): string {
  return band ?? "—";
}

export function synergyLabel(band: SynergyBand): string {
  return band;
}

/** Color = STATE, not decoration (craft bar) — Strong/Weak reuse the app's
 *  existing global WPA/winrate semantic tokens (text-good/text-bad), the
 *  SAME green/red meaning used everywhere else in this codebase for a
 *  performance signal; "Even" stays neutral/muted, never colored. */
export function synergyClass(band: SynergyBand): string {
  if (band === "Strong") return "text-good";
  if (band === "Weak") return "text-bad";
  return "text-[color:var(--dt-mut)]";
}
