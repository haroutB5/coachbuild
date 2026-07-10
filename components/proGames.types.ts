// ─────────────────────────────────────────────────────────────────────────────
// Local types for the Pro Games feature — mirror the /api/pros contract.
// Deliberately NOT imported from lib/types.ts (backend-owned, in-flight in
// parallel with this work) — see HANDOFF-fronty.md for the contract this was
// built against.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProGamePlayer {
  name: string;
  team: string | null;
  role: number;
  country: string | null;
}

export interface ProGameAccount {
  riotId: string;
  region: string;
}

export interface ProGamePurchase {
  itemId: number;
  ts: number; // seconds into the game
}

export interface ProGameRunes {
  primaryTree: number;
  keystone: number;
  primary: number[]; // 3 ids
  secondaryTree: number;
  secondary: number[]; // 2 ids
  shards: number[]; // 3 ids
}

export interface ProGame {
  id: string;
  source: "soloq" | "prostage";
  /** Prostage only — e.g. "MSI 2026", "LCK Summer 2026". */
  tournament?: string;
  player: ProGamePlayer;
  account: ProGameAccount;
  championId: number;
  championName: string;
  role: number;
  patch: string; // "16.13" — may be empty for prostage
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gameCreation: string; // ISO
  gameDurationSec: number; // 0 = unknown (prostage only) — hide in UI
  spells: [number, number];
  finalItems: number[];
  trinket: number | null;
  purchaseOrder: ProGamePurchase[]; // [] for prostage (no purchase data)
  skillOrder: string[]; // ["Q","W","E","Q",...] — [] for prostage
  runes: ProGameRunes; // primary/secondary/shards may be [] for prostage
  /** CoachBuild Score — 0-100 int, always present (server derives it from
   *  KDA + win at minimum, even without cs/team_kills). */
  score: number;
  grade: ProGameGrade;
  /** null until the migration-0004 backfill reaches this row (soloq) or
   *  always null (prostage — Leaguepedia Cargo has no CS/team-kill data).
   *  Must keep rendering nothing when null, not a dash/zero. */
  csPerMin: number | null;
  kp: number | null;
}

export interface ProGamesApiResponse {
  games: ProGame[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Source filter — shared "All | Solo Queue | Pro Play" control used on both
// the home page Pro Games section and /history results.
// ─────────────────────────────────────────────────────────────────────────────

export type ProGameSource = "all" | "soloq" | "prostage";

/** CoachBuild Score grade letter — mirrors lib/pro/score.ts's CoachBuildGrade
 *  (this file stays independent of lib/pro/types.ts by design, see header
 *  comment). S is best, D is worst — see components/ScoreChip.ts for the
 *  grade -> color mapping. */
export type ProGameGrade = "S" | "A" | "B" | "C" | "D";

export const SOURCE_FILTER_OPTIONS: { value: ProGameSource; label: string }[] = [
  { value: "all", label: "All" },
  { value: "soloq", label: "Solo Queue" },
  { value: "prostage", label: "Pro Play" },
];

/** Filter-aware empty-state title, e.g. "No pro-play games tracked yet for Faker". */
export function proGamesEmptyTitle(source: ProGameSource, subjectName: string): string {
  if (source === "prostage") return `No pro-play games tracked yet for ${subjectName}`;
  if (source === "soloq") return `No solo queue games tracked yet for ${subjectName}`;
  return `No tracked games yet for ${subjectName}`;
}

/** Filter-aware empty-state subtext. */
export function proGamesEmptySub(source: ProGameSource): string {
  if (source === "prostage") return "Check back after their next official match.";
  if (source === "soloq") return "Check back after their next solo queue session.";
  return "Check back after their next tracked game.";
}
