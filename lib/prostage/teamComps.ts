// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/teamComps.ts — shared prostage per-game team-composition
// grouping + role-ordering. Extracted 2026-07-11 (P1 perf fix: allyPlayers/
// enemyPlayers moved off the GET /api/pros list response and onto the
// on-demand GET /api/pros/team-players endpoint) so the two consumers share
// ONE implementation of the grouping/ordering/proId-fallback logic rather
// than risking divergence:
//   - app/api/pros/route.ts's compsForGame projects championId-only strips
//     (allyChampionIds/enemyChampionIds) + teamNamesForGame's team-name pair.
//   - app/api/pros/team-players/route.ts serves the full CompEntry
//     (TeamCompPlayer) sheet for one specific game on open.
// ─────────────────────────────────────────────────────────────────────────────

import { orderByRole } from "@/lib/pro/extract";
import { cleanLeaguepediaName } from "./displayName";
import type { TeamCompPlayer } from "@/lib/pro/types";

export interface ProstageCompRow {
  game_id: string;
  team: string;
  champion_id: number;
  role: number | null; // Cargo Role column, 0-4, nullable
  pro_role: number | null; // pros-table fallback role, same resolution as prostageRowToProGame's roleValue
  player_link: string; // prostage identity field — NOT NULL on the table, always present
  final_items: unknown; // jsonb — this row's own final items (per-player data)
  trinket: number | null;
  pro_name: string | null; // pros-table name when THIS row links to a tracked pro, else null
  pro_id: string | null; // prostage_matches.pro_id — null when ingest's own name-match missed (see buildProstageCompsMap's fallback)
}

/** Carries everything needed to build BOTH the champion-id-only strip
 *  (allyChampionIds/enemyChampionIds) and the full per-player sheet
 *  (allyPlayers/enemyPlayers) from one grouped row — deliberately shaped as
 *  TeamCompPlayer itself (lib/pro/types.ts) rather than a narrower
 *  champion-id-only type, so orderedSidesForGame (below) can reorder the
 *  whole entry in one pass regardless of which consumer needs which
 *  projection of it. */
export type CompEntry = TeamCompPlayer;

/** jsonb columns generally come back pre-parsed from the neon driver, but
 *  accept a JSON string too — defensive against driver-version drift. */
function asJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

/** Groups a batch of raw coachbuild.prostage_matches (game_id, team,
 *  champion_id, role, player_link, final_items, trinket, pro_name, pro_id)
 *  rows into game_id -> team -> TeamCompPlayer[]. Rows with a null team or
 *  champion_id are excluded by the caller's SQL WHERE clause, never here.
 *  Role resolution mirrors app/api/pros/route.ts's prostageRowToProGame
 *  roleValue (pro_role ?? role, unresolved stays null rather than guessed).
 *  name prefers pro_name (this row links to a tracked pro, already clean)
 *  over the CLEANED player_link (strips Leaguepedia's real-name
 *  disambiguator, e.g. "Zeka (Kim Geon-woo)" -> "Zeka" — see
 *  lib/prostage/displayName.ts). items defensively filters 0s even though
 *  Cargo's Items list shouldn't contain placeholder zeros
 *  (lib/prostage/extract.ts only pushes resolved item ids).
 *
 *  proId prefers the row's own pm.pro_id (set at ingest — see
 *  lib/prostage/ingest.ts) with a conservative name-match fallback
 *  (`proByName`, coachbuild.pros name -> id, lowercased, passed in by the
 *  caller) matched first against the RAW player_link, then the CLEANED
 *  form — covers rows ingested before lib/prostage/ingest.ts's own cleaned-
 *  form match existed, or a pro tracked only AFTER this row was first
 *  ingested. Never fuzzy — exact (case-insensitive) match only. */
export function buildProstageCompsMap(
  rows: ProstageCompRow[],
  proByName: Map<string, string>
): Map<string, Map<string, CompEntry[]>> {
  const map = new Map<string, Map<string, CompEntry[]>>();
  for (const r of rows) {
    let byTeam = map.get(r.game_id);
    if (!byTeam) {
      byTeam = new Map();
      map.set(r.game_id, byTeam);
    }
    // player_link is NOT NULL on the real table, but defend against a
    // driver/test-mock row shaped without it (matches this file's existing
    // defensive posture toward every other field here) rather than crashing
    // the whole merge over one malformed row.
    const playerLink = r.player_link ?? "";
    const proId =
      r.pro_id ??
      (playerLink ? proByName.get(playerLink.trim().toLowerCase()) : undefined) ??
      (playerLink ? proByName.get(cleanLeaguepediaName(playerLink).toLowerCase()) : undefined) ??
      null;
    const arr = byTeam.get(r.team) ?? [];
    arr.push({
      championId: r.champion_id,
      role: r.pro_role ?? r.role ?? null,
      name: r.pro_name ?? (playerLink ? cleanLeaguepediaName(playerLink) : null),
      items: asJson<number[]>(r.final_items, []).filter((id) => id !== 0),
      trinket: r.trinket ?? null,
      proId,
    });
    byTeam.set(r.team, arr);
  }
  return map;
}

/** ALLY = ownTeam's row set; ENEMY = the one other team present for that
 *  game_id. Returns null (never a partial side) unless: ownTeam is
 *  non-null, that team has exactly 5 champions, and there is EXACTLY ONE
 *  other team for the game with exactly 5 champions — i.e. a clean 10-row
 *  5v5 split. Both sides are role-ordered via orderByRole (lib/pro/extract.ts,
 *  shared with the soloq pipeline's extractTeamPlayers) — degrades to source
 *  order when the 5 rows don't carry exactly 5 distinct known roles.
 *
 *  Shared by app/api/pros/route.ts's compsForGame (projects championId only,
 *  for the list response's allyChampionIds/enemyChampionIds) and
 *  app/api/pros/team-players/route.ts (uses the full CompEntry, for the
 *  on-demand allyPlayers/enemyPlayers) — so the two consumers can never
 *  disagree on which 10 rows qualify or how they're ordered. */
export function orderedSidesForGame(
  compsByGame: Map<string, Map<string, CompEntry[]>>,
  gameId: string,
  ownTeam: string | null
): { ally: CompEntry[]; enemy: CompEntry[] } | null {
  if (!ownTeam) return null;
  const byTeam = compsByGame.get(gameId);
  if (!byTeam) return null;
  const ally = byTeam.get(ownTeam);
  if (!ally || ally.length !== 5) return null;
  const otherTeams = Array.from(byTeam.entries()).filter(([team]) => team !== ownTeam);
  if (otherTeams.length !== 1) return null;
  const [, enemy] = otherTeams[0];
  if (enemy.length !== 5) return null;
  return { ally: orderByRole(ally), enemy: orderByRole(enemy) };
}
