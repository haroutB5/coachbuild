// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/extract.ts — turn one Leaguepedia ScoreboardPlayers row into a
// storable ExtractedProstageRow. Pure functions, no I/O (ddragon maps are
// passed in) — easy to unit test with mocked maps.
//
// Leaguepedia's Items/Champion/SummonerSpells/Runes/KeystoneRune/PrimaryTree/
// SecondaryTree fields come back as TEXT NAMES in the common case, but this
// extractor also accepts bare numeric strings for any of them (treats a
// pure-digit token as an id directly) — a defensive hedge in case a given
// tournament/era's Cargo data was populated with raw ids instead of names.
// ─────────────────────────────────────────────────────────────────────────────

import { cargoField } from "./cargo";
import { normalizeName } from "./ddragon";
import { roleFromCargoRole } from "./roleMap";
import type { CargoScoreboardPlayerRow, DdragonMaps, ExtractedProstageRow } from "./types";
import type { ProGameRunes } from "@/lib/pro/types";

function parseCargoBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "yes" || v === "true" || v === "win";
}

/** Kills/Deaths/Assists: a plain numeric string via api.php, but a real JSON
 *  number via CargoExport (live-verified 2026-07-10 — see types.ts's header
 *  note). Handle both without assuming either. */
function parseCargoInt(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const n = parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Normalizes a Cargo "List" field into trimmed, non-empty tokens. Two
 *  live-verified shapes for the SAME logical field (2026-07-10, see
 *  types.ts's header note): api.php returns a delimiter-joined STRING
 *  (comma is Leaguepedia's typical delimiter; tolerate stray semicolons
 *  too), CargoExport returns a real JSON ARRAY of strings directly — no
 *  delimiter to split on, and splitting an array element on `,`/`;` would
 *  be wrong (an item/spell NAME could itself contain either character).
 *  `null`/`undefined`/anything else -> []. */
function parseList(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const tokens = Array.isArray(raw) ? raw : raw.split(/[,;]/);
  return tokens.map((s) => s.trim()).filter(Boolean);
}

/** Resolves one text token to a numeric id: bare digits pass through as-is,
 *  otherwise looks up the normalized name in `map`. Returns null (caller
 *  logs+skips) when neither works. */
function resolveIdOrName(token: string, map: Map<string, number>): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  return map.get(normalizeName(token)) ?? null;
}

export function tournamentDisplayFromOverviewPage(overviewPage: string): string {
  const parts = overviewPage
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  const cleaned = parts.filter((p) => p.toLowerCase() !== "season");
  const display = (cleaned.length ? cleaned : parts).join(" ");
  return display || overviewPage;
}

function resolveRunes(
  runesRaw: string | string[] | undefined,
  keystoneRaw: string | undefined,
  primaryTreeRaw: string | undefined,
  secondaryTreeRaw: string | undefined,
  maps: DdragonMaps,
  log: (msg: string) => void
): ProGameRunes {
  const primaryTree = primaryTreeRaw
    ? resolveIdOrName(primaryTreeRaw, maps.styleByName) ?? 0
    : 0;
  const secondaryTree = secondaryTreeRaw
    ? resolveIdOrName(secondaryTreeRaw, maps.styleByName) ?? 0
    : 0;

  let keystone = 0;
  if (keystoneRaw) {
    const token = keystoneRaw.trim();
    if (/^\d+$/.test(token)) {
      keystone = parseInt(token, 10);
    } else {
      keystone = maps.runeByName.get(normalizeName(token))?.id ?? 0;
    }
  }

  const primary: number[] = [];
  const secondary: number[] = [];
  for (const token of parseList(runesRaw)) {
    let resolved: { id: number; parentStyleId: number } | undefined;
    if (/^\d+$/.test(token)) {
      const id = parseInt(token, 10);
      resolved = { id, parentStyleId: 0 }; // unknown tree membership for bare ids
    } else {
      resolved = maps.runeByName.get(normalizeName(token));
    }
    if (!resolved) {
      log(`rune "${token}": unresolved, skipping`);
      continue;
    }
    if (resolved.id === keystone) continue; // don't double-list the keystone
    if (resolved.parentStyleId === primaryTree) primary.push(resolved.id);
    else if (resolved.parentStyleId === secondaryTree) secondary.push(resolved.id);
    else if (resolved.parentStyleId === 0) primary.push(resolved.id); // bare-id fallback, best guess
  }

  return { primaryTree, keystone, primary, secondaryTree, secondary, shards: [] };
}

/** Parses Leaguepedia's "YYYY-MM-DD HH:MM:SS" (space-separated, UTC, no
 *  offset) DateTime_UTC value into an ISO string. Returns null on anything
 *  unparseable — caller must skip the row (game_datetime is NOT NULL). */
function parseCargoDatetime(raw: string | undefined): string | null {
  if (!raw) return null;
  const iso = raw.trim().replace(" ", "T") + (raw.includes("Z") ? "" : "Z");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Returns null (caller must skip+log) when the row lacks an identity field
 *  (game_id/player_link/overview_page) or an unresolvable champion — a
 *  prostage row without a champion is useless for the app's core lookup. */
export function extractProstageRow(
  raw: CargoScoreboardPlayerRow,
  maps: DdragonMaps,
  log: (msg: string) => void = () => {}
): ExtractedProstageRow | null {
  const gameId = cargoField(raw, "GameId");
  const playerLink = cargoField(raw, "Link");
  const overviewPage = cargoField(raw, "OverviewPage");
  const championRaw = cargoField(raw, "Champion");
  const datetime = parseCargoDatetime(cargoField(raw, "DateTime_UTC"));

  if (!gameId || !playerLink || !overviewPage) {
    log(`row missing identity field(s) (GameId=${gameId} Link=${playerLink} OverviewPage=${overviewPage}), skipping`);
    return null;
  }
  if (!datetime) {
    log(`game ${gameId} player ${playerLink}: unparseable DateTime_UTC, skipping`);
    return null;
  }
  if (!championRaw) {
    log(`game ${gameId} player ${playerLink}: missing Champion, skipping`);
    return null;
  }

  const championId = resolveIdOrName(championRaw, maps.championByName);
  if (championId === null) {
    log(`game ${gameId} player ${playerLink}: unresolved champion "${championRaw}", skipping`);
    return null;
  }
  const championName = maps.championNameById.get(championId) ?? championRaw;

  const finalItems: number[] = [];
  for (const token of parseList(cargoField<string | string[]>(raw, "Items"))) {
    const id = resolveIdOrName(token, maps.itemByName);
    if (id === null) {
      log(`game ${gameId} player ${playerLink}: unresolved item "${token}", skipping item`);
      continue;
    }
    finalItems.push(id);
  }

  const trinketRaw = cargoField(raw, "Trinket");
  let trinket: number | null = null;
  if (trinketRaw) {
    trinket = resolveIdOrName(trinketRaw, maps.itemByName);
    if (trinket === null) log(`game ${gameId} player ${playerLink}: unresolved trinket "${trinketRaw}"`);
  }

  const spellTokens = parseList(cargoField<string | string[]>(raw, "SummonerSpells"));
  const spells: [number, number] = [0, 0];
  spellTokens.slice(0, 2).forEach((token, i) => {
    const id = resolveIdOrName(token, maps.summonerByName);
    if (id === null) {
      log(`game ${gameId} player ${playerLink}: unresolved summoner spell "${token}"`);
      return;
    }
    spells[i] = id;
  });

  const runes = resolveRunes(
    cargoField<string | string[]>(raw, "Runes"),
    cargoField(raw, "KeystoneRune"),
    cargoField(raw, "PrimaryTree"),
    cargoField(raw, "SecondaryTree"),
    maps,
    (msg) => log(`game ${gameId} player ${playerLink}: ${msg}`)
  );

  return {
    gameId,
    playerLink,
    overviewPage,
    tournamentDisplay: tournamentDisplayFromOverviewPage(overviewPage),
    team: cargoField(raw, "Team") ?? null,
    championId,
    championName,
    role: roleFromCargoRole(cargoField(raw, "Role")),
    win: parseCargoBool(cargoField(raw, "PlayerWin")),
    kills: parseCargoInt(cargoField<string | number>(raw, "Kills")),
    deaths: parseCargoInt(cargoField<string | number>(raw, "Deaths")),
    assists: parseCargoInt(cargoField<string | number>(raw, "Assists")),
    gameDatetime: datetime,
    // ScoreboardPlayers has NO Patch field — confirmed via the live Cargo
    // schema declaration (Module:CargoDeclare/ScoreboardPlayers), fetched as
    // a plain wiki page on 2026-07-09. Requesting it was the root cause of a
    // real MWException on every ScoreboardPlayers call that got past the
    // rate limiter. Always null now — column stays nullable in the DB in
    // case a future Cargo schema change adds patch tracking to this table.
    patch: null,
    spells,
    finalItems,
    trinket,
    runes,
  };
}
