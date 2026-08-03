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

import { synergyBand, type SynergyBand } from "@/lib/draft/score";
import type { DifficultyBand } from "@/lib/draft/difficulty";
import type { SuggestedDefense } from "@/lib/draft/damageProfile";

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
  /** Real sample size from the server. Null when an older cached payload
   *  predates this field; absence stays absent rather than becoming n=0. */
  minGames: number | null;
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
  /** Draft redesign plan §2.4, additive: = score - baselineWr
   *  (lib/draft/score.ts's PlayResult.synergyDelta, wire-identical). Defaults
   *  to 0 when absent/malformed (older cached response, or Stage 0 not
   *  landed yet) — never a fabricated non-zero swing. */
  synergyDelta: number;
  /** Derived CLIENT-SIDE via lib/draft/score.ts's synergyBand(synergyDelta)
   *  at normalization time — NOT sent on the wire itself (the server only
   *  ships synergyDelta; re-deriving here means the band can never drift
   *  from the same formula/thresholds the server would use). */
  synergyBand: SynergyBand;
}

/** One BAN candidate — lib/draft/score.ts's rankBans() output shape. Audit
 *  P2-2 (2026-07-21): confidence/minGames are REAL now (previously absent
 *  from the server's own type entirely — this file's old `minGames: number`
 *  + a 0-default normalizer papered over that gap, producing a fabricated
 *  "n=0 / low sample" on every single ban regardless of actual data).
 *  `minGames` is nullable — a ban target with no
 *  matchup row against the hovered champion genuinely has nothing to
 *  report. */
export interface DraftBanResult {
  champId: number;
  score: number;
  confidence: DraftConfidence;
  minGames: number | null;
  /** 0..1 — the ban target's winrate AGAINST your hovered pick (how often
   *  they beat you); see lib/draft/score.ts BanResult.winVsYou. Null on an
   *  older cached response that predates the field. */
  winVsYou: number | null;
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
  /** 2026-07-31 audit P2 (#2) — mirrors lib/draft/recommend.ts's
   *  RecommendMeta.ingestHealthy: did the last scheduled draft ingest run
   *  come back clean? `null` = unknown, NOT healthy — only render a warning
   *  on an explicit `false`. Absent/malformed on an older cached response
   *  degrades to null (no warning), same posture as currentPatch above. */
  ingestHealthy: boolean | null;
  /** Best-effort summary of the last failure; null when healthy/unknown or
   *  absent on the wire. */
  ingestLastError: string | null;
}

/** Lane-share facts derived from the matchup matrix. These are additive
 * display data for Draft Assistant filters/table rows; they never participate
 * in the server's recommendation score. */
export interface DraftLaneStat {
  champId: number;
  baselineWr: number | null;
  totalGames: number | null;
  laneShare: number | null;
}

export interface DraftMatchupPreviewRow {
  oppId: number;
  winRate: number;
  games: number;
  opponentLaneShare: number;
}

export interface DraftMatchupPreview {
  champId: number;
  worst: DraftMatchupPreviewRow[];
  best: DraftMatchupPreviewRow[];
}

/** Draft redesign plan §2.3 — mirrors lib/draft/recommend.ts's EnemyAnalysis
 *  on the wire. `laneThreatBand` reuses lib/draft/difficulty.ts's
 *  DifficultyBand union for its label vocabulary (Low/Medium/High) — a
 *  different axis (matchup danger) than champion kit-complexity difficulty,
 *  same type reused deliberately per the server type's own doc comment. */
export interface DraftEnemyAnalysis {
  champId: number;
  isLaneOpponent: boolean;
  winRateVsYou: number | null;
  winRateVsYouGames: number | null;
  laneThreatBand: DifficultyBand | null;
  suggestedDefense: SuggestedDefense | null;
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
  /** Draft redesign plan §2.3, additive: one entry per requested enemy.
   *  Always [] when absent/malformed on the wire (older cached response, or
   *  Stage 0 not landed yet) — never crashes the client over a field it
   *  doesn't know about. */
  enemyAnalysis: DraftEnemyAnalysis[];
  /** Full lane-share facts for the currently served patch/tier/role. Older
   * cached responses may omit this additive field. */
  laneStats?: DraftLaneStat[];
  /** Shrunk popular-opponent preview rows for the current lane. */
  matchupPreviews?: DraftMatchupPreview[];
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
    minGames: typeof r.minGames === "number" && Number.isFinite(r.minGames) ? r.minGames : null,
    // My Stats fields absent/malformed (older cached response, or a server
    // that hasn't shipped this yet) degrade to "no personal data" -- never
    // crash, never a fabricated non-zero record.
    personal: normalizePersonalRecord(r.personal),
    personalOverall: normalizePersonalRecord(r.personalOverall) ?? { games: 0, wins: 0 },
    // Draft redesign plan §2.4: absent/malformed -> 0, and synergyBand(0) is
    // always "Even" -- a consistent, honest default, never a fabricated
    // Strong/Weak swing.
    synergyDelta: typeof r.synergyDelta === "number" ? r.synergyDelta : 0,
    synergyBand: synergyBand(typeof r.synergyDelta === "number" ? r.synergyDelta : 0),
  };
}

