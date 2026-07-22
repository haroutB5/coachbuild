// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/resolveGame.ts — resolves a coachbuild prostage game (a
// Leaguepedia-sourced (game_id, ...) row set) to the numeric lolesports esports
// game id, walks its livestats item build order (lib/prostage/timeline.ts), and
// maps the 10 per-participant sequences back to our player_links. One walk
// yields ALL 10 players' timelines, so the caller persists them together.
//
// Resolution chain (see lib/prostage/lolesports.ts for the live-verified proof):
//   overview_page  --(prefix/contains map)-->  lolesports leagueId
//   leagueId + teams + game_datetime           -->  the match (schedule event) id
//   matchId + game# (GameId trailing segment)  -->  games[number].id = esportsGameId
//   esportsGameId  --(livestats window/details walk)-->  per-participant builds
//   participantId -> championId(meta) -> champion_id -> player_link (DB rows)
//
// Every step distinguishes a PERMANENT "unavailable" (no league mapping, no
// schedule match, no such game number, feed genuinely empty) from a TRANSIENT
// failure (lolesports API 5xx/network, or a tainted details walk). A transient
// failure is NEVER recorded as unavailable — the caller retries later.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProGamePurchase } from "@/lib/pro/types";
import { normalizeName } from "./ddragon";
import {
  getEventDetails as realGetEventDetails,
  getLeagues as realGetLeagues,
  getScheduleForLeague as realGetScheduleForLeague,
  LolesportsFetchError,
  type LolEventDetails,
  type LolLeague,
  type LolScheduleEvent,
  type SchedulePage,
} from "./lolesports";
import {
  buildTimeline as realBuildTimeline,
  fetchLatestFrameTs as realFetchLatestFrameTs,
  fetchOpeningWindow as realFetchOpeningWindow,
  type GameMetadata,
  type ParticipantMeta,
  type TimelineResult,
} from "./timeline";

// ── league mapping (Leaguepedia overview_page -> lolesports league slug) ─────

// Prefix-anchored (matches the same page-tree-root convention
// lib/prostage/tournaments.ts uses) so "LCK/2026 Season/Road to MSI" -> lck,
// and a substring false positive ("LPLOL/...") can't sneak in.
const LEAGUE_PREFIX_TO_SLUG: Array<[string, string]> = [
  ["LEC", "lec"],
  ["LCK", "lck"],
  ["LPL", "lpl"],
  ["LCS", "lcs"],
  ["LTA", "lta_cross"], // LTA umbrella; cross-conference schedule is the broad net
];
// International events have no shared page-tree root, so match by contained name.
// "Esports World Cup" added 2026-07-19 alongside the tournaments.ts ingest fix
// (real page: "Esports World Cup 2026") — slug live-verified against
// getLeagues() the same day: league id 116838530616006090, slug "ewc_lol",
// name "Esports World Cup".
const EVENT_CONTAINS_TO_SLUG: Array<[string, string]> = [
  ["Mid-Season Invitational", "msi"],
  ["MSI", "msi"],
  ["World Championship", "worlds"],
  ["Worlds", "worlds"],
  ["Esports World Cup", "ewc_lol"],
  // Live-verified via getLeagues 2026-07-22: "Circuito Desafiante" -> slug
  // "cd" (league id 105549980953490846). NOT guessed (v0.31.1 rule).
  ["Circuito Desafiante", "cd"],
];

/** Maps a Leaguepedia overview_page to a lolesports league slug, or null when
 *  no tier-1 mapping applies (caller -> unavailable). Pure. */
export function leagueSlugForOverviewPage(overviewPage: string): string | null {
  const page = overviewPage.trim();
  for (const [prefix, slug] of LEAGUE_PREFIX_TO_SLUG) {
    if (page.startsWith(`${prefix}/`) || page === prefix) return slug;
  }
  for (const [needle, slug] of EVENT_CONTAINS_TO_SLUG) {
    if (page.includes(needle)) return slug;
  }
  return null;
}

// ── GameId parsing ───────────────────────────────────────────────────────────

/** The 1-based game-in-series number = the trailing "_<n>" segment of a
 *  Leaguepedia GameId (e.g. "...Bracket Round 2_4_1" -> 1). Returns null when
 *  the trailing segment isn't a positive integer. Pure. */
export function parseGameNumber(gameId: string): number | null {
  const last = gameId.split("_").pop();
  if (!last || !/^\d+$/.test(last)) return null;
  const n = parseInt(last, 10);
  return n > 0 ? n : null;
}

