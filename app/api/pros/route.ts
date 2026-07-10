import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { FRESH_WINDOW_DAYS } from "@/lib/pro/fresh";
import type { DisplayRoleId, ProGame, ProGamePurchase, ProGameRunes, ProRoleId, ProsResponse } from "@/lib/pro/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProGameRow {
  match_id: string;
  champion_id: number;
  champion_name: string;
  role: number;
  patch: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  game_creation: string | Date;
  game_duration_sec: number;
  spells: unknown;
  final_items: unknown;
  trinket: number | null;
  purchase_order: unknown;
  skill_order: unknown;
  runes: unknown;
  ally_champion_ids: unknown;
  enemy_champion_ids: unknown;
  pro_name: string;
  pro_team: string | null;
  pro_role: number | null;
  pro_country: string | null;
  riot_id: string;
  region: string;
}

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

/** Both ally_champion_ids/enemy_champion_ids are jsonb NULL until
 *  scripts/backfill-team-comps.mjs walks a historical row, or absent for a
 *  match that never resolved a clean 5v5 split (see extractTeamComps) — in
 *  either case emit NEITHER field (spreading {} adds no keys) rather than a
 *  partial side. */
function soloqComps(row: ProGameRow): Pick<ProGame, "allyChampionIds" | "enemyChampionIds"> | Record<string, never> {
  const ally = asJson<number[] | null>(row.ally_champion_ids, null);
  const enemy = asJson<number[] | null>(row.enemy_champion_ids, null);
  if (ally && enemy && ally.length === 5 && enemy.length === 5) {
    return { allyChampionIds: ally, enemyChampionIds: enemy };
  }
  return {};
}

function rowToProGame(row: ProGameRow): ProGame {
  return {
    id: row.match_id,
    source: "soloq",
    player: {
      name: row.pro_name,
      team: row.pro_team,
      role: (row.pro_role ?? row.role) as ProRoleId,
      country: row.pro_country,
    },
    account: { riotId: row.riot_id, region: row.region },
    championId: row.champion_id,
    championName: row.champion_name,
    role: row.role as ProRoleId,
    patch: row.patch,
    win: row.win,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    gameCreation: new Date(row.game_creation).toISOString(),
    gameDurationSec: row.game_duration_sec,
    spells: asJson<[number, number]>(row.spells, [0, 0]),
    finalItems: asJson<number[]>(row.final_items, []),
    trinket: row.trinket ?? null,
    purchaseOrder: asJson<ProGamePurchase[]>(row.purchase_order, []),
    skillOrder: asJson<string[]>(row.skill_order, []),
    runes: asJson<ProGameRunes>(row.runes, {
      primaryTree: 0,
      keystone: 0,
      primary: [],
      secondaryTree: 0,
      secondary: [],
      shards: [],
    }),
    ...soloqComps(row),
  };
}

interface ProstageGameRow {
  game_id: string;
  player_link: string;
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
  tournament_display: string;
  pro_name: string | null;
  pro_team: string | null;
  pro_role: number | null;
  pro_country: string | null;
}

/** Returns null for structurally-incomplete rows (missing identity fields or
 *  an unparseable datetime) rather than throwing — a row this shape-
 *  mismatched should never reach a real query result, but a defensive skip
 *  here is cheap insurance against driver-version drift / test-mock
 *  misconfiguration, matching this file's existing asJson() posture toward
 *  jsonb columns.
 *
 *  Role is NOT a drop reason (fixed post-audit — a prior version returned
 *  null here whenever role was unresolved, which silently blackholed EVERY
 *  such row from EVERY query, including role=5/no-filter, behind a clean
 *  ingest log showing nothing wrong): an unresolved role maps to the -1
 *  sentinel (see ProRoleId in lib/pro/types.ts) rather than being dropped.
 *  A CONCRETE lane filter (role=0-4) still excludes these rows correctly at
 *  the SQL level (`pm.role = ${role}` is false/unknown against a NULL
 *  column) — only the all-lanes path (role=5) surfaces them, which is
 *  correct: an unknown lane can't satisfy "was this game played top," but it
 *  can satisfy "show me all this champion's games." */
