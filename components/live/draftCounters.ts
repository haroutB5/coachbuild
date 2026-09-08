// ─────────────────────────────────────────────────────────────────────────────
// draftCounters.ts — client-side wiring for GET /api/draft/counters (enemy
// counter picks from lolalytics). Same posture as draftRecommend.ts's
// fetch wrapper: one thin defensive fetch, never throws, degrades to null
// on any failure so app/draft/page.tsx never needs its own try/catch. The
// query builder is pure and pinned by fetch-mock tests; the pool split
// itself lives in lib/lolalytics/pool.ts (dependency-free, shared).
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftCounterSuggestion {
  champId: number;
  name: string;
  /** Candidate's win rate vs the enemy, 0..1. */
  winRate: number;
  /** Candidate's matchup change from its own field baseline, pp (negative page Δ1). */
  delta1pp: number;
  /** Normalised edge, pp. */
  delta2pp: number;
  games: number;
}

export interface DraftCountersResponse {
  enemy: { id: number; name: string; slug: string };
  lane: number;
  /** lolalytics bracket slug, e.g. "emerald_plus" — rendered into the
   *  strip's "lolalytics {tier} {patch}" annotation, never a hardcoded copy. */
  tier: string;
  patch: string;
  fetchedAt: string;
  suggestions: DraftCounterSuggestion[];
  parsedRows: number;
  skippedCards: number;
  gatedRows: number;
  unmappedRows: number;
  directionAgreements: number;
}

export interface DraftCountersParams {
  enemy: number;
  lane: number;
}

/** Builds the query string for GET /api/draft/counters. Pure so it can be
 *  asserted without a network call. */
export function buildDraftCountersQuery(params: DraftCountersParams): string {
  const qs = new URLSearchParams();
  qs.set("enemy", String(params.enemy));
  qs.set("lane", String(params.lane));
  return qs.toString();
}

function normalizeSuggestion(raw: unknown): DraftCounterSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftCounterSuggestion>;
  if (
    typeof r.champId !== "number" || !Number.isFinite(r.champId) ||
    typeof r.name !== "string" ||
    typeof r.winRate !== "number" || !Number.isFinite(r.winRate) ||
    typeof r.delta1pp !== "number" || !Number.isFinite(r.delta1pp) ||
    typeof r.delta2pp !== "number" || !Number.isFinite(r.delta2pp) ||
    typeof r.games !== "number" || !Number.isFinite(r.games) || r.games <= 0
  ) {
    return null;
  }
  return { champId: r.champId, name: r.name, winRate: r.winRate, delta1pp: r.delta1pp, delta2pp: r.delta2pp, games: r.games };
}

/** Defensive parse of the whole envelope — a malformed suggestion is
 *  dropped, never taints the rest; a non-envelope degrades to null. */
export function normalizeDraftCountersResponse(raw: unknown): DraftCountersResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftCountersResponse> & {
    enemy?: Partial<DraftCountersResponse["enemy"]>;
  };
  if (typeof r.enemy?.id !== "number" || typeof r.enemy?.name !== "string" || typeof r.enemy?.slug !== "string") return null;
  if (typeof r.lane !== "number" || typeof r.tier !== "string" || typeof r.patch !== "string") return null;
  const suggestions = Array.isArray(r.suggestions)
    ? r.suggestions.map(normalizeSuggestion).filter((s): s is DraftCounterSuggestion => s !== null)
    : [];
  const countOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    enemy: { id: r.enemy.id, name: r.enemy.name, slug: r.enemy.slug },
    lane: r.lane,
    tier: r.tier,
    patch: r.patch,
    fetchedAt: typeof r.fetchedAt === "string" ? r.fetchedAt : "",
    suggestions,
    parsedRows: countOrZero(r.parsedRows),
    skippedCards: countOrZero(r.skippedCards),
    gatedRows: countOrZero(r.gatedRows),
    unmappedRows: countOrZero(r.unmappedRows),
    directionAgreements: countOrZero(r.directionAgreements),
  };
}

