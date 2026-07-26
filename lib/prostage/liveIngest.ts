// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/liveIngest.ts — pro-play ingest from the LIVE lolesports feed,
// as a fast-path alongside the Leaguepedia (Cargo) ingest in ./ingest.ts.
//
// WHY THIS EXISTS (2026-07-25). Leaguepedia's ScoreboardPlayers is
// editor-populated and lags days-to-weeks: `LPL/2026 Season/Split 3` started
// 07-22 and still had ZERO rows on 07-25. A user reported TheShy's games as
// missing and could see them in another app; the games were real (IG vs WBG,
// LPL, 07-25, TheShy on Ambessa) — Leaguepedia simply had not been written yet.
// Ingesting only from Leaguepedia can therefore never satisfy "always up to
// date", no matter how often it runs.
//
// This module reads the same source the user could see: the lolesports schedule
// + livestats feeds. It is DELIBERATELY SHALLOW — champion, role, KDA, result,
// team, date. No items/runes/spells: those need the per-10s `details` feed walk
// (lib/prostage/timeline.ts) and Leaguepedia fills them in later anyway.
//
// RECONCILIATION with the Leaguepedia ingest. Rows written here use a
// `lolesports:<gameId>` game_id and always set `lolesports_game_id`. The read
// path (app/api/pros) hides a live row once the richer Leaguepedia row for that
// game exists, so the two sources never double-render.
//
// That supersede rule is keyed on (normalised player, champion, +/-12h) — NOT on
// `lolesports_game_id`, which was the v0.54.0 bug: the Leaguepedia ingest never
// writes that column, so the match could never fire and every live row rendered
// beside its twin. See the comment in app/api/pros/route.ts.
//
// Which makes `game_datetime` load-bearing, not cosmetic: it must be the real
// PER-GAME start (`opened.gameStartTs`), never the match/series start
// (`ev.startTime`) — a Bo5's five games all stamped with the series start put
// game 5 up to ~4h from its Leaguepedia twin, outside the window.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { fetchWithTimeout, FAST_FETCH_TIMEOUT_MS } from "@/lib/fetchTimeout";
import { getDdragonMaps } from "./ddragon";
import { getEventDetails, getLeagues, getScheduleForLeague } from "./lolesports";
import { fetchLatestFrameTs, fetchOpeningWindow, iso10s } from "./timeline";
import type { ParticipantMeta } from "./timeline";

/** League SLUGS to ingest, kept deliberately in step with the Cargo path's
 *  tier-1 + targeted-tier-2 set (lib/prostage/tournaments.ts). "cd" is Circuito
 *  Desafiante — a targeted add for a tracked pro, see that file's note. */
const TRACKED_LEAGUE_SLUGS = new Set([
  "lec",
  "lck",
  "lpl",
  "lcs",
  "msi",
  "worlds",
  "first_stand",
  "ewc_lol",
  "cd",
]);

const FEED_BASE = "https://feed.lolesports.com/livestats/v1";

export interface LiveIngestOptions {
  /** How far back to consider completed matches. */
  lookbackDays?: number;
  /** Safety cap on games processed per run (each game costs ~3 feed calls). */
  maxGames?: number;
  onProgress?: (msg: string) => void;
}

export interface LiveIngestResult {
  leagues: number;
  gamesSeen: number;
  gamesIngested: number;
  rowsUpserted: number;
  errors: string[];
}

interface FinalFrameTeam {
  inhibitors?: number;
  towers?: number;
  totalGold?: number;
  participants?: Array<{
    participantId: number;
    kills?: number;
    deaths?: number;
    assists?: number;
    creepScore?: number;
    totalGold?: number;
  }>;
}

/** Winner = majority of (inhibitors, towers, gold) on the FINAL frame.
 *
 *  The livestats window feed carries no explicit winner flag, so this mirrors
 *  the rule matchday settled on for the identical problem. Returns null when
 *  the vote cannot be taken (missing frame) rather than guessing — a wrong
 *  win/loss is worse than an absent game. */
export function decideWinnerSide(
  blue: FinalFrameTeam | undefined,
  red: FinalFrameTeam | undefined,
): "blue" | "red" | null {
  if (!blue || !red) return null;
  const votes: Array<number> = [];
  const cmp = (b: number | undefined, r: number | undefined) => {
    if (b == null || r == null || b === r) return 0;
    return b > r ? 1 : -1;
  };
  votes.push(cmp(blue.inhibitors, red.inhibitors));
  votes.push(cmp(blue.towers, red.towers));
  votes.push(cmp(blue.totalGold, red.totalGold));
  const score = votes.reduce((a, b) => a + b, 0);
  if (score === 0) return null;
  return score > 0 ? "blue" : "red";
}

/** "IGTheShy" + team code "IG" -> "TheShy". Falls back to the raw name when the
 *  prefix isn't present (not every league's summoner names are code-prefixed). */
