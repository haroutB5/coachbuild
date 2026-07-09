// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/types.ts — Phase 1 pro-match-history types.
// THE CONTRACT for GET /api/pros lives on ProGame/ProsResponse — fronty builds
// against this exactly. Do not diverge without updating both sides.
// ─────────────────────────────────────────────────────────────────────────────

/** 0=TOP 1=JUNGLE 2=MIDDLE 3=BOTTOM 4=UTILITY — same numbering as app RoleId,
 *  minus the 5=auto sentinel (pro match data always has a concrete role). */
export type ProRoleId = 0 | 1 | 2 | 3 | 4;

export interface ProGamePlayer {
  name: string;
  team: string | null;
  role: ProRoleId;
  country: string | null;
}

export interface ProGameAccount {
  riotId: string; // "gameName#tagLine"
  region: string; // lolpros server string, e.g. "EUW", "KR"
}

export interface ProGameRunes {
  primaryTree: number;
  keystone: number;
  primary: number[]; // 3 non-keystone primary rune ids
  secondaryTree: number;
  secondary: number[]; // 2 ids
  shards: number[]; // [offense, flex, defense]
}

export interface ProGamePurchase {
  itemId: number;
  ts: number; // seconds into the game (converted from Riot's raw ms timeline timestamp)
}

/** THE CONTRACT — GET /api/pros response element. */
export interface ProGame {
  id: string; // matchId
  source: "soloq";
  player: ProGamePlayer;
  account: ProGameAccount;
  championId: number;
  championName: string;
  role: ProRoleId;
  patch: string; // "16.13"
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gameCreation: string; // ISO
  gameDurationSec: number;
  spells: [number, number];
  finalItems: number[]; // item0-5, 0s filtered out
  trinket: number | null; // item6
  purchaseOrder: ProGamePurchase[]; // undo-adjusted, chronological
  skillOrder: string[]; // ["Q","W","E","Q",...]
  runes: ProGameRunes;
}

export interface ProsResponse {
  games: ProGame[];
}

// ── lolpros.gg raw shapes (partial + defensive — undocumented API) ──────────
// Verified live 2026-07-09. Ladder entries carry ONE (main) account; profiles
// carry the FULL account list under league_player.accounts.

export interface LolProsAccountRaw {
  uuid?: string;
  server?: string;
  encrypted_puuid?: string | null;
  summoner_name?: string; // "gamename#tagline" display form
  gamename?: string;
  tagline?: string;
  summoner_names?: { name: string; created_at?: string }[];
}

export interface LolProsTeamRaw {
  name?: string;
  tag?: string;
  slug?: string;
}

export interface LolProsLadderEntry {
  uuid: string;
  name: string;
  slug: string;
  country: string | null;
  position: string | null; // "20_jungle", "30_mid", "40_adc", "10_top", "50_support"
  team: LolProsTeamRaw | null;
  account: LolProsAccountRaw | null;
}

export interface LolProsProfile {
  uuid: string;
  name: string;
  slug: string;
  country: string | null;
  position: string | null;
  team: LolProsTeamRaw | null;
  accounts: LolProsAccountRaw[];
}

// ── Riot API raw shapes (partial — only the fields we consume) ──────────────

export interface RiotAccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface RiotPerkSelection {
  perk: number;
  var1?: number;
  var2?: number;
  var3?: number;
}

export interface RiotPerkStyle {
  description: string; // "primaryStyle" | "subStyle"
  style: number;
  selections: RiotPerkSelection[];
}

export interface RiotPerks {
  statPerks: { defense: number; flex: number; offense: number };
  styles: RiotPerkStyle[];
}

export interface RiotParticipant {
  puuid: string;
  participantId: number;
  championId: number;
  championName: string;
  teamPosition: string; // "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | ""
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  summoner1Id: number;
  summoner2Id: number;
  perks: RiotPerks;
}

export interface RiotMatch {
  metadata: { matchId: string };
  info: {
    gameCreation: number; // epoch ms
    gameDuration: number; // seconds (match-v5)
    gameVersion: string; // "14.13.567.1234"
    participants: RiotParticipant[];
  };
}

export interface RiotTimelineEvent {
  type: string;
  timestamp: number; // ms
  participantId?: number;
  itemId?: number; // ITEM_PURCHASED / ITEM_SOLD
  beforeId?: number; // ITEM_UNDO
  afterId?: number; // ITEM_UNDO
  skillSlot?: number; // SKILL_LEVEL_UP (1=Q 2=W 3=E 4=R)
  levelUpType?: string; // SKILL_LEVEL_UP
}

export interface RiotTimelineFrame {
  timestamp: number;
  events: RiotTimelineEvent[];
}

export interface RiotTimeline {
  info: { frames: RiotTimelineFrame[] };
}

// ── Internal DB row shapes ───────────────────────────────────────────────────

export interface ProRow {
  id: string;
  name: string;
  slug: string;
  team: string | null;
  role: ProRoleId | null;
  country: string | null;
  updated_at: string;
}

export interface ProAccountRow {
  puuid: string;
  pro_id: string;
  region: string;
  riot_id: string;
  active: boolean;
  last_fetched_at: string | null;
  last_match_ts: number | null;
}
