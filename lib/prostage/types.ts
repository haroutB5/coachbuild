// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/types.ts — Phase 2 pro-stage (official esports) match-history
// types. Separate identity model from lib/pro/types.ts: no puuid, keyed by
// (game_id, player_link) instead. Raw shapes here are DEFENSIVE — Leaguepedia's
// Cargo API is undocumented/community-run and field presence varies by
// tournament/era.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProGameRunes, ProRoleId } from "@/lib/pro/types";

// ── Leaguepedia Cargo raw shapes (partial — only fields we request) ────────
// A field requested with an underscore (e.g. "DateTime_UTC") can come back
// keyed with a SPACE ("DateTime UTC") in the JSON response — verified in a
// sister project. Always read through lib/prostage/cargo.ts's cargoField()
// helper, never index these interfaces directly by the underscore key.

export interface CargoScoreboardPlayerRow {
  Link?: string;
  Champion?: string;
  Items?: string; // comma-separated; NAME or numeric-id form, both handled
  Trinket?: string;
  Runes?: string; // comma-separated rune names; may be absent/empty
  KeystoneRune?: string;
  PrimaryTree?: string;
  SecondaryTree?: string;
  SummonerSpells?: string; // comma-separated
  Kills?: string;
  Deaths?: string;
  Assists?: string;
  Team?: string;
  Role?: string;
  GameId?: string;
  OverviewPage?: string;
  PlayerWin?: string; // Cargo boolean serialization varies ("1"/""/"Yes"/"No")
  Patch?: string; // not confirmed present on ScoreboardPlayers — best-effort
  [key: string]: string | undefined; // tolerate the space-vs-underscore twin key
}

export interface CargoTournamentRow {
  OverviewPage?: string;
  League?: string;
  DateStart?: string;
  Date?: string; // Leaguepedia's Tournaments table names the END date "Date"
  [key: string]: string | undefined;
}

// ── ddragon raw shapes (partial) ─────────────────────────────────────────────

export interface DdragonChampionEntry {
  key: string; // numeric champion id, as a string
  id: string; // internal key e.g. "MonkeyKing"
  name: string; // display name e.g. "Wukong"
}

export interface DdragonChampionData {
  data: Record<string, DdragonChampionEntry>;
}

export interface DdragonItemEntry {
  name: string;
}

export interface DdragonItemData {
  data: Record<string, DdragonItemEntry>; // key = numeric item id as string
}

export interface DdragonSummonerEntry {
  key: string; // numeric spell id, as a string
  name: string;
}

export interface DdragonSummonerData {
  data: Record<string, DdragonSummonerEntry>;
}

export interface DdragonRune {
  id: number;
  name: string;
}

export interface DdragonRuneSlot {
  runes: DdragonRune[];
}

export interface DdragonRuneStyle {
  id: number;
  name: string; // e.g. "Domination"
  slots: DdragonRuneSlot[];
}

export type DdragonRunesReforged = DdragonRuneStyle[];

// ── Resolved lookup maps (built once per process from ddragon) ─────────────

export interface ResolvedRune {
  id: number;
  parentStyleId: number;
}

export interface DdragonMaps {
  version: string;
  championByName: Map<string, number>; // normalized name -> champion id
  championNameById: Map<number, string>; // champion id -> canonical ddragon name
  itemByName: Map<string, number>; // normalized name -> item id
  summonerByName: Map<string, number>; // normalized spell name -> spell id
  runeByName: Map<string, ResolvedRune>; // normalized rune name -> {id, parentStyleId}
  styleByName: Map<string, number>; // normalized tree name (e.g. "domination") -> style id
}

// ── Internal extracted row (pure, DB-shape-agnostic) ────────────────────────

export interface ExtractedProstageRow {
  gameId: string;
  playerLink: string;
  overviewPage: string;
  tournamentDisplay: string;
  team: string | null;
  championId: number;
  championName: string;
  role: ProRoleId | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gameDatetime: string; // ISO
  patch: string | null;
  spells: [number, number];
  finalItems: number[];
  trinket: number | null;
  runes: ProGameRunes;
}

// ── Internal DB row shape (coachbuild.prostage_matches) ─────────────────────

export interface ProstageMatchRow {
  game_id: string;
  player_link: string;
  overview_page: string;
  tournament_display: string;
  team: string | null;
  champion_id: number;
  champion_name: string;
  role: number | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  game_datetime: string | Date;
  patch: string | null;
  spells: unknown;
  final_items: unknown;
  trinket: number | null;
  runes: unknown;
  pro_id: string | null;
}
