// ─────────────────────────────────────────────────────────────────────────────
// draftRecommend.ts — client-side wiring for GET /api/draft/recommend (plan
// §4, engy's route). Same posture as heroContracts.ts's getHeroStats/
// getLaneDefaultChampions: one thin, defensive fetch wrapper per endpoint,
// never throws, degrades to null on any failure so app/draft/page.tsx never
// needs its own try/catch. Built against the plan's CONTRACT, not against a
// live route (engy ships app/api/draft/recommend/route.ts in parallel) — the
// query-building and response-normalizing pieces below are pure and covered
// by fetch-mock tests (components/__tests__/draftRecommend.test.ts) rather
// than a real network call.
// ─────────────────────────────────────────────────────────────────────────────

export type DraftConfidence = "low" | "normal";

/** {games, wins} — a raw personal record, never a rate/score. Mirrors
 *  lib/draft/recommend.ts's PersonalRecord on the wire. My Stats badges
 *  (My Stats backend, ratified 2026-07-21) are DISPLAY-ONLY — nothing in
 *  this file or app/draft/page.tsx may derive a score/sort order from these
 *  fields. See components/live/personalBadge.ts for the render model and
 *  the my-pool FILTER (never a re-scorer). */
export interface PersonalRecord {
  games: number;
  wins: number;
}

/** One PLAY candidate — lib/draft/score.ts's rankPlays()/splitPlaysBySampleSize()
 *  output shape (plan §3). `winVsLaneOpp` is null when there's no direct
 *  lane opponent (empty enemies, or none tagged as the lane slot) or the
 *  matchup sample fell below the N_FLOOR and was dropped — never a
 *  fabricated 50%. */
export interface DraftPlayResult {
  champId: number;
  score: number;
  winVsLaneOpp: number | null;
  /** v0.37.4: games behind `winVsLaneOpp` specifically (NOT the same as
   *  `minGames`, which can be pulled down by a different, smaller off-lane
   *  term or the candidate's own baseline sample — see lib/draft/score.ts's
   *  PlayResult.winVsLaneOppGames doc comment). Null under the same
   *  conditions as `winVsLaneOpp`. */
  winVsLaneOppGames: number | null;
  confidence: DraftConfidence;
  minGames: number;
  /** My Stats decoration (2026-07-21, additive): my record vs the resolved
   *  lane opponent specifically. Null when no lane opponent is resolved, OR
   *  absent/malformed on the wire (older cached response) — never a
   *  fabricated {games:0,wins:0} in that case, since "no lane opponent" and
   *  "lane opponent but zero games" are genuinely different states. */
  personal: PersonalRecord | null;
  /** My Stats decoration: my record on this champion in this lane, vs ANY
   *  opponent. Always populated — degrades to {games:0,wins:0} when
   *  absent/malformed on the wire (older cached response, or an account
   *  that's never played this champion) so callers never need a second
   *  null-check beyond `personal` above. */
  personalOverall: PersonalRecord;
}

/** One BAN candidate — lib/draft/score.ts's rankBans() output shape. Audit
 *  P2-2 (2026-07-21): confidence/minGames are REAL now (previously absent
 *  from the server's own type entirely — this file's old `minGames: number`
 *  + a 0-default normalizer papered over that gap, producing a fabricated
 *  "n=0 / low sample" on every single ban regardless of actual data).
 *  `minGames` is nullable (unlike DraftPlayResult's, which always has at
 *  least the candidate's own baseline sample) — a ban target with no
 *  matchup row against the hovered champion genuinely has nothing to
 *  report. */
export interface DraftBanResult {
  champId: number;
  score: number;
  confidence: DraftConfidence;
  minGames: number | null;
}