export function stripTeamPrefix(summonerName: string, teamCode: string | undefined): string {
  const name = summonerName.trim();
  if (!teamCode) return name;
  const code = teamCode.trim();
  if (code && name.toLowerCase().startsWith(code.toLowerCase()) && name.length > code.length) {
    return name.slice(code.length).trim();
  }
  return name;
}

const ROLE_ORDER: Record<string, number> = { top: 0, jungle: 1, mid: 2, bottom: 3, support: 4 };

/** `runes` is an OBJECT (ProGameRunes), not an array. Writing `[]` here shipped a
 *  crash: GameDetailSheet reads `game.runes.primary.length`, which is undefined
 *  on an array, and the whole /history page white-screened with "a client-side
 *  exception has occurred" the moment a live-ingested game's sheet opened.
 *  The empty shape must still carry every key the renderer reads. */
const EMPTY_RUNES = JSON.stringify({
  primaryTree: 0,
  keystone: 0,
  primary: [],
  secondaryTree: 0,
  secondary: [],
  shards: [],
});

async function fetchWindowAt(gameId: string, ts: string) {
  // startingTime MUST be 10s-aligned. fetchLatestFrameTs returns a real frame
  // timestamp (millisecond precision), and passing that through verbatim
  // returns an EMPTY body — which read as "winner undecidable" for every game
  // on the first run. iso10s is the canonical aligner (see timeline.ts).
  const aligned = iso10s(new Date(ts).getTime());
  const res = await fetchWithTimeout(
    `${FEED_BASE}/window/${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(aligned)}`,
    {},
    FAST_FETCH_TIMEOUT_MS
  );
  if (!res.ok) return null;
  return (await res.json()) as {
    frames?: Array<{ blueTeam?: FinalFrameTeam; redTeam?: FinalFrameTeam }>;
  };
}

