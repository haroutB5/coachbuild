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

/** One roster slot in the sheet's per-player Teams boxes — engy's concurrent
 *  contract addition, mirrored here verbatim (see dispatch brief in
 *  HANDOFF-fronty.md). `items`/`trinket` are the player's FINAL build for
 *  that game, not a purchase timeline. `role` is the same 0-4 ProRoleId
 *  vocabulary used elsewhere on ProGame — null when unresolved (prostage-only
 *  possibility, mirrors the top-level `role: -1` sentinel pattern but as
 *  null since this is a per-slot field, not the outward DisplayRoleId). */
export interface TeamCompPlayer {
  championId: number;
  name: string | null;
  items: number[];
  trinket: number | null;
  role: number | null;
  /** pros.id UUID when this roster slot is a TRACKED pro player — engy's
   *  concurrent contract addition, mirrored here verbatim (see
   *  HANDOFF-fronty.md). Null for an untracked/unlinked slot (common on
   *  soloq teammates, or a prostage player never matched to a `pros` row).
   *  Drives the Teams-box tap-to-view-that-player's-games affordance — a
   *  row is only tappable when this OR `playerLink` is non-null. */
  proId?: string | null;
  /** RAW Leaguepedia player_link — engy's concurrent contract addition,
   *  mirrored here verbatim from lib/pro/types.ts's TeamCompPlayer. Set for
   *  every prostage roster entry (tracked AND untracked); null for every
   *  soloq entry (no player_link identity model there). Makes an UNTRACKED
   *  prostage player (no `proId`, e.g. a teammate with no `pros` row)
   *  navigable too — the row is tappable via this field alone, fetching
   *  GET /api/pros?player=<playerLink>&source=prostage (forced Pro Play,
   *  no soloq data exists for a player with no tracked account). Optional:
   *  absent is equivalent to null for consumers, same posture as `proId`. */
  playerLink?: string | null;
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
  /** Cleaned pro-play team names ("LYON", "HLE" — no more
   *  "(2024 American Team)"-style suffix), engy's concurrent contract
   *  addition mirrored verbatim. Prostage-only; absent for soloq (no
   *  organized "team" concept for a solo queue game) and absent for a
   *  prostage row not yet backfilled/resolved — components must degrade to
   *  the existing fallback title ("Ally team — <player.team>" / "Enemy
   *  team") rather than rendering an empty/undefined string. */
  allyTeamName?: string | null;
  enemyTeamName?: string | null;
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