export interface DraftRecommendMeta {
  patch: string;
  tier: number;
  fetchedAt: string;
  /** v2026-07-21 contract reconciliation — WHICH enemy (if any) the server
   *  actually scored with the direct-lane weight (W_DIRECT), whether that
   *  came from the request's own `laneOpp` param or the server's own
   *  statistical fallback (highest-pickrate enemy in this lane) when
   *  `laneOpp` was omitted/invalid. Null when no enemy qualified either
   *  way. Absent on a malformed/older response degrades to null. */
  laneOppInferred: number | null;
  /** Round-B (2026-07-21) stale-data honesty fix: the patch the rest of the
   *  app considers current, independent of `patch` above (which is whatever
   *  the draft tables actually have ingested — see lib/draft/recommend.ts's
   *  RecommendMeta.currentPatch doc comment for why these can diverge for
   *  days at a time). Null on a malformed/older response, or if the
   *  server's own resolver failed — degrades to "no staleness notice"
   *  rather than a false positive. */
  currentPatch: string | null;
}

export interface DraftRecommendResponse {
  /** "Main" list per v0.37.4's sample-size split — when a direct lane
   *  opponent is resolved, only candidates with >= 1,000 games vs that
   *  opponent; unchanged single-list behavior when no opponent is
   *  resolved. Field name kept for back-compat. */
  plays: DraftPlayResult[];
  /** v0.37.4, NEW: candidates with a matchup vs the resolved lane opponent
   *  under 1,000 games (but still scored, same floor as `plays`) — "leads,
   *  not conclusions". Always [] when no lane opponent is resolved, OR when
   *  absent/malformed on the wire (an older cached response can't crash the
   *  client over a field it doesn't know about). */
  potentialPlays: DraftPlayResult[];
  /** null when no `hover` was sent (bans only compute against a hovered
   *  own-champion, plan §3/§6a: "hover-your-champ picker -> Bans section
   *  appears"). */
  bans: DraftBanResult[] | null;
  meta: DraftRecommendMeta;
  /** True while the patch's draft tables haven't finished ingesting yet
   *  (plan §9 ship sequence gates the UI on a pre-bootstrapped table, but a
   *  patch rollover mid-session can still hit this transiently) — the UI
   *  must not fabricate empty-looking results in that window (§6a's
   *  "pending" copy). */
  pending?: boolean;
}

export interface DraftRecommendParams {
  /** App lane convention, 0-4 (heroContracts.ts's LANE_TO_ROLE_ID) — REQUIRED
   *  per plan §4 ("lane=<0-4 required>"). */
  lane: number;
  /** Enemy championIds, any order — deduped/capped by the caller
   *  (draftLiveSync.ts's normalizeDraftEnemyIds) before this is called. */
  enemies: number[];
  /** The user's own hovered/locked champion — omitted from the query
   *  entirely when null (no bans section, per the contract). */
  hover: number | null;
  /** CONTRACT RECONCILED 2026-07-21 (was a position-0-in-`enemies`-csv
   *  guess pending a check against engy's route — see git history for the
   *  old orderEnemiesForQuery approach this replaced): explicit champId of
   *  the enemy occupying the user's own lane slot — companion mode:
   *  theirTeam's same-index entry as the local player's roleId; manual
   *  mode: whichever chip the user flagged isDirectLaneOpp. Omitted from
   *  the query when null OR absent from `enemies` (the route's own
   *  contract: an invalid laneOpp falls back to server-side statistical
   *  inference, never a client-side guess). Optional so existing call
   *  sites/tests that don't care about lane-opponent tagging don't need to
   *  thread a literal `null` through everywhere. */
  laneOpp?: number | null;
}

/** Builds the query string for GET /api/draft/recommend. Pure so it can be
 *  asserted without a network call — the exact param names/shape are the one
 *  thing that must never silently drift from engy's route contract. */
export function buildDraftRecommendQuery(params: DraftRecommendParams): string {
  const qs = new URLSearchParams();
  qs.set("lane", String(params.lane));
  if (params.enemies.length > 0) qs.set("enemies", params.enemies.join(","));
  if (params.hover !== null) qs.set("hover", String(params.hover));
  if (params.laneOpp !== null && params.laneOpp !== undefined) qs.set("laneOpp", String(params.laneOpp));
  return qs.toString();
}

function isConfidence(v: unknown): v is DraftConfidence {
  return v === "low" || v === "normal";
}

/** `wins` must be a number AND `games` must be a number for this to count as
 *  a real record — a partially-malformed object (e.g. `{games: 3}` with no
 *  `wins`) is treated the same as "absent," never coerced with a fabricated
 *  0 for the missing half. */
