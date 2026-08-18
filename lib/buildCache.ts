// ─────────────────────────────────────────────────────────────────────────────
// buildCache.ts — one owner for "/api/build?champ=&role=&rank=", shared by
// every caller in the app, with in-flight dedupe and a short in-memory cache.
//
// WHY (measured, 2026-08-18, scripts/bench-champselect.mjs). Switching champion
// during champ select cost a full network round trip for the build EVERY time,
// including switching back to a champion whose build had already been fetched
// seconds earlier in the same champ select. `/api/build` is CDN-cached
// (s-maxage=21600) but carries no browser max-age, so the browser reuses
// nothing: a repeat champion measured 2977ms hero / 3029ms data, no better than
// a first-time one.
//
// It was also fetched TWICE for the same champion by two unrelated components:
// BuildTabContent (to render it) and AutoExporter (to push it to the League
// client). Same URL, same instant, two requests.
//
// This module makes both of those one request, and makes a champion the user
// has already seen this session render with no request at all. The prewarm
// (components/live/BuildPrewarmer.tsx) then moves that one request EARLIER —
// to the moment champ select resolves the champion, rather than the moment the
// user happens to open the Builds page.
//
// DELIBERATELY NOT a stale-while-revalidate cache. A build shown under a
// champion's name must be that champion's build; the TTL below bounds how old
// it can be, and an expired entry is refetched rather than shown while a
// refresh happens behind it.
//
// Pure module with an injectable fetch — no React, no DOM — so it is testable
// in this repo's node-environment vitest setup.
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse } from "@/lib/types";
import { rankQueryParam } from "@/lib/rankBrackets";

/** How long a cached outcome may be served without refetching. Long enough to
 *  cover a whole champ select plus the walk back to the Builds page, far
 *  shorter than the 6h CDN entry it is derived from. */
export const BUILD_CACHE_TTL_MS = 10 * 60 * 1000;

/** Bound on retained entries. A champ select touches a handful of champions; a
 *  long browsing session could touch many more, and this is held for the life
 *  of the document. Oldest-inserted is evicted first. */
export const BUILD_CACHE_MAX_ENTRIES = 32;

export type BuildOutcome =
  /** The route answered with at least one build. `builds` is the full array —
   *  BuildTabContent's alt-keystone salvage reads past index 0. */
  | { status: "ok"; builds: BuildResponse[] }
  /** 404, or a 2xx with an empty/malformed array: this champion+role genuinely
   *  has nothing. Cached — it is a real answer, not a failure. */
  | { status: "empty" }
  /** Never cached. `upstream` = the request reached the server and it answered
   *  badly; `network` = fetch itself threw. Kept distinct because the UI blames
   *  different things for each. */
  | { status: "error"; reason: "upstream" | "network" };

interface CacheEntry {
  outcome: { status: "ok"; builds: BuildResponse[] } | { status: "empty" };
  at: number;
}

export interface BuildCacheDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<BuildOutcome>>();

/** The cache key AND the query string are derived from the same three inputs
 *  here, so a key can never describe a different request than the one made. */
export function buildCacheKey(championId: number, roleId: number, rankBracketId: string): string {
  return `${championId}:${roleId}:${rankQueryParam(rankBracketId)}`;
}

export function buildRequestUrl(championId: number, roleId: number, rankBracketId: string): string {
  return `/api/build?champ=${championId}&role=${roleId}${rankQueryParam(rankBracketId)}`;
}

/** A cached outcome for this exact request, or null when there is none or it
 *  has aged out. Synchronous by design: the render path uses it to decide
 *  between "show this now" and "show a loading state", and a promise there
 *  would reintroduce the skeleton flash it exists to remove. */
export function peekBuild(
  championId: number,
  roleId: number,
  rankBracketId: string,
  deps: BuildCacheDeps = {}
): BuildOutcome | null {
  const key = buildCacheKey(championId, roleId, rankBracketId);
  const entry = cache.get(key);
  if (!entry) return null;
  const now = (deps.now ?? Date.now)();
  if (now - entry.at >= BUILD_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.outcome;
}

function remember(key: string, outcome: CacheEntry["outcome"], now: number): void {
  cache.delete(key); // re-insert so Map iteration order is genuinely LRU-by-write
  cache.set(key, { outcome, at: now });
  while (cache.size > BUILD_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Fetches (or reuses) the build for one champion+role+rank.
 *
 *  Three callers share this: BuildTabContent renders it, AutoExporter pushes it
 *  to the League client, and BuildPrewarmer warms it the moment champ select
 *  resolves a champion. Concurrent callers for the same key share ONE request —
 *  that dedupe is the reason a faster status poll cannot become more upstream
 *  traffic. */
export function loadBuild(
  championId: number,
  roleId: number,
  rankBracketId: string,
  deps: BuildCacheDeps = {}
): Promise<BuildOutcome> {
  const key = buildCacheKey(championId, roleId, rankBracketId);
  const nowFn = deps.now ?? Date.now;

  const cached = peekBuild(championId, roleId, rankBracketId, deps);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const f = deps.fetchImpl ?? fetch;
  const run = (async (): Promise<BuildOutcome> => {
    try {
      const res = await f(buildRequestUrl(championId, roleId, rankBracketId));
      if (res.status === 404) {
        remember(key, { status: "empty" }, nowFn());
        return { status: "empty" };
      }
      if (!res.ok) return { status: "error", reason: "upstream" };
      const data = (await res.json()) as BuildResponse[];
      if (!Array.isArray(data) || data.length === 0) {
        remember(key, { status: "empty" }, nowFn());
        return { status: "empty" };
      }
      const outcome = { status: "ok" as const, builds: data };
      remember(key, outcome, nowFn());
      return outcome;
    } catch {
      return { status: "error", reason: "network" };
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

/** Test-only reset — module-level state would otherwise leak between cases in
 *  the same vitest worker. */
export function clearBuildCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Test/diagnostic view of the cache's size. Never used to make a decision. */
export function buildCacheStats(): { entries: number; inFlight: number } {
  return { entries: cache.size, inFlight: inFlight.size };
}