export async function runLiveProstageIngest(opts: LiveIngestOptions = {}): Promise<LiveIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const log = opts.onProgress ?? (() => {});
  const lookbackDays = opts.lookbackDays ?? 4;
  const maxGames = opts.maxGames ?? 40;
  const cutoff = Date.now() - lookbackDays * 86_400_000;

  const result: LiveIngestResult = {
    leagues: 0,
    gamesSeen: 0,
    gamesIngested: 0,
    rowsUpserted: 0,
    errors: [],
  };

  const maps = await getDdragonMaps();

  // pro name -> id, for linking rows to the `pros` table the app reads.
  const proRows = (await sql`SELECT id, name FROM coachbuild.pros`) as unknown as Array<{
    id: string;
    name: string;
  }>;
  const proByName = new Map(proRows.map((p) => [p.name.trim().toLowerCase(), p.id]));

  const leagues = (await getLeagues()).filter((l) => TRACKED_LEAGUE_SLUGS.has(l.slug ?? ""));
  result.leagues = leagues.length;

  for (const league of leagues) {
    if (result.gamesIngested >= maxGames) break;
    let events;
    try {
      ({ events } = await getScheduleForLeague(league.id));
    } catch (err) {
      result.errors.push(`league ${league.slug}: schedule failed: ${(err as Error).message}`);
      continue;
    }

    const recent = events.filter(
      (e) =>
        e.type === "match" &&
        e.state === "completed" &&
        e.startTime != null &&
        Date.parse(e.startTime) >= cutoff,
    );

    for (const ev of recent) {
      if (result.gamesIngested >= maxGames) break;
      const matchId = ev.match?.id;
      if (!matchId) continue;

      let details;
      try {
        details = await getEventDetails(matchId);
      } catch (err) {
        result.errors.push(`match ${matchId}: details failed: ${(err as Error).message}`);
        continue;
      }

      for (const game of details.games ?? []) {
        if (result.gamesIngested >= maxGames) break;
        if (game.state !== "completed" || !game.id) continue;
        result.gamesSeen += 1;

        // Skip only when this game is ALREADY COMPLETE here — all 10 rows.
        //
        // This used to be `SELECT 1 ... LIMIT 1`, i.e. "any row at all". Two
        // paths leave a game short: an unresolved champion `continue`s (exactly
        // what MonkeyKing did), or a mid-loop throw commits the earlier
        // participants and abandons the rest. Under the old check that game was
        // then skipped forever and the run reported clean, so it could never be
        // completed — and a 9-row game also fails orderedSidesForGame's 5/5 gate,
        // silently costing the other nine players their comp strip and Teams box.
        //
        // Re-walking a permanently-short game costs ~3 feed calls per run. That
        // is the deliberate trade: cheap and self-healing beats silently partial.
        const heldRows = (await sql`
          SELECT count(*)::int AS n FROM coachbuild.prostage_matches
          WHERE lolesports_game_id = ${game.id}
        `) as unknown as Array<{ n: number }>;
        if ((heldRows[0]?.n ?? 0) >= 10) continue;

        try {
          const opened = await fetchOpeningWindow(game.id);
          if (!opened.ok) {
            result.errors.push(`game ${game.id}: opening window unavailable`);
            continue;
          }
          const finalTs = await fetchLatestFrameTs(game.id, opened.gameStartTs);
          const finalWindow = finalTs ? await fetchWindowAt(game.id, finalTs) : null;
          const lastFrame = finalWindow?.frames?.at(-1);
          const winnerSide = decideWinnerSide(lastFrame?.blueTeam, lastFrame?.redTeam);
          if (!winnerSide) {
            // No trustworthy result — skip rather than record a coin-flip.
            result.errors.push(`game ${game.id}: winner undecidable, skipped`);
            continue;
          }

          const statsById = new Map<number, { kills?: number; deaths?: number; assists?: number }>();
          for (const side of [lastFrame?.blueTeam, lastFrame?.redTeam]) {
            for (const p of side?.participants ?? []) statsById.set(p.participantId, p);
          }

          const sides: Array<{ side: "blue" | "red"; parts: ParticipantMeta[] }> = [
            { side: "blue", parts: opened.metadata.blueTeamMetadata?.participantMetadata ?? [] },
            { side: "red", parts: opened.metadata.redTeamMetadata?.participantMetadata ?? [] },
          ];

          // Team is derived from the SUMMONER-NAME PREFIX, not from
          // game.teams[].side -> team id. The feed's per-game side labels do NOT
          // line up with the livestats blue/red participant arrays: the first
          // run wrote every IG player as team "WBG" and vice versa, which also
          // stopped the prefix stripping ("IGTheShy" never matched "WBG"), so
          // nothing was searchable by player name. Matching the prefix against
          // the match's own two codes is self-consistent and immune to that.
          //
          // `win` is unaffected by this and was correct: it comes from which
          // livestats array (blue/red) a participant appears in, compared with
          // the final-frame winner — never from this mapping.
          const matchCodes = (details.teams ?? [])
            .map((t) => t.code)
            .filter((c): c is string => !!c);

          let wroteForGame = 0;
          for (const { side, parts } of sides) {
            for (const part of parts) {
              const rawName = (part.summonerName ?? "").trim();
              const teamCode = matchCodes.find(
                (c) => rawName.toLowerCase().startsWith(c.toLowerCase()) && rawName.length > c.length,
              );
              const championRaw = part.championId;
              if (!championRaw) continue;
              const championId = maps.championByName.get(
                championRaw.toLowerCase().replace(/[^a-z0-9]/g, ""),
              );
              if (championId == null) {
                result.errors.push(`game ${game.id}: unresolved champion "${championRaw}"`);
                continue;
              }
              const playerLink = stripTeamPrefix(part.summonerName ?? "", teamCode);
              if (!playerLink) continue;

              const stats = statsById.get(part.participantId) ?? {};
              const win = side === winnerSide;
              const proId = proByName.get(playerLink.toLowerCase()) ?? null;

              await sql`
                INSERT INTO coachbuild.prostage_matches (
                  game_id, player_link, overview_page, tournament_display, team,
                  champion_id, champion_name, role, win, kills, deaths, assists,
                  game_datetime, spells, final_items, runes, pro_id,
                  lolesports_game_id, ingested_at
                ) VALUES (
                  ${`lolesports:${game.id}`}, ${playerLink},
                  ${`lolesports:${league.slug}`}, ${league.name ?? league.slug},
                  ${teamCode ?? null},
                  ${championId}, ${maps.championNameById.get(championId) ?? championRaw},
                  ${ROLE_ORDER[part.role ?? ""] ?? null},
                  ${win}, ${stats.kills ?? 0}, ${stats.deaths ?? 0}, ${stats.assists ?? 0},
                  ${opened.gameStartTs}, ${"[]"}::jsonb, ${"[]"}::jsonb, ${EMPTY_RUNES}::jsonb,
                  ${proId}, ${game.id}, now()
                )
                ON CONFLICT (game_id, player_link) DO UPDATE SET
                  win = EXCLUDED.win, kills = EXCLUDED.kills, deaths = EXCLUDED.deaths,
                  assists = EXCLUDED.assists, pro_id = EXCLUDED.pro_id,
                  game_datetime = EXCLUDED.game_datetime, ingested_at = now()
              `;
              wroteForGame += 1;
            }
          }

          if (wroteForGame > 0) {
            result.gamesIngested += 1;
            result.rowsUpserted += wroteForGame;
            log(`${league.slug} game ${game.id}: ${wroteForGame} rows`);
          }
        } catch (err) {
          result.errors.push(`game ${game.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Never truncate silently. Hitting the cap means games were left un-ingested,
  // which would otherwise look identical to "nothing new to fetch" — the exact
  // ambiguity that let the Leaguepedia cron rot unnoticed for weeks.
  if (result.gamesIngested >= maxGames) {
    const msg = `hit maxGames cap (${maxGames}) — more completed games remain un-ingested; re-run or raise the cap`;
    result.errors.push(msg);
    log(msg);
  }

  return result;
}
