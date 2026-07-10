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
  /** Leaguepedia player-slug identifier for prostage rows — required by
   *  GET /api/prostage/timeline?gameId=&player=. NOT YET on the backend
   *  contract: app/api/pros/route.ts's prostageRowToProGame() reads
   *  `row.player_link` for row validation but never puts it on the
   *  returned ProGame, and lib/pro/types.ts's ProGame (the real contract)
   *  has no such field either — see HANDOFF-fronty.md, flagged for engy to
   *  add a passthrough. Optional here so this file still compiles against
   *  today's actual API response; components read `game.playerLink`
   *  defensively (undefined -> treated as "unavailable", no crash). */
  playerLink?: string;
  /** Ally + enemy team comps (5 champion ids each) for the dpm.lol-style
   *  comp strip on the card + the sheet's Teams section. allyChampionIds
   *  INCLUDES the player's own champion (== championId) — used to highlight
   *  it among its 4 teammates. Mirrors engy's concurrent addition to the
   *  backend ProGame contract (lib/pro/types.ts) — both fields are absent
   *  until backfill covers a given game, so components must render NOTHING
   *  (no skeleton, no placeholder gap) when either is undefined, not just
   *  when the array is empty. */
  allyChampionIds?: number[];
  enemyChampionIds?: number[];
}

export interface ProGamesApiResponse {
  games: ProGame[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Source filter — shared "All | Solo Queue | Pro Play" control used on both
// the home page Pro Games section and /history results.
// ─────────────────────────────────────────────────────────────────────────────

export type ProGameSource = "all" | "soloq" | "prostage";

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