function isDifficultyBand(v: unknown): v is DifficultyBand {
  return v === "Low" || v === "Medium" || v === "High";
}

function normalizeSuggestedDefense(raw: unknown): SuggestedDefense | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SuggestedDefense>;
  if (typeof r.label !== "string" || typeof r.reason !== "string") return null;
  return { label: r.label, reason: r.reason };
}

/** Draft redesign plan §2.3 — mirrors normalizePlay/normalizeBan's posture: a
 *  malformed entry is dropped entirely (never a fabricated champId: 0 row),
 *  and each optional field degrades independently to null/false rather than
 *  rejecting the whole entry over one bad field. */
function normalizeEnemyAnalysis(raw: unknown): DraftEnemyAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftEnemyAnalysis>;
  if (typeof r.champId !== "number") return null;
  return {
    champId: r.champId,
    isLaneOpponent: r.isLaneOpponent === true,
    winRateVsYou: typeof r.winRateVsYou === "number" ? r.winRateVsYou : null,
    winRateVsYouGames: typeof r.winRateVsYouGames === "number" ? r.winRateVsYouGames : null,
    laneThreatBand: isDifficultyBand(r.laneThreatBand) ? r.laneThreatBand : null,
    suggestedDefense: normalizeSuggestedDefense(r.suggestedDefense),
  };
}

function normalizeMatchupPreviewRow(raw: unknown): DraftMatchupPreviewRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftMatchupPreviewRow>;
  if (
    typeof r.oppId !== "number" ||
    typeof r.winRate !== "number" ||
    typeof r.games !== "number" ||
    typeof r.opponentLaneShare !== "number" ||
    ![r.oppId, r.winRate, r.games, r.opponentLaneShare].every(Number.isFinite) ||
    r.games <= 0 ||
    r.opponentLaneShare < 0
  ) {
    return null;
  }
  return {
    oppId: r.oppId,
    winRate: r.winRate,
    games: r.games,
    opponentLaneShare: r.opponentLaneShare,
  };
}

function normalizeMatchupPreview(raw: unknown): DraftMatchupPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftMatchupPreview>;
  if (typeof r.champId !== "number" || !Number.isFinite(r.champId)) return null;
  const worst = Array.isArray(r.worst) ? r.worst.map(normalizeMatchupPreviewRow).filter((row): row is DraftMatchupPreviewRow => row !== null) : [];
  const best = Array.isArray(r.best) ? r.best.map(normalizeMatchupPreviewRow).filter((row): row is DraftMatchupPreviewRow => row !== null) : [];
  return { champId: r.champId, worst, best };
}

function normalizeLaneStat(raw: unknown): DraftLaneStat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftLaneStat>;
  if (typeof r.champId !== "number" || !Number.isFinite(r.champId)) return null;
  const baselineWr = typeof r.baselineWr === "number" && Number.isFinite(r.baselineWr) ? r.baselineWr : null;
  const totalGames = typeof r.totalGames === "number" && Number.isFinite(r.totalGames) && r.totalGames >= 0 ? r.totalGames : null;
  const laneShare = typeof r.laneShare === "number" && Number.isFinite(r.laneShare) && r.laneShare >= 0 ? r.laneShare : null;
  return { champId: r.champId, baselineWr, totalGames, laneShare };
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
    winVsYou: typeof r.winVsYou === "number" ? r.winVsYou : null,
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
    ingestHealthy: typeof r.meta?.ingestHealthy === "boolean" ? r.meta.ingestHealthy : null,
    ingestLastError: typeof r.meta?.ingestLastError === "string" ? r.meta.ingestLastError : null,
  };
  // Draft redesign plan §2.3: absent/malformed (older cached response, or
  // Stage 0 not landed yet) degrades to [] -- never crashes, never treated
  // as a signal that no enemies were requested.
  const enemyAnalysis = Array.isArray(r.enemyAnalysis)
    ? r.enemyAnalysis.map(normalizeEnemyAnalysis).filter((e): e is DraftEnemyAnalysis => e !== null)
    : [];

  const laneStats = Array.isArray(r.laneStats)
    ? r.laneStats.map(normalizeLaneStat).filter((entry): entry is DraftLaneStat => entry !== null)
    : undefined;
  const matchupPreviews = Array.isArray(r.matchupPreviews)
    ? r.matchupPreviews.map(normalizeMatchupPreview).filter((entry): entry is DraftMatchupPreview => entry !== null)
    : undefined;

  return {
    plays,
    potentialPlays,
    bans,
    meta,
    pending: r.pending === true,
    enemyAnalysis,
    ...(laneStats ? { laneStats } : {}),
    ...(matchupPreviews ? { matchupPreviews } : {}),
  };
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
