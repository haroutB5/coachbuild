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
  /** Migration 0020 (multi-account): exactly one row has this true, enforced
   *  by the partial unique index my_account_one_active_idx. */
  active: boolean;
  /** Migration 0020: when the companion last reported this account as the one
   *  logged into the League client. Null = never detected (env-seeded, or
   *  linked before this column existed). */
  last_seen_at: string | null;
  /** Migration 0022 (ranked tier/LP). All six value columns move together —
   *  see the migration's header. Read them through lib/mystats/rank.ts's
   *  `rankFromRow`, which is the one place that turns them into the
   *  unranked-vs-unknown distinction the API contract promises. */
  rank_tier: string | null;
  rank_division: string | null;
  rank_lp: number | null;
  rank_wins: number | null;
  rank_losses: number | null;
  /** Last SUCCESSFUL read. NULL here is the ONLY thing that means "we have
   *  never known this account's rank" — do not infer it from rank_tier. */
  rank_checked_at: string | null;
  /** Last attempt, success or failure. TTL gate only; never displayed. */
  rank_attempted_at: string | null;
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
  /** Migration 0021 — creep score (lane minions + neutral monsters) and the
   *  game length in SECONDS that divides it. RAW, never a pre-divided rate:
   *  see the migration's header for why a stored rate cannot be re-aggregated.
   *  Both are always present on a freshly extracted row (match-v5 always
   *  carries them); NULL only ever appears on rows stored before 0021. */
  cs: number;
  gameDurationSec: number;
}

export interface MyMatchRow {
  match_id: string;
  /** Migration 0020 — WHOSE game this is. Half of the primary key
   *  (puuid, match_id), and the mandatory filter on every read: an unscoped
   *  SELECT over this table merges two players into one set of numbers with no
   *  visible symptom (see the migration's header). */
  puuid: string;
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
  /** The exact patch of the immutable recommendation snapshot used for this
   * boolean. Null with on_wpa_build null means no measured comparison exists. */
  wpa_recommendation_patch: string | null;
  split: number | null;
  /** Migration 0021. NULL on any row stored before that migration and not yet
   *  run through scripts/backfill-mystats-cs.mjs. NULL means NOT MEASURED and
   *  must never be read as 0 — lib/mystats/cs.ts drops such a row from every
   *  figure rather than counting it as a zero-CS game. */
  cs: number | null;
  game_duration_sec: number | null;
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
  /** Migration 0021 (CS/min). The two halves of creep score -- summed by
   *  lib/pro/extract.ts's creepScore(), which is shared with the pro/OTP
   *  pipelines so both cannot drift on what "CS" means. */
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
}

export interface MyRiotMatch {
  metadata: { matchId: string };
  info: {
    gameCreation: number; // epoch ms
    gameVersion: string; // "14.13.567.1234"
    queueId: number;
    /** SECONDS. Riot's own unit for gameDuration has been seconds since patch
     *  11.20 (before that it was milliseconds on games with no
     *  gameEndTimestamp). Every row this table can ever hold is season-scoped
     *  to 2026 (lib/mystats/season.ts's SEASON_START_MS), so the millisecond
     *  form is unreachable here and is deliberately NOT branched on — a guard
     *  keyed on magnitude would be untestable against real data and would
     *  silently rescale a legitimately long game. Verified against the live
     *  table instead: measured min/max durations sit in the normal
     *  15-45-minute band, see HANDOFF-engy.md. */
    gameDuration: number;
    participants: MyRiotParticipant[];
  };
}
