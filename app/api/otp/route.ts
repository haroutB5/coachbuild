import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import { FRESH_WINDOW_DAYS } from "@/lib/pro/fresh";
import type { ProGame, ProGameRunes, ProRoleId } from "@/lib/pro/types";
import type { OtpPlayerSummary, OtpResponse } from "@/lib/otp/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 300;
const DEFAULT_LIMIT = 200;

interface OtpGameRow {
  match_id: string;
  puuid: string;
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
  runes: unknown;
  game_name: string;
  tag_line: string;
  region: string;
  tier: string | null;
  champ_play: number;
}

/** jsonb columns generally come back pre-parsed from the neon driver, but
 *  accept a JSON string too — defensive against driver-version drift, same
 *  posture as app/api/pros/route.ts. */
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

function asRows<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** A one-trick's ladder identity is public (op.gg publishes the leaderboard),
 *  but the tagline is noise on a build card and a needless extra identifier
 *  to render — so the display name is the game name alone. */
function rowToProGame(row: OtpGameRow): ProGame {
  return {
    id: row.match_id,
    // These ARE solo-queue Riot matches; the discriminant describes the GAME,
    // not which roster we sourced the player from. Anything else would make
    // every existing ProGame consumer wrong about what it's holding.
    source: "soloq",
    player: {
      name: row.game_name,
      team: null,
      role: row.role as ProRoleId,
      country: null,
    },
    account: { riotId: `${row.game_name}#${row.tag_line}`, region: row.region },
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
    // Always [] — the ingest skips the match-v5 timeline call on purpose.
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
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const champParam = searchParams.get("championId");
  const roleParam = searchParams.get("role");
  const limitParam = searchParams.get("limit");

  if (!champParam || !/^\d+$/.test(champParam)) {
    return NextResponse.json({ error: "Invalid or missing championId" }, { status: 400 });
  }
  const championId = parseInt(champParam, 10);

  // 0-4 = concrete lane filter; 5 = "auto" (the Builds page's default role
  // state) = no lane filter. Same convention as GET /api/pros — rejecting 5
  // would error the card on the most common interaction path.
  let role = 5;
  if (roleParam !== null) {
    if (!/^\d+$/.test(roleParam)) {
      return NextResponse.json({ error: "Invalid role param" }, { status: 400 });
    }
    role = parseInt(roleParam, 10);
    if (role < 0 || role > 5) {
      return NextResponse.json({ error: "Invalid role (must be 0-5)" }, { status: 400 });
    }
  }

  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    if (!/^\d+$/.test(limitParam) || parseInt(limitParam, 10) <= 0) {
      return NextResponse.json({ error: "Invalid limit param" }, { status: 400 });
    }
    limit = Math.min(parseInt(limitParam, 10), MAX_LIMIT);
  }

  const sql = getSql();
  if (!sql) {
    const body: OtpResponse = { games: [], players: [], pending: false };
    return NextResponse.json(body);
  }

  try {
    // Two queries, not one: the roster must be readable even when zero games
    // have been ingested yet, which is exactly the `pending` state the card
    // needs to distinguish "still loading this champion's one-tricks" from
    // "we track nobody for this champion." A single JOIN would collapse both
    // into an empty result and the UI could not tell them apart.
    const [gameRows, rosterRows] = await Promise.all([
      sql`
        SELECT
          m.match_id, m.puuid, m.champion_id, m.champion_name, m.role, m.patch, m.win,
          m.kills, m.deaths, m.assists, m.game_creation, m.game_duration_sec,
          m.spells, m.final_items, m.trinket, m.runes,
          a.game_name, a.tag_line, a.region, a.tier, a.champ_play
        FROM coachbuild.otp_matches m
        JOIN coachbuild.otp_accounts a
          ON a.champion_id = m.champion_id AND a.puuid = m.puuid
        WHERE m.champion_id = ${championId}
          AND (${role} = 5 OR m.role = ${role})
          AND m.game_creation > now() - make_interval(days => ${FRESH_WINDOW_DAYS})
        ORDER BY m.game_creation DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT game_name, region, tier, champ_play
        FROM coachbuild.otp_accounts
        WHERE champion_id = ${championId} AND active = true
        ORDER BY champ_play DESC
      `,
    ]);

    const rows = asRows<OtpGameRow>(gameRows);
    const games = rows.map(rowToProGame);

    // Per-player sample counts come from the RETURNED rows, never from the
    // roster table — a tracked account with zero games in the window must
    // show 0, not its lifetime op.gg count dressed up as our sample.
    const inSample = new Map<string, number>();
    for (const row of rows) {
      inSample.set(row.game_name, (inSample.get(row.game_name) ?? 0) + 1);
    }

    const roster = asRows<{
      game_name: string;
      region: string;
      tier: string | null;
      champ_play: number;
    }>(rosterRows);

    const players: OtpPlayerSummary[] = roster.map((r) => ({
      name: r.game_name,
      region: r.region,
      championPlays: r.champ_play,
      tier: r.tier,
      gamesInSample: inSample.get(r.game_name) ?? 0,
    }));

    const body: OtpResponse = {
      games,
      players,
      pending: games.length === 0 && players.length > 0,
    };

    // Repo gotcha (b): never CDN-cache an empty/degraded response. An empty
    // OTP result is either a champion we haven't ingested yet (cheap to
    // recompute, and pinning it for 30 min hides the data arriving) or a
    // degraded read coerced to []. Only a real sample earns a long s-maxage.
    return NextResponse.json(body, {
      headers: {
        "Cache-Control":
          games.length > 0 ? "s-maxage=1800, stale-while-revalidate=3600" : "no-store",
      },
    });
  } catch (err) {
    console.error("[/api/otp] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
