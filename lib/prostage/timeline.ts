// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/timeline.ts — reconstructs a completed lolesports game's per-
// player ITEM BUILD ORDER from the free/unauthenticated livestats CDN, by
// appear-only frame diffing across a bounded concurrent range walk. Ported from
// matchday's lib/lolInsights.ts (buildOrExtendTimeline / processTimelineFrame /
// fetchDetailsPage / fetchLatestWindow) and TRIMMED to the completed-games-only
// case coachbuild needs: no live cursor/resume, no in-flight cache — the caller
// (lib/prostage/resolveGame.ts) persists the finished walk to Postgres once.
//
// CRITICAL feed contract (the taint-avoidance the whole thing rests on; same
// standing rule as lib/prostage/cargo.ts's header + matchday's wiki):
//   details page:
//     204 No Content = a genuinely EMPTY window (pre-start / pause / mid-game
//                      gap). NOT a failure — skipped, never retried, never taints.
//     200            = real frames (~10s / dozens of sub-second frames per page).
//     non-2xx        = a FAILURE (429/503/outage/etc.) -> retried, and if it
//                      never recovers, TAINTS the build (hadFailures).
//     null STRICTLY  = a fetch/parse failure (retry + possible taint) — NEVER
//                      conflated with an empty 204.
//   window feed: a far-future startingTime is NOT clamped to the final frame by
//     the CDN — it returns EMPTY. So the final frame of a completed game is found
//     via a descending candidate-startingTime ladder (fetchLatestWindow), never
//     by requesting `now`.
//
// A tainted walk (hadFailures) must NOT be persisted as a finished build — the
// caller re-attempts later (self-healing), never records it as "unavailable".
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout, FAST_FETCH_TIMEOUT_MS } from "../fetchTimeout";

const FEED_BASE = "https://feed.lolesports.com/livestats/v1";

// Walk tuning — identical rationale to matchday's (verified against the real
// feed 2026-07-04/10): details pages cover ~10s each, so a 10s stride is
// contiguous. 12-wide concurrency saturates the CDN path without inviting the
// 429s that would taint a once-only completed-game build. 500 points ≈ 83 min
// is a safety bound on a corrupt endTs, never reached by a real game.
const WALK_STRIDE_MS = 10_000;
const WALK_CONCURRENCY = 12;
const WALK_MAX_POINTS = 500;
const WALK_RETRY_ATTEMPTS = 2; // extra tries after the first on a FAILURE (null); a 204 empty page is never retried
const WALK_RETRY_BACKOFF_MS = 200; // linear: 200ms, 400ms
const END_SLACK_MS = 15_000;

// fetchLatestWindow candidate ladder — a completed game clamps any past-end
// offset to its final frame; we try `now - buffer` (live edge) then descending
// minute offsets from game start, taking the first that returns data.
const OFFSETS_MIN = [180, 120, 90, 70, 55, 47, 42, 38, 34, 30, 26, 22, 18, 14, 10, 6, 3, 1];
const LATEST_FUTURE_BUFFER_MS = 120_000;

// ── Raw feed shapes (partial — only the fields we read) ─────────────────────

export interface ParticipantMeta {
  participantId: number;
  esportsPlayerId?: string;
  summonerName: string;
  championId: string; // champion internal id string (e.g. "MonkeyKing"); occasionally numeric
  role: string;
}

export interface GameMetadata {
  patchVersion?: string;
  blueTeamMetadata: { esportsTeamId?: string; participantMetadata: ParticipantMeta[] };
  redTeamMetadata: { esportsTeamId?: string; participantMetadata: ParticipantMeta[] };
}

interface WindowFrame {
  rfc460Timestamp: string;
  gameState?: string; // 'in_game' | 'finished' | 'paused'
}

export interface WindowResponse {
  esportsGameId?: string;
  gameMetadata?: GameMetadata;
  frames?: WindowFrame[];
}

interface DetailsParticipant {
  participantId: number;
  items?: number[];
}

