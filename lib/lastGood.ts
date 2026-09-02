// ─────────────────────────────────────────────────────────────────────────────
// lib/lastGood.ts — a durable "last known-good" store for the two things the
// Builds page cannot exist without: the resolved patch, and a champion-role's
// /api/build response.
//
// WHY (competitor backlog 9, 2026-09-02). A 403 or any error from the upstream
// coachless API emptied the Builds page: buildRecommendations rejected, the
// route answered 500, the client showed "Build data is unavailable right now".
// The CDN's own stale-while-revalidate (24h on /api/build) covered only URLs
// it happened to hold; a cold region, a new rank bracket or a champion nobody
// had opened that day got nothing. And patch resolution had the same shape one
// level down: with every probe failing on a cold instance, getLatestPatch fell
// all the way to STATIC_FALLBACK_PATCH (16.11), which coachless may answer with
// EMPTY rows rather than an error — a 404 "not played in this role", which
// looks like a data fact and is not.
//
// WHICH STORAGE, and why. Three were on the table:
//   Neon        durable, but it makes the one route with no database
//               dependency depend on the database, spends CU-hours on every
//               fresh build (the quota that already burned once, 2026-08), and
//               needs a migration against production.
//   CDN         `stale-if-error` is added to /api/build's own header as a
//               second layer, but it only helps URLs the edge already holds.
//   Runtime     `@vercel/functions` getCache(): a per-region key-value store
//   Cache       shared across function instances, so it SURVIVES A COLD
//               FUNCTION, which is the property the CDN and an in-memory map
//               both lack. No schema, no quota line, proven live on the
//               sibling matchday project since 2026-09-01. Ephemeral in
//               principle (entries can be evicted), which is fine for a
//               fallback whose absence means "the same empty page as before".
//
// Outside Vercel (local dev, vitest) getCache() hands back the SDK's own
// in-memory cache, so the code path is identical and simply forgets on
// restart. Tests inject `memoryLastGoodStore()` for isolation.
//
// EVERY method swallows. A fallback store that throws turns a degraded
// response into a failed one, which is the opposite of its job.
// ─────────────────────────────────────────────────────────────────────────────

export interface LastGoodStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** A week. Long enough to ride out any upstream incident this app has seen
 *  (the longest coachless gap on record is hours, not days); short enough
 *  that a copy from two patches ago cannot resurface as a "stale" build. */
export const LAST_GOOD_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 128-bit key hash for getCache(). The SDK's default is a 32-bit djb2, and a
 * collision there does not fail loudly: it serves one champion's cached build
 * under another champion's key. Four FNV-1a passes with distinct offset bases,
 * concatenated — no node:crypto, so this module stays importable from anything
 * lib/staticData.ts is imported from. Same construction as matchday's
 * lib/cache.ts, for the same reason.
 */
export function hashKey128(key: string): string {
  const bases = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let out = "";
  for (const base of bases) {
    let h = base >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

type RuntimeCacheLike = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options?: { ttl?: number }) => Promise<void>;
};

let runtimeCache: Promise<RuntimeCacheLike | null> | null = null;

/** Built ONCE. The SDK wrapper re-resolves the request context on every
 *  get/set, so a long-lived wrapper always talks to the current request's
 *  injected client; caching the wrapper is safe, caching a DECISION about
 *  whether the platform cache exists would not be (matchday, 2026-09-01). */
function getRuntimeCache(): Promise<RuntimeCacheLike | null> {
  if (!runtimeCache) {
    runtimeCache = import("@vercel/functions")
      .then((m) => m.getCache({ keyHashFunction: hashKey128, namespace: "cb-last-good" }) as RuntimeCacheLike)
      .catch(() => null);
  }
  return runtimeCache;
}

/**
 * Which backend a get/set from THIS request would hit. `getCache()` resolves
 * its client per request from `globalThis[Symbol.for("@vercel/request-context")]`
 * (the platform-injected RuntimeCache on a deployed Function) and otherwise
 * hands back a private per-instance in-memory map with one console.warn —
 * indistinguishable from success at every call site. matchday shipped a
 * release that concluded "not provisioned" from the wrong signal
 * (2026-09-01); this exists so /status can say which one is live, read
 * per-call and never memoized, because the context only exists inside a
 * request. The symbol is read directly because the SDK does not export
 * `getContext` from its package root.
 */
export type LastGoodBackend = "runtime-cache" | "in-memory";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

export function lastGoodBackend(): LastGoodBackend {
  try {
    const holder = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as
      | { get?: () => { cache?: unknown } | undefined }
      | undefined;
    if (holder?.get?.()?.cache) return "runtime-cache";
  } catch {
    // A malformed holder must never take the fallback layer down.
  }
  return "in-memory";
}

/** The production store. Never throws; a miss and a failure are both null. */
export function runtimeLastGoodStore(): LastGoodStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const cache = await getRuntimeCache();
        if (!cache) return null;
        const v = await cache.get(key);
        return v === undefined || v === null ? null : (v as T);
      } catch {
        return null;
      }
    },
    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      try {
        const cache = await getRuntimeCache();
        if (!cache) return;
        await cache.set(key, value, { ttl: ttlSeconds });
      } catch {
        // A write that fails leaves the previous copy (or nothing) in place.
      }
    },
  };
}

/** Test/dev store: a Map with TTL. `now` injectable. */
export function memoryLastGoodStore(now: () => number = Date.now): LastGoodStore & { size(): number } {
  const m = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const e = m.get(key);
      if (!e) return null;
      if (now() >= e.expiresAt) {
        m.delete(key);
        return null;
      }
      return e.value as T;
    },
    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      m.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    size: () => m.size,
  };
}