function normalizePersonalRecord(raw: unknown): PersonalRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PersonalRecord>;
  if (typeof r.games !== "number" || typeof r.wins !== "number") return null;
  return { games: r.games, wins: r.wins };
}

function normalizePlay(raw: unknown): DraftPlayResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftPlayResult>;
  if (typeof r.champId !== "number" || typeof r.score !== "number") return null;
  return {
    champId: r.champId,
    score: r.score,
    winVsLaneOpp: typeof r.winVsLaneOpp === "number" ? r.winVsLaneOpp : null,
    winVsLaneOppGames: typeof r.winVsLaneOppGames === "number" ? r.winVsLaneOppGames : null,
    confidence: isConfidence(r.confidence) ? r.confidence : "low", // unknown -> the CAUTIOUS default, never a false "normal"
    minGames: typeof r.minGames === "number" ? r.minGames : 0,
    // My Stats fields absent/malformed (older cached response, or a server
    // that hasn't shipped this yet) degrade to "no personal data" -- never
    // crash, never a fabricated non-zero record.
    personal: normalizePersonalRecord(r.personal),
    personalOverall: normalizePersonalRecord(r.personalOverall) ?? { games: 0, wins: 0 },
  };
}

function normalizeBan(raw: unknown): DraftBanResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftBanResult>;
  if (typeof r.champId !== "number" || typeof r.score !== "number") return null;
  return {
    champId: r.champId,
    score: r.score,
    confidence: isConfidence(r.confidence) ? r.confidence : "low",
    minGames: typeof r.minGames === "number" ? r.minGames : null,
  };
}

/** Defensive parse of the whole envelope — a malformed individual play/ban
 *  entry is dropped (never taints the rest of the list); a malformed/missing
 *  `meta` degrades to empty-string patch + fetchedAt (the UI's patch/fetch-
 *  date stamp then reads as "—", never a fabricated value) rather than
 *  rejecting the whole response. Returns null only when the payload isn't
 *  even a recognizable envelope at all (e.g. an HTML error page body). */
export function normalizeDraftRecommendResponse(raw: unknown): DraftRecommendResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftRecommendResponse> & { meta?: Partial<DraftRecommendMeta> };

  const plays = Array.isArray(r.plays) ? r.plays.map(normalizePlay).filter((p): p is DraftPlayResult => p !== null) : [];
  // v0.37.4: absent/malformed potentialPlays (older cached response, or a
  // server that hasn't shipped this field yet) degrades to [] -- never a
  // thrown error, and never treated as "the same as plays".
  const potentialPlays = Array.isArray(r.potentialPlays)
    ? r.potentialPlays.map(normalizePlay).filter((p): p is DraftPlayResult => p !== null)
    : [];
  const bans = Array.isArray(r.bans)
    ? r.bans.map(normalizeBan).filter((b): b is DraftBanResult => b !== null)
    : null;
  const meta: DraftRecommendMeta = {
    patch: typeof r.meta?.patch === "string" ? r.meta.patch : "",
    tier: typeof r.meta?.tier === "number" ? r.meta.tier : 0,
    fetchedAt: typeof r.meta?.fetchedAt === "string" ? r.meta.fetchedAt : "",
    laneOppInferred: typeof r.meta?.laneOppInferred === "number" ? r.meta.laneOppInferred : null,
    currentPatch: typeof r.meta?.currentPatch === "string" ? r.meta.currentPatch : null,
  };

  return { plays, potentialPlays, bans, meta, pending: r.pending === true };
}

export interface DraftRecommendDeps {
  fetchImpl?: typeof fetch;
}

/** GET /api/draft/recommend, defensive end to end — network failure, non-2xx,
 *  and malformed-body all degrade to null (the caller renders its own
 *  "couldn't load, try again" state, same posture as every other fetch
 *  wrapper in this codebase — never a thrown error reaching a component). */
export async function fetchDraftRecommend(
  params: DraftRecommendParams,
  deps: DraftRecommendDeps = {}
): Promise<DraftRecommendResponse | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`/api/draft/recommend?${buildDraftRecommendQuery(params)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeDraftRecommendResponse(data);
  } catch {
    return null;
  }
}