export interface DetailsFrame {
  rfc460Timestamp: string;
  participants?: DetailsParticipant[];
}

export interface DetailsResponse {
  frames?: DetailsFrame[];
}

/** Accumulated appear-only build sequence per participantId (1-10). */
export interface TimelineResult {
  /** participantId -> ordered [{item id, seconds into game}] first-appearances. */
  seq: Record<number, Array<{ id: number; atSec: number }>>;
  /** true if any details page failed after retries — the caller must treat the
   *  build as INCOMPLETE (do not persist as finished; re-attempt later). */
  hadFailures: boolean;
  /** P3(e) fix (2026-07-17 Fable review): true when the walk hit
   *  WALK_MAX_POINTS (500, ~83min) BEFORE covering [gameStart, endTs] —
   *  i.e. a genuinely truncated build, not a safety margin that was never
   *  approached. Previously this silently persisted `timeline_status='ok'`
   *  with a cut-off build order and no signal anything was wrong. A caller
   *  must treat `truncated` the SAME way it treats `hadFailures` (do not
   *  persist as finished; a later pass can retry) — resolveGame.ts's
   *  computeGameTimelines checks `hadFailures || truncated`. Kept as a
   *  separate field rather than folded into hadFailures itself so a test
   *  (or a future caller) can tell "network/feed failures" apart from
   *  "walk budget exhausted" if that distinction ever matters. */
  truncated: boolean;
}

// ── small helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** ISO string floored to the nearest 10s (the feed requires 10s-aligned times). */
export function iso10s(ms: number): string {
  const rounded = Math.floor(ms / 10_000) * 10_000;
  return new Date(rounded).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function secondsBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
}

/** Plain JSON GET of a window page. Returns null on ANY failure (non-2xx /
 *  network / parse) OR an empty result — window pages are only used to locate
 *  the opening + final frames, where "no usable frames" and "fetch failed" are
 *  handled the same by the candidate ladder (it just tries the next offset). */