// ── team matching ────────────────────────────────────────────────────────────

/** Normalized token set for one schedule-event team (name AND code, both
 *  normalized) — either can match a Leaguepedia team name. */
function eventTeamTokens(t: { name?: string; code?: string }): Set<string> {
  const s = new Set<string>();
  if (t.name) s.add(normalizeName(t.name));
  if (t.code) s.add(normalizeName(t.code));
  return s;
}

// Minimum normalized-token length before a containment (substring) match is
// trusted — keeps short 2-3 letter codes (T1, G2, KC) on EXACT match only;
// containment on something that short risks matching an unrelated team whose
// name happens to embed those letters.
const MIN_CONTAINMENT_LEN = 4;

/** True when two normalized name/code tokens denote the same team: an exact
 *  match, or (for tokens long enough to be unambiguous) one contains the
 *  other. Live-verified 2026-07-10 against 26 real prostage games that a
 *  strict-equality match wrongly marked "unavailable" — three recurring
 *  Leaguepedia<->lolesports naming-drift shapes, ALL fixed by containment
 *  alone (no separate stripping step needed, since the drift always nests one
 *  name inside the other):
 *    - sponsor-name drift: "Team Liquid" (Leaguepedia) vs lolesports' current
 *      "Team Liquid Alienware"/"TLAW"; "Deep Cross Gaming" vs "Relove Deep
 *      Cross Gaming".
 *    - legal-entity/suffix drift: "Gen.G" vs lolesports "Gen.G Esports" /
 *      code "GEN" ("geng".includes("gen") — the containment even catches the
 *      code case here, not just the full name).
 *    - Leaguepedia disambiguation suffixes: "LYON (2024 American Team)" (added
 *      when multiple historical orgs share a short name) vs lolesports' plain
 *      "LYON" — the parenthetical always TRAILS the real name, so
 *      "lyon2024americanteam".includes("lyon") already holds.
 */
function tokensEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < MIN_CONTAINMENT_LEN || b.length < MIN_CONTAINMENT_LEN) return false;
  return a.includes(b) || b.includes(a);
}

/** True when the two DB team names correspond to the two schedule-event teams
 *  (order-independent). Each DB team must match one distinct event team via
 *  its name OR code, per tokensEquivalent above. Pure. */
export function teamsMatch(dbTeams: [string, string], eventTeams: Array<{ name?: string; code?: string }>): boolean {
  if (eventTeams.length !== 2) return false;
  const db = [normalizeName(dbTeams[0]), normalizeName(dbTeams[1])];
  const tok = eventTeams.map(eventTeamTokens);
  const oneMatches = (dbNorm: string, tokens: Set<string>): boolean =>
    Array.from(tokens).some((t) => tokensEquivalent(dbNorm, t));
  // Try both pairings.
  const matches = (i: number, j: number) => oneMatches(db[0], tok[i]) && oneMatches(db[1], tok[j]);
  return matches(0, 1) || matches(1, 0);
}

// ── champion internal-id -> numeric key (ddragon champion.json) ──────────────

const DDRAGON_BASE = "https://ddragon.leagueoflegends.com";
let championKeyCache: Promise<Map<string, number>> | null = null;

async function ddragonJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ddragon fetch failed: ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** internal id string (e.g. "MonkeyKing", "JarvanIV") -> numeric champion key
 *  (62, 59). Memoized per process. Champion keys are patch-stable, so the latest
 *  version's champion.json is fine regardless of the game's patch. The livestats
 *  metadata's `championId` is USUALLY this internal id, occasionally already
 *  numeric — resolveChampionKey below handles both. */
export function getChampionKeyByInternalId(): Promise<Map<string, number>> {
  if (!championKeyCache) {
    championKeyCache = (async () => {
      const versions = await ddragonJson<string[]>(`${DDRAGON_BASE}/api/versions.json`);
      const version = versions[0];
      const champ = await ddragonJson<{ data: Record<string, { key: string }> }>(
        `${DDRAGON_BASE}/cdn/${version}/data/en_US/champion.json`
      );
      const map = new Map<string, number>();
      for (const [internalId, entry] of Object.entries(champ.data)) {
        const key = parseInt(entry.key, 10);
        if (!Number.isNaN(key)) map.set(internalId, key);
      }
      return map;
    })().catch((err) => {
      championKeyCache = null;
      throw err;
    });
  }
  return championKeyCache;
}

