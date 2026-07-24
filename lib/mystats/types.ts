// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/types.ts — "My Stats" personal match tracker types. Separate
// identity/contract from lib/pro/types.ts (that file's ProGame/ProsResponse
// is a shared FRONTEND contract for a roster of tracked pros; this feature
// has no roster and no frontend contract yet — backend-only ship, see
// CLAUDE.md). Deliberately does NOT import lib/pro/types.ts's RiotMatch —
// that interface omits `info.queueId` (never needed by the pro pipeline),
// and this feature needs it, so a local, narrower Riot shape is defined here
// instead of widening the shared contract for one new consumer.
// ─────────────────────────────────────────────────────────────────────────────

export interface MyAccountRow {
  id: number;
  riot_id: string;
  puuid: string;
  region: string;
  created_at: string;
}

/** DisplayRoleId-shaped (lib/pro/types.ts): 0-4 concrete, -1 unresolved. Kept
 *  as a local alias rather than importing DisplayRoleId so this module has
 *  no hard dependency on the pro contract file evolving underneath it. */
export type MyRoleId = 0 | 1 | 2 | 3 | 4 | -1;

export interface ExtractedMyMatch {
  matchId: string;
  queueId: number;
  gameCreation: string; // ISO
  patch: string;
  championId: number;
  role: MyRoleId;
  oppChampionId: number | null;
  win: boolean;
  /** v0.51 additions (My Stats build-adherence + KDA, migration 0014). */
  kills: number;
  deaths: number;
  assists: number;
  /** Final item slots 0-5 (the 6 build slots; trinket/item6 excluded). */
  itemIds: number[];
  /** Primary-tree keystone rune id, null when perks are missing/malformed. */
  primaryKeystone: number | null;
  /** 1-indexed within-season split (lib/mystats/season.ts's
   *  SPLIT_BOUNDARIES) — a pure function of gameCreation, computed here so
   *  ingest.ts doesn't need to re-derive it. */
  split: number;
}

export interface MyMatchRow {
  match_id: string;
  queue_id: number;
  game_creation: string;
  patch: string;
  champion_id: number;
  role: MyRoleId;
  opp_champion_id: number | null;
  win: boolean;
  ingested_at: string;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  item_ids: number[] | null;
  primary_keystone: number | null;
  /** Null on any row ingested before v0.51 and never Riot/recommend-
   *  backfilled (see the migration's header) — see lib/mystats/adherence.ts's
   *  computeAdherence doc comment for the null/false distinction. */
  on_wpa_build: boolean | null;
  split: number | null;
}

// ── Local Riot match-v5 shapes (only the fields this feature reads) ────────
// participants carry ONLY what's needed for extraction — puuid/teamId/
// championId/teamPosition/win — never store more than champion ids + win
// for anyone other than the tracked account (privacy posture, see the
// migration's header comment).

/** perks.styles[].description is always "primaryStyle" | "subStyle" on a real
 *  match-v5 response; typed as `string` (not a union) so a malformed/future
 *  Riot value degrades to "not found" instead of a type error. */
export interface MyRiotPerkStyle {
  description: string;
  selections: { perk: number }[];
}

export interface MyRiotParticipant {
  puuid: string;
  teamId: number;
  championId: number;
  teamPosition: string; // "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | ""
  win: boolean;
  /** v0.51 additions (My Stats build-adherence + KDA). */
  kills: number;
  deaths: number;
  assists: number;
  /** Final build slots 0-5 (item6 is the trinket -- deliberately NOT read
   *  here, see extract.ts's header). */
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  /** Optional/absent on a malformed fixture or a genuinely perk-less remake
   *  -- extract.ts degrades to a null primaryKeystone rather than crashing. */
  perks?: { styles: MyRiotPerkStyle[] };
}

export interface MyRiotMatch {
  metadata: { matchId: string };
  info: {
    gameCreation: number; // epoch ms
    gameVersion: string; // "14.13.567.1234"
    queueId: number;
    participants: MyRiotParticipant[];
  };
}
