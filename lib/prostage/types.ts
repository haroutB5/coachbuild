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
//
// TRANSPORT-SHAPE QUIRK (live-verified 2026-07-10, one real row of
// LCK/2026 Season/Road to MSI via Special:CargoExport): Cargo "List" type
// fields come back as genuine JSON ARRAYS via CargoExport, not the
// delimiter-joined strings api.php returns for the SAME fields — confirmed
// for Items (List (;) of String) and SummonerSpells (List (,) of String).
// Numeric-typed fields (Kills/Deaths/Assists) also came back as JSON NUMBERS
// via CargoExport, vs strings via api.php. Runes and PlayerWin were BOTH
// still plain strings via CargoExport in the probed row (Runes is a single
// comma-joined String field, not an actual Cargo List type) — typed as
// `string | string[]` / `string | number` here anyway as a cheap hedge in
// case a future/different tournament's data differs, since
// lib/prostage/extract.ts's parseList()/parseCargoInt() already normalize
// both shapes for free. Always read Items/SummonerSpells/Kills/Deaths/
// Assists via cargoField<T>() with an explicit type param (e.g.
// `cargoField<string | string[]>(raw, "Items")`) — see extract.ts.

export interface CargoScoreboardPlayerRow {
  Link?: string;
  Champion?: string;
  Items?: string | string[]; // "List (;) of String" via api.php; a real JSON array via CargoExport
  Trinket?: string;
  Runes?: string | string[]; // comma-separated string in practice; array-typed defensively (see header note)
  KeystoneRune?: string;
  PrimaryTree?: string;
  SecondaryTree?: string;
  SummonerSpells?: string | string[]; // "List (,) of String" via api.php; a real JSON array via CargoExport
  Kills?: string | number;
  Deaths?: string | number;
  Assists?: string | number;
  Team?: string;
  Role?: string;
  GameId?: string;
  OverviewPage?: string;
  PlayerWin?: string; // Cargo boolean serialization varies ("1"/""/"Yes"/"No")
  // NO Patch field — confirmed absent from ScoreboardPlayers' real Cargo
  // schema (Module:CargoDeclare/ScoreboardPlayers). Requesting it caused a
  // live MWException on every call that got past the rate limiter; removed
  // from the query, not represented here.
  [key: string]: string | number | string[] | undefined; // tolerate the space-vs-underscore twin key + the shapes above
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