export function __resetChampionKeyCacheForTests(): void {
  championKeyCache = null;
}

/** Resolve a livestats metadata championId to a numeric champion key: a bare
 *  numeric string passes through; otherwise look up the internal id. Pure given
 *  the map. Returns null when unresolvable. */
export function resolveChampionKey(championId: string, byInternalId: Map<string, number>): number | null {
  if (/^\d+$/.test(championId)) return parseInt(championId, 10);
  return byInternalId.get(championId) ?? null;
}

// ── DB row shape this module needs ───────────────────────────────────────────

export interface TimelineDbRow {
  player_link: string;
  team: string | null;
  champion_id: number;
}

// ── participant -> player_link mapping ───────────────────────────────────────

/** All 10 participants (blue pids 1-5, red pids 6-10) from metadata. */
function orderedParticipants(meta: GameMetadata): ParticipantMeta[] {
  return [
    ...(meta.blueTeamMetadata?.participantMetadata ?? []),
    ...(meta.redTeamMetadata?.participantMetadata ?? []),
  ];
}

/**
 * Map each participant's walked sequence to a player_link's ProGamePurchase[].
 * Keyed by champion_id (unique within one game — all 10 champions distinct), so
 * "TAG Name" summoner-name / disambiguation-suffix mismatches never bite. A
 * participant whose champion doesn't resolve or doesn't match any DB row is
 * skipped (not fabricated); a DB player with no matched participant simply gets
 * no entry (caller stores []). Pure given the champion-key map.
 */
export function mapTimelinesToPlayers(
  timeline: TimelineResult,
  meta: GameMetadata,
  dbRows: TimelineDbRow[],
  championKeyByInternalId: Map<string, number>
): Map<string, ProGamePurchase[]> {
  const playerByChampId = new Map<number, string>();
  for (const r of dbRows) {
    if (typeof r.champion_id === "number") playerByChampId.set(r.champion_id, r.player_link);
  }

  const byPlayer = new Map<string, ProGamePurchase[]>();
  for (const p of orderedParticipants(meta)) {
    const champKey = resolveChampionKey(p.championId, championKeyByInternalId);
    if (champKey == null) continue;
    const playerLink = playerByChampId.get(champKey);
    if (!playerLink) continue;
    const seq = timeline.seq[p.participantId] ?? [];
    byPlayer.set(
      playerLink,
      seq.map((e) => ({ itemId: e.id, ts: e.atSec }))
    );
  }
  return byPlayer;
}

// ── esports-game-id resolution ───────────────────────────────────────────────

const MAX_SCHEDULE_PAGES = 10; // bound the older-token walk for busy leagues
const DATE_MATCH_WINDOW_MS = 48 * 3_600_000; // a schedule event within ±48h of the game datetime
const PAGE_PAST_TARGET_SLACK_MS = 2 * 86_400_000; // stop paging once a page is >2d older than the target

export interface ResolveDeps {
  getLeagues?: () => Promise<LolLeague[]>;
  getScheduleForLeague?: (leagueId: string, pageToken?: string) => Promise<SchedulePage>;
  getEventDetails?: (matchId: string) => Promise<LolEventDetails>;
}

type ResolveIdResult =
  | { ok: true; esportsGameId: string }
  | { ok: false; transient: boolean; reason: string };

/**
 * Resolve (overview_page, teams, game_datetime, game#) -> esports game id.
 * A LolesportsFetchError anywhere -> { transient:true } (retry later). A clean
 * 200 that just has no matching league/event/game -> { transient:false }
 * (unavailable).
 */
