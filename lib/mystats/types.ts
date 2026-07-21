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
}

// ── Local Riot match-v5 shapes (only the fields this feature reads) ────────
// participants carry ONLY what's needed for extraction — puuid/teamId/
// championId/teamPosition/win — never store more than champion ids + win
// for anyone other than the tracked account (privacy posture, see the
// migration's header comment).

export interface MyRiotParticipant {
  puuid: string;
  teamId: number;
  championId: number;
  teamPosition: string; // "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | ""
  win: boolean;
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