async function fetchWindowJson(url: string): Promise<WindowResponse | null> {
  try {
    const res = await fetchWithTimeout(url, {}, FAST_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    return (await res.json()) as WindowResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch ONE details page, discriminating EMPTY from FAILURE (see file header):
 *   204        -> { frames: [] }  (definitive empty — not a failure)
 *   non-2xx    -> null            (failure — retry + possible taint)
 *   200        -> parsed body     (real frames)
 *   parse fail -> null            (truncated 200 treated as a transient failure;
 *                                  the feed only ever 204s a genuinely empty page)
 *   network err-> null
 * fetchWindowJson can't be reused: its res.json() throws on the 204 empty body
 * and would map that to null, collapsing empty-pause and transient-failure into
 * one signal — the exact bug this discrimination avoids.
 */
export async function fetchDetailsPage(
  gameId: string,
  startingTime: string
): Promise<DetailsResponse | null> {
  try {
    const res = await fetchWithTimeout(
      `${FEED_BASE}/details/${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(startingTime)}`,
      {},
      FAST_FETCH_TIMEOUT_MS
    );
    if (res.status === 204) return { frames: [] };
    if (!res.ok) return null;
    try {
      return (await res.json()) as DetailsResponse;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * The OPENING window (no startingTime) -> metadata + game-start timestamp.
 * Classifies failure so a TRANSIENT feed outage is never mistaken for a
 * permanent no-data (which the caller would persist as terminal 'unavailable'):
 *   200 + metadata + frames -> { ok:true }
 *   HTTP 404 (RESOURCE_NOT_FOUND) -> { ok:false, transient:false }  (the feed
 *     genuinely has no such esportsGameId — e.g. a never-played/purged game)
 *   200 but no metadata/frames    -> { ok:false, transient:false }  (empty)
 *   5xx / 429 / network / parse   -> { ok:false, transient:true }   (retry)
 * The distinction matters because a resolved esports id whose feed 404s is
 * terminally unavailable, but the very same call failing on a 503 must retry —
 * same never-record-a-transient-failure discipline as the details walk.
 */
export async function fetchOpeningWindow(
  gameId: string
): Promise<
  | { ok: true; metadata: GameMetadata; gameStartTs: string }
  | { ok: false; transient: boolean }
> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${FEED_BASE}/window/${encodeURIComponent(gameId)}`, {}, FAST_FETCH_TIMEOUT_MS);
  } catch {
    return { ok: false, transient: true };
  }
  if (res.status === 404) return { ok: false, transient: false };
  if (!res.ok) return { ok: false, transient: true };
  let body: WindowResponse;
  try {
    body = (await res.json()) as WindowResponse;
  } catch {
    return { ok: false, transient: true };
  }
  const meta = body.gameMetadata;
  const gameStartTs = body.frames?.[0]?.rfc460Timestamp;
  if (!meta || !gameStartTs) return { ok: false, transient: false };
  return { ok: true, metadata: meta, gameStartTs };
}

/**
 * Find the final window frame's timestamp via the descending candidate ladder
 * (a far-future startingTime is NOT clamped by the CDN — it returns empty). Only
 * in-range candidates (>= gameStart, <= now - buffer) are tried, so a future
 * time (which 400s) is never requested. Returns the last 'finished' frame's ts
 * when present (authoritative end), else the last frame's ts, else null.
 */
export async function fetchLatestFrameTs(
  gameId: string,
  gameStartTs: string,
  deps?: { fetchWindow?: (url: string) => Promise<WindowResponse | null> }
): Promise<string | null> {
  const fetchWindow = deps?.fetchWindow ?? fetchWindowJson;
  const startMs = new Date(gameStartTs).getTime();
  const now = Date.now();
  const ceilMs = now - LATEST_FUTURE_BUFFER_MS;

  const candidateMs = [now - LATEST_FUTURE_BUFFER_MS, ...OFFSETS_MIN.map((m) => startMs + m * 60_000)];
  const ordered = Array.from(
    new Set(
      candidateMs
        .filter((ms) => ms >= startMs && ms <= ceilMs)
        .sort((a, b) => b - a)
        .map((ms) => iso10s(ms))
    )
  );

  for (const startingTime of ordered) {
    const w = await fetchWindow(
      `${FEED_BASE}/window/${encodeURIComponent(gameId)}?startingTime=${encodeURIComponent(startingTime)}`
    );
    const frames = w?.frames;
    if (!frames || frames.length === 0) continue;
    const finished = [...frames].reverse().find((f) => f.gameState === "finished");
    return (finished ?? frames[frames.length - 1]).rfc460Timestamp;
  }
  return null;
}

/**
 * Diff one details frame's inventories into the appear-only sequence: records
 * the FIRST game-time each item id appears per participant. Disappearances
 * (sells / components consumed into completed items) are ignored by design.
 * Exported for direct unit testing.
 */
export function processTimelineFrame(
  frame: DetailsFrame,
  state: { gameStartTs: string; seq: Record<number, Array<{ id: number; atSec: number }>>; seen: Record<number, Set<number>> }
): void {
  const atSec = Math.max(0, Math.round(secondsBetween(state.gameStartTs, frame.rfc460Timestamp)));
  for (const p of frame.participants ?? []) {
    const pid = p.participantId;
    if (pid == null) continue;
    if (!state.seen[pid]) state.seen[pid] = new Set();
    if (!state.seq[pid]) state.seq[pid] = [];
    const seen = state.seen[pid];
    for (const itemId of p.items ?? []) {
      if (!itemId) continue; // skip empty slots (0)
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      state.seq[pid].push({ id: itemId, atSec });
    }
  }
}

/**
 * Build the appear-only item timeline for a COMPLETED game across [gameStart,
 * endTs]. Fetches every 10s-aligned details page in the range with bounded
 * concurrency, dedupes overlapping pages by frame timestamp, then processes
 * frames in true chronological order so first-appearance times stay correct. An
 * empty (204) page contributes no frames but never taints; a page that FAILS
 * after retries sets hadFailures (the caller must not persist an incomplete
 * build). Exported with injectable deps for unit testing.
 */
export async function buildTimeline(
  gameId: string,
  gameStartTs: string,
  endTs: string,
  deps?: {
    fetchDetails?: (startingTime: string) => Promise<DetailsResponse | null>;
    concurrency?: number;
    maxPoints?: number;
    retryAttempts?: number;
    retryBackoffMs?: number;
  }
): Promise<TimelineResult> {
  const fetchDetails =
    deps?.fetchDetails ?? ((startingTime: string) => fetchDetailsPage(gameId, startingTime));
  const concurrency = Math.max(1, deps?.concurrency ?? WALK_CONCURRENCY);
  const maxPoints = Math.max(1, deps?.maxPoints ?? WALK_MAX_POINTS);
  const retryAttempts = Math.max(0, deps?.retryAttempts ?? WALK_RETRY_ATTEMPTS);
  const retryBackoffMs = Math.max(0, deps?.retryBackoffMs ?? WALK_RETRY_BACKOFF_MS);

  const state = {
    gameStartTs,
    seq: {} as Record<number, Array<{ id: number; atSec: number }>>,
    seen: {} as Record<number, Set<number>>,
  };

  const startMs = new Date(gameStartTs).getTime();
  const endMs = new Date(endTs).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { seq: state.seq, hadFailures: false, truncated: false };
  }

  // Enumerate the 10s-aligned startingTimes to fetch. `truncated` is set when
  // the maxPoints cap is hit BEFORE the range [gameStart, endTs+slack] is
  // fully covered — i.e. there's a real remaining ms range beyond what
  // `points` ended up holding, not just "the loop happened to stop exactly
  // at the cap on the last needed point."
  const alignedStartMs = Math.floor(startMs / WALK_STRIDE_MS) * WALK_STRIDE_MS;
  const points: number[] = [];
  let truncated = false;
  for (let ms = alignedStartMs; points.length < maxPoints; ms += WALK_STRIDE_MS) {
    if (ms > endMs + END_SLACK_MS) break;
    points.push(ms);
  }
  if (points.length === maxPoints) {
    const nextMs = alignedStartMs + points.length * WALK_STRIDE_MS;
    if (nextMs <= endMs + END_SLACK_MS) truncated = true;
  }

  // Fetch ONE page, retrying only a FAILURE (null); a 204 empty page is accepted
  // on the first try (pauses must not cost a retry burst).
  const fetchWithRetry = async (
    startingTime: string
  ): Promise<{ res: DetailsResponse | null; failed: boolean }> => {
    let res = await fetchDetails(startingTime);
    if (res !== null) return { res, failed: false };
    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      await sleep(retryBackoffMs * attempt);
      res = await fetchDetails(startingTime);
      if (res !== null) return { res, failed: false };
    }
    return { res: null, failed: true };
  };

  const collected: DetailsFrame[] = [];
  let hadFailures = false;
  for (let i = 0; i < points.length; i += concurrency) {
    const batch = points.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (ms) => {
        const { res, failed } = await fetchWithRetry(iso10s(ms));
        if (failed) hadFailures = true;
        return res;
      })
    );
    for (const d of results) {
      for (const f of d?.frames ?? []) collected.push(f);
    }
  }

  // Dedupe overlapping pages by frame timestamp, process in chronological order.
  const byTs = new Map<string, DetailsFrame>();
  for (const f of collected) {
    if (f?.rfc460Timestamp) byTs.set(f.rfc460Timestamp, f);
  }
  const sorted = Array.from(byTs.values()).sort(
    (a, b) => new Date(a.rfc460Timestamp).getTime() - new Date(b.rfc460Timestamp).getTime()
  );
  for (const f of sorted) processTimelineFrame(f, state);

  return { seq: state.seq, hadFailures, truncated };
}