export async function resolveEsportsGameId(
  params: { overviewPage: string; teams: [string, string]; gameDatetime: string; gameNumber: number },
  deps: ResolveDeps = {}
): Promise<ResolveIdResult> {
  const getLeagues = deps.getLeagues ?? realGetLeagues;
  const getSchedule = deps.getScheduleForLeague ?? realGetScheduleForLeague;
  const getEventDetails = deps.getEventDetails ?? realGetEventDetails;

  const slug = leagueSlugForOverviewPage(params.overviewPage);
  if (!slug) return { ok: false, transient: false, reason: `no league mapping for "${params.overviewPage}"` };

  const targetMs = new Date(params.gameDatetime).getTime();
  if (!Number.isFinite(targetMs)) {
    return { ok: false, transient: false, reason: `unparseable game_datetime "${params.gameDatetime}"` };
  }

  try {
    const leagues = await getLeagues();
    const league = leagues.find((l) => l.slug === slug);
    if (!league) return { ok: false, transient: false, reason: `lolesports has no league slug "${slug}"` };

    // Walk schedule pages (older token) collecting team-matching candidates
    // within the date window; stop once we've paged past the target date.
    //
    // `pagingExhaustedWithoutReachingWindow` (P3(e) fix, 2026-07-17): tracks
    // whether the loop stopped for a NATURAL reason (no more older pages, or
    // this page's oldest event is already comfortably past the target date —
    // either way, we've genuinely covered the whole relevant window) versus
    // hitting the MAX_SCHEDULE_PAGES safety cap first. Only the natural-stop
    // case licenses a confident "no match exists" (unavailable) conclusion
    // when candidates is empty — hitting the artificial page cap on a busy
    // league's schedule means the real match might simply be further back
    // than we paged, which is a TRANSIENT (retry-worthy, budget/timeout)
    // condition, not proof the game doesn't exist.
    const candidates: LolScheduleEvent[] = [];
    let pageToken: string | undefined;
    let pagingExhaustedWithoutReachingWindow = true;
    for (let page = 0; page < MAX_SCHEDULE_PAGES; page++) {
      const { events, olderToken }: SchedulePage = await getSchedule(league.id, pageToken);
      for (const ev of events) {
        if (ev.type && ev.type !== "match") continue;
        const evTeams = ev.match?.teams ?? [];
        if (!ev.match?.id || evTeams.length !== 2) continue;
        if (!teamsMatch(params.teams, evTeams)) continue;
        const evMs = ev.startTime ? new Date(ev.startTime).getTime() : NaN;
        if (!Number.isFinite(evMs) || Math.abs(evMs - targetMs) > DATE_MATCH_WINDOW_MS) continue;
        candidates.push(ev);
      }
      // Stop paging once this page's oldest event is comfortably older than the
      // target (we've covered the window) or there are no older pages.
      const oldestMs = events.reduce(
        (min, e) => Math.min(min, e.startTime ? new Date(e.startTime).getTime() : Infinity),
        Infinity
      );
      if (!olderToken) {
        pagingExhaustedWithoutReachingWindow = false;
        break;
      }
      if (Number.isFinite(oldestMs) && oldestMs < targetMs - PAGE_PAST_TARGET_SLACK_MS) {
        pagingExhaustedWithoutReachingWindow = false;
        break;
      }
      pageToken = olderToken;
    }

    if (candidates.length === 0) {
      if (pagingExhaustedWithoutReachingWindow) {
        // Hit MAX_SCHEDULE_PAGES before naturally covering the target date
        // window — we genuinely don't know if a match exists further back.
        return {
          ok: false,
          transient: true,
          reason: `schedule paging hit MAX_SCHEDULE_PAGES (${MAX_SCHEDULE_PAGES}) before reaching the target date window for teams ${params.teams.join(" vs ")} near ${params.gameDatetime}`,
        };
      }
      return { ok: false, transient: false, reason: `no schedule match for teams ${params.teams.join(" vs ")} near ${params.gameDatetime}` };
    }

    // Pick the event nearest the game datetime (disambiguates a rematch on
    // different days within the window).
    candidates.sort(
      (a, b) =>
        Math.abs(new Date(a.startTime!).getTime() - targetMs) -
        Math.abs(new Date(b.startTime!).getTime() - targetMs)
    );
    const matchId = candidates[0].match!.id!;

    const detail = await getEventDetails(matchId);
    const game = detail.games.find((g) => g.number === params.gameNumber);
    if (!game || !game.id) {
      return { ok: false, transient: false, reason: `match ${matchId} has no game #${params.gameNumber}` };
    }
    return { ok: true, esportsGameId: game.id };
  } catch (err) {
    if (err instanceof LolesportsFetchError) {
      return { ok: false, transient: true, reason: `lolesports API failure: ${err.message}` };
    }
    // Any other unexpected error is treated as transient (retry) rather than
    // baking in a permanent unavailable off a one-off bug/outage.
    return { ok: false, transient: true, reason: `unexpected resolve error: ${(err as Error).message}` };
  }
}

// ── top-level orchestrator ───────────────────────────────────────────────────