function prostageRowToProGame(
  row: ProstageGameRow,
  comps: Pick<ProGame, "allyChampionIds" | "enemyChampionIds"> | Record<string, never> = {}
): ProGame | null {
  if (!row?.game_id || !row.player_link || typeof row.champion_id !== "number") return null;
  const gameCreation = new Date(row.game_datetime);
  if (Number.isNaN(gameCreation.getTime())) return null;
  const roleValue = ((row.pro_role ?? row.role) ?? -1) as DisplayRoleId;
  // prostage rows have no gameDurationSec — always 0, see field comment below.

  return {
    id: row.game_id,
    source: "prostage",
    playerLink: row.player_link,
    player: {
      name: row.pro_name ?? row.player_link,
      team: row.pro_team ?? row.team,
      role: roleValue,
      country: row.pro_country ?? null,
    },
    account: { riotId: "", region: row.tournament_display },
    championId: row.champion_id,
    championName: row.champion_name,
    role: roleValue,
    patch: row.patch ?? "",
    win: row.win,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    gameCreation: gameCreation.toISOString(),
    gameDurationSec: 0,
    spells: asJson<[number, number]>(row.spells, [0, 0]),
    finalItems: asJson<number[]>(row.final_items, []),
    trinket: row.trinket ?? null,
    purchaseOrder: [],
    skillOrder: [],
    runes: asJson<ProGameRunes>(row.runes, {
      primaryTree: 0,
      keystone: 0,
      primary: [],
      secondaryTree: 0,
      secondary: [],
      shards: [],
    }),
    tournament: row.tournament_display,
    ...comps,
  };
}

/** Groups a batch of raw coachbuild.prostage_matches (game_id, team,
 *  champion_id) rows — fetched for the specific game_ids already present in
 *  this response's prostage results — into game_id -> team -> championIds[].
 *  Rows with a null team or champion_id are excluded by the caller's SQL
 *  WHERE clause, never here. */
function buildProstageCompsMap(
  rows: { game_id: string; team: string; champion_id: number }[]
): Map<string, Map<string, number[]>> {
  const map = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    let byTeam = map.get(r.game_id);
    if (!byTeam) {
      byTeam = new Map();
      map.set(r.game_id, byTeam);
    }
    const arr = byTeam.get(r.team) ?? [];
    arr.push(r.champion_id);
    byTeam.set(r.team, arr);
  }
  return map;
}

/** ALLY = the game row's own team string; ENEMY = the one other team present
 *  for that game_id. Returns {} (never a partial side) unless: the row has a
 *  non-null team, that team has exactly 5 champions, and there is EXACTLY
 *  ONE other team for the game with exactly 5 champions — i.e. a clean 10-row
 *  5v5 split. Some prostage rows have a null team (see prostageRowToProGame's
 *  header comment) and simply never get comps. */
function compsForGame(
  compsByGame: Map<string, Map<string, number[]>>,
  gameId: string,
  ownTeam: string | null
): Pick<ProGame, "allyChampionIds" | "enemyChampionIds"> | Record<string, never> {
  if (!ownTeam) return {};
  const byTeam = compsByGame.get(gameId);
  if (!byTeam) return {};
  const ally = byTeam.get(ownTeam);
  if (!ally || ally.length !== 5) return {};
  const otherTeams = Array.from(byTeam.entries()).filter(([team]) => team !== ownTeam);
  if (otherTeams.length !== 1) return {};
  const [, enemy] = otherTeams[0];
  if (enemy.length !== 5) return {};
  return { allyChampionIds: ally, enemyChampionIds: enemy };
}

const VALID_SOURCES = new Set(["all", "soloq", "prostage"]);

/** Coerces a query result to an array — defensive against a mock/driver
 *  returning undefined for a call it wasn't explicitly configured for (or
 *  any unexpected non-array shape), rather than crashing the whole merge. */