export type ComputeResult =
  | { status: "ok"; lolesportsGameId: string; byPlayer: Map<string, ProGamePurchase[]> }
  | { status: "unavailable"; reason: string }
  | { status: "transient"; reason: string };

export interface ComputeDeps extends ResolveDeps {
  fetchOpeningWindow?: typeof realFetchOpeningWindow;
  fetchLatestFrameTs?: typeof realFetchLatestFrameTs;
  buildTimeline?: typeof realBuildTimeline;
  getChampionKeyByInternalId?: () => Promise<Map<string, number>>;
}

/** Distinct non-empty team names from the game's DB rows (expect exactly 2). */
export function distinctTeams(dbRows: TimelineDbRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of dbRows) {
    const t = (r.team ?? "").trim();
    if (!t) continue;
    const k = normalizeName(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Full resolve + walk + map for one game. `dbRows` are all rows sharing this
 * game_id (their team/champion_id/player_link). Returns a discriminated result
 * the caller maps to persistence + HTTP:
 *   ok          -> persist purchase_order for every byPlayer entry + status 'ok'
 *   unavailable -> persist status 'unavailable' (terminal), serve unavailable
 *   transient   -> persist NOTHING, serve 5xx (retry next request)
 */
export async function computeGameTimelines(
  gameId: string,
  gameDatetime: string,
  overviewPage: string,
  dbRows: TimelineDbRow[],
  deps: ComputeDeps = {}
): Promise<ComputeResult> {
  const fetchOpeningWindow = deps.fetchOpeningWindow ?? realFetchOpeningWindow;
  const fetchLatestFrameTs = deps.fetchLatestFrameTs ?? realFetchLatestFrameTs;
  const buildTimeline = deps.buildTimeline ?? realBuildTimeline;
  const championKeyFn = deps.getChampionKeyByInternalId ?? getChampionKeyByInternalId;

  const gameNumber = parseGameNumber(gameId);
  if (gameNumber == null) return { status: "unavailable", reason: `unparseable game number in "${gameId}"` };

  const teams = distinctTeams(dbRows);
  if (teams.length !== 2) {
    return { status: "unavailable", reason: `expected 2 teams for game, got ${teams.length}` };
  }

  const resolved = await resolveEsportsGameId(
    { overviewPage, teams: [teams[0], teams[1]], gameDatetime, gameNumber },
    deps
  );
  if (!resolved.ok) {
    return { status: resolved.transient ? "transient" : "unavailable", reason: resolved.reason };
  }
  const esportsGameId = resolved.esportsGameId;

  // Opening window -> metadata (championIds per participant) + game start.
  const opening = await fetchOpeningWindow(esportsGameId);
  if (!opening.ok) {
    // A resolved id whose feed genuinely 404s / is empty is terminal
    // (unavailable); a 5xx/network blip on that same fetch must retry.
    return opening.transient
      ? { status: "transient", reason: `livestats window fetch failed for game ${esportsGameId}` }
      : { status: "unavailable", reason: `livestats feed has no data for game ${esportsGameId}` };
  }

  // Final frame timestamp bounds the walk. A completed game's ladder should
  // resolve; if it fully fails, treat as transient rather than mislabel a real
  // game unavailable.
  const endTs = await fetchLatestFrameTs(esportsGameId, opening.gameStartTs);
  if (!endTs) {
    return { status: "transient", reason: `could not resolve final frame for game ${esportsGameId}` };
  }

  const timeline = await buildTimeline(esportsGameId, opening.gameStartTs, endTs);
  if (timeline.hadFailures || timeline.truncated) {
    // A tainted (incomplete, via a fetch failure) OR TRUNCATED (P3(e) fix,
    // 2026-07-17 — the WALK_MAX_POINTS cap was hit before covering the full
    // range) walk must not be persisted as finished; either way, a later
    // pass can retry.
    const why = timeline.hadFailures ? "incomplete (fetch failures)" : "truncated (WALK_MAX_POINTS cap hit)";
    return { status: "transient", reason: `livestats details walk ${why} for game ${esportsGameId}` };
  }

  let championKeyByInternalId: Map<string, number>;
  try {
    championKeyByInternalId = await championKeyFn();
  } catch (err) {
    return { status: "transient", reason: `ddragon champion map failed: ${(err as Error).message}` };
  }

  const byPlayer = mapTimelinesToPlayers(timeline, opening.metadata, dbRows, championKeyByInternalId);
  return { status: "ok", lolesportsGameId: esportsGameId, byPlayer };
}