function asRows<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const champParam = searchParams.get("championId");
  const proIdParam = searchParams.get("proId");
  const roleParam = searchParams.get("role");
  const limitParam = searchParams.get("limit");

  // Exactly one of championId / proId — never both, never neither.
  if ((champParam && proIdParam) || (!champParam && !proIdParam)) {
    return NextResponse.json(
      { error: "Provide exactly one of championId or proId" },
      { status: 400 }
    );
  }

  let championId: number | null = null;
  let proId: string | null = null;

  if (proIdParam) {
    if (!UUID_RE.test(proIdParam)) {
      return NextResponse.json({ error: "Invalid proId param" }, { status: 400 });
    }
    proId = proIdParam;
    // role is OPTIONAL on the proId path — absent means all lanes (see
    // role-parsing block below, which defaults to the 5="auto" sentinel).
  } else {
    if (!/^\d+$/.test(champParam!)) {
      return NextResponse.json({ error: "Invalid championId or role param" }, { status: 400 });
    }
    if (!roleParam) {
      return NextResponse.json({ error: "Missing required query params: championId, role" }, { status: 400 });
    }
    championId = parseInt(champParam!, 10);
  }

  // 0-4 = concrete lane filter; 5 = "auto" (the app's default role state after
  // every champion pick, and the default for a proId lookup with no role
  // param) = no lane filter. The page passes its role state through
  // verbatim, so rejecting 5 here would error the section on the most
  // common interaction path.
  let role = 5;
  if (roleParam !== null) {
    if (!/^\d+$/.test(roleParam)) {
      return NextResponse.json({ error: "Invalid championId or role param" }, { status: 400 });
    }
    role = parseInt(roleParam, 10);
    if (role < 0 || role > 5) {
      return NextResponse.json({ error: "Invalid role (must be 0-5)" }, { status: 400 });
    }
  }

  let limit = 20;
  if (limitParam) {
    if (!/^\d+$/.test(limitParam) || parseInt(limitParam, 10) <= 0) {
      return NextResponse.json({ error: "Invalid limit param" }, { status: 400 });
    }
    limit = Math.min(parseInt(limitParam, 10), 100);
  }

  const sourceParam = searchParams.get("source");
  if (sourceParam && !VALID_SOURCES.has(sourceParam)) {
    return NextResponse.json({ error: "Invalid source param" }, { status: 400 });
  }
  const source = sourceParam ?? "all";
  const wantSoloq = source === "all" || source === "soloq";
  const wantProstage = source === "all" || source === "prostage";

  const sql = getSql();
  if (!sql) {
    // No DB configured — the app must still build and run locally.
    const body: ProsResponse = { games: [] };
    return NextResponse.json(body);
  }

  try {
    // Each side is capped at `limit` — the top `limit` of the MERGED set can
    // never need more than `limit` rows from either individual source, so
    // fetching `limit` from each and merge-sorting is sufficient (never
    // fetch-then-discard more than needed, never under-fetch and miss a
    // newer row from the source with fewer total games).
    const [soloqRows, prostageRows] = await Promise.all([
      wantSoloq
        ? proId
          ? sql`
              SELECT
                pm.match_id, pm.champion_id, pm.champion_name, pm.role, pm.patch, pm.win,
                pm.kills, pm.deaths, pm.assists, pm.game_creation, pm.game_duration_sec,
                pm.spells, pm.final_items, pm.trinket, pm.purchase_order, pm.skill_order, pm.runes,
                pm.ally_champion_ids, pm.enemy_champion_ids,
                p.name AS pro_name, p.team AS pro_team, p.role AS pro_role, p.country AS pro_country,
                pa.riot_id, pa.region
              FROM coachbuild.pro_matches pm
              JOIN coachbuild.pros p ON p.id = pm.pro_id
              JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
              WHERE pm.pro_id = ${proId} AND (${role} = 5 OR pm.role = ${role})
                AND pm.game_creation > now() - make_interval(days => ${FRESH_WINDOW_DAYS})
              ORDER BY pm.game_creation DESC
              LIMIT ${limit}
            `
          : sql`
              SELECT
                pm.match_id, pm.champion_id, pm.champion_name, pm.role, pm.patch, pm.win,
                pm.kills, pm.deaths, pm.assists, pm.game_creation, pm.game_duration_sec,
                pm.spells, pm.final_items, pm.trinket, pm.purchase_order, pm.skill_order, pm.runes,
                pm.ally_champion_ids, pm.enemy_champion_ids,
                p.name AS pro_name, p.team AS pro_team, p.role AS pro_role, p.country AS pro_country,
                pa.riot_id, pa.region
              FROM coachbuild.pro_matches pm
              JOIN coachbuild.pros p ON p.id = pm.pro_id
              JOIN coachbuild.pro_accounts pa ON pa.puuid = pm.puuid
              WHERE pm.champion_id = ${championId} AND (${role} = 5 OR pm.role = ${role})
                AND pm.game_creation > now() - make_interval(days => ${FRESH_WINDOW_DAYS})
              ORDER BY pm.game_creation DESC
              LIMIT ${limit}
            `
        : Promise.resolve([]),
      wantProstage
        ? proId
          ? sql`
              SELECT
                pm.game_id, pm.player_link, pm.team, pm.champion_id, pm.champion_name, pm.role,
                pm.win, pm.kills, pm.deaths, pm.assists, pm.game_datetime, pm.patch,
                pm.spells, pm.final_items, pm.trinket, pm.runes, pm.tournament_display,
                p.name AS pro_name, p.team AS pro_team, p.role AS pro_role, p.country AS pro_country
              FROM coachbuild.prostage_matches pm
              JOIN coachbuild.pros p ON p.id = pm.pro_id
              WHERE pm.pro_id = ${proId} AND (${role} = 5 OR pm.role = ${role})
                AND pm.game_datetime > now() - make_interval(days => ${FRESH_WINDOW_DAYS})
              ORDER BY pm.game_datetime DESC
              LIMIT ${limit}
            `
          : sql`
              SELECT
                pm.game_id, pm.player_link, pm.team, pm.champion_id, pm.champion_name, pm.role,
                pm.win, pm.kills, pm.deaths, pm.assists, pm.game_datetime, pm.patch,
                pm.spells, pm.final_items, pm.trinket, pm.runes, pm.tournament_display,
                p.name AS pro_name, p.team AS pro_team, p.role AS pro_role, p.country AS pro_country
              FROM coachbuild.prostage_matches pm
              LEFT JOIN coachbuild.pros p ON p.id = pm.pro_id
              WHERE pm.champion_id = ${championId} AND (${role} = 5 OR pm.role = ${role})
                AND pm.game_datetime > now() - make_interval(days => ${FRESH_WINDOW_DAYS})
              ORDER BY pm.game_datetime DESC
              LIMIT ${limit}
            `
        : Promise.resolve([]),
    ]);

    const soloqGames = asRows<ProGameRow>(soloqRows).map(rowToProGame);

    const prostageRowsArr = asRows<ProstageGameRow>(prostageRows);
    // Team comps for prostage rows: one extra grouped query (batched over
    // every distinct game_id already in this response's prostage results) —
    // NOT a per-row N+1 query. Only fired when there's actually a prostage
    // row to enrich.
    const gameIds = Array.from(new Set(prostageRowsArr.map((r) => r.game_id)));
    const compsRawRows =
      gameIds.length > 0
        ? await sql`
            SELECT game_id, team, champion_id
            FROM coachbuild.prostage_matches
            WHERE game_id = ANY(${gameIds}::text[])
              AND team IS NOT NULL AND champion_id IS NOT NULL
          `
        : [];
    const compsByGame = buildProstageCompsMap(
      asRows<{ game_id: string; team: string; champion_id: number }>(compsRawRows)
    );

    const prostageGames = prostageRowsArr
      .map((row) => prostageRowToProGame(row, compsForGame(compsByGame, row.game_id, row.team)))
      .filter((g): g is ProGame => g !== null);

    const games = [...soloqGames, ...prostageGames]
      .sort((a, b) => new Date(b.gameCreation).getTime() - new Date(a.gameCreation).getTime())
      .slice(0, limit);

    const body: ProsResponse = { games };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "s-maxage=1800, stale-while-revalidate=3600" },
    });
  } catch (err) {
    console.error("[/api/pros] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
