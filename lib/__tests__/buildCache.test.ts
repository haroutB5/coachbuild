// lib/buildCache.ts — the shared /api/build owner. These tests pin the three
// properties the champ-select snappiness work depends on: one request per
// (champion, role, rank) even under concurrent callers, a cached answer served
// with no request at all, and a FAILURE never being cached (a network blip must
// not pin an error onto a champion for the rest of the session).
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadBuild,
  peekBuild,
  buildCacheKey,
  buildRequestUrl,
  clearBuildCache,
  buildCacheStats,
  BUILD_CACHE_TTL_MS,
  BUILD_CACHE_MAX_ENTRIES,
} from "../buildCache";
import type { BuildResponse } from "../types";
import { rankQueryParam } from "../rankBrackets";

const DIAMOND = "diamond-plus";

function buildFixture(patch = "16.15"): BuildResponse {
  // Only the fields this module actually touches are meaningful here; the rest
  // of the shape is the route's contract, exercised by its own tests.
  return { patch } as unknown as BuildResponse;
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

function recordingFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("buildCache — key and URL", () => {
  beforeEach(() => clearBuildCache());

  it("champion and role each key their own entry", () => {
    expect(buildCacheKey(106, 0, DIAMOND)).not.toBe(buildCacheKey(106, 2, DIAMOND));
    expect(buildCacheKey(106, 0, DIAMOND)).not.toBe(buildCacheKey(103, 0, DIAMOND));
  });

  // The key carries the RESOLVED rank fragment, not the raw id, so it can never
  // describe a different request than the one made. Two ids that resolve to the
  // same URL SHOULD share the entry (that is a cache hit, not a collision), and
  // the day a second builds bracket exists it separates them automatically.
  // Today RANK_BRACKETS has exactly one member, so an unknown id resolves to the
  // default — asserting a distinction here would be asserting a fiction.
  it("the rank leg of the key tracks the URL exactly", () => {
    expect(buildCacheKey(106, 0, DIAMOND).endsWith(rankQueryParam(DIAMOND))).toBe(true);
    expect(buildCacheKey(106, 0, "nonsense")).toBe(buildCacheKey(106, 0, DIAMOND));
    expect(buildRequestUrl(106, 0, "nonsense")).toBe(buildRequestUrl(106, 0, DIAMOND));
  });

  it("the URL carries the same three inputs the key is built from", () => {
    const url = buildRequestUrl(106, 0, DIAMOND);
    expect(url).toContain("champ=106");
    expect(url).toContain("role=0");
    expect(url).toContain("rank=");
  });
});

describe("buildCache — dedupe and caching", () => {
  beforeEach(() => clearBuildCache());

  it("two concurrent callers for the same build share ONE request", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(200, [buildFixture()]));
    const [a, b] = await Promise.all([
      loadBuild(106, 0, DIAMOND, { fetchImpl: impl }),
      loadBuild(106, 0, DIAMOND, { fetchImpl: impl }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.status).toBe("ok");
  });

  it("a repeat request for a champion already fetched costs no request at all", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(200, [buildFixture()]));
    await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    expect(calls).toHaveLength(1);
  });

  it("peekBuild answers synchronously once an entry exists, and null before", async () => {
    const { impl } = recordingFetch(() => jsonResponse(200, [buildFixture()]));
    expect(peekBuild(106, 0, DIAMOND)).toBeNull();
    await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    const hit = peekBuild(106, 0, DIAMOND);
    expect(hit?.status).toBe("ok");
  });

  it("a DIFFERENT champion is a different request, never a wrong-champion hit", async () => {
    const { impl, calls } = recordingFetch((url) =>
      jsonResponse(200, [buildFixture(url.includes("champ=106") ? "voli" : "ahri")])
    );
    const voli = await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    const ahri = await loadBuild(103, 2, DIAMOND, { fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(voli.status === "ok" && voli.builds[0].patch).toBe("voli");
    expect(ahri.status === "ok" && ahri.builds[0].patch).toBe("ahri");
  });

  it("the full build ARRAY is cached, not just the first entry (alt-keystone salvage reads past 0)", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(200, [buildFixture("a"), buildFixture("b"), buildFixture("c")])
    );
    const out = await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    expect(out.status === "ok" && out.builds).toHaveLength(3);
  });
});

describe("buildCache — honest failure handling", () => {
  beforeEach(() => clearBuildCache());

  it("404 is an ANSWER (empty) and is cached", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse(404, { error: "not played" }));
    const first = await loadBuild(112, 4, DIAMOND, { fetchImpl: impl });
    const second = await loadBuild(112, 4, DIAMOND, { fetchImpl: impl });
    expect(first).toEqual({ status: "empty" });
    expect(second).toEqual({ status: "empty" });
    expect(calls).toHaveLength(1);
  });

  it("a 2xx with an empty array is also empty, and cached", async () => {
    const { impl } = recordingFetch(() => jsonResponse(200, []));
    expect(await loadBuild(112, 4, DIAMOND, { fetchImpl: impl })).toEqual({ status: "empty" });
    expect(peekBuild(112, 4, DIAMOND)).toEqual({ status: "empty" });
  });

  it("a 500 is NOT cached — the next caller retries and can still succeed", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, [buildFixture()]);
    }) as unknown as typeof fetch;
    expect(await loadBuild(106, 0, DIAMOND, { fetchImpl: impl })).toEqual({
      status: "error",
      reason: "upstream",
    });
    expect(peekBuild(106, 0, DIAMOND)).toBeNull();
    expect((await loadBuild(106, 0, DIAMOND, { fetchImpl: impl })).status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("a thrown fetch is a NETWORK error, not cached, and never rejects", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await loadBuild(106, 0, DIAMOND, { fetchImpl: impl })).toEqual({
      status: "error",
      reason: "network",
    });
    expect(peekBuild(106, 0, DIAMOND)).toBeNull();
    expect(buildCacheStats().inFlight).toBe(0);
  });

  it("a response WITHOUT the offline header is an ordinary fresh outcome", async () => {
    const { impl } = recordingFetch(() => jsonResponse(200, [buildFixture()]));
    const out = await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    expect(out).toEqual({ status: "ok", builds: [buildFixture()] });
  });

  it("a response WITH the offline header is still served, but flagged servedOffline", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse(200, [buildFixture()], { "x-coachbuild-offline": "served-from-cache" })
    );
    const out = await loadBuild(106, 0, DIAMOND, { fetchImpl: impl });
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.servedOffline).toBe(true);
    // The flag rides the cached entry too, so a re-read keeps its label.
    const hit = peekBuild(106, 0, DIAMOND);
    expect(hit?.status === "ok" && hit.servedOffline).toBe(true);
  });
});

describe("buildCache — bounds", () => {
  beforeEach(() => clearBuildCache());

  it("an entry past its TTL is dropped rather than served stale", async () => {
    const { impl } = recordingFetch(() => jsonResponse(200, [buildFixture()]));
    let clock = 1_000_000;
    const now = () => clock;
    await loadBuild(106, 0, DIAMOND, { fetchImpl: impl, now });
    expect(peekBuild(106, 0, DIAMOND, { now })?.status).toBe("ok");
    clock += BUILD_CACHE_TTL_MS;
    expect(peekBuild(106, 0, DIAMOND, { now })).toBeNull();
  });

  it("the cache is bounded — it cannot grow without limit over a long session", async () => {
    const { impl } = recordingFetch(() => jsonResponse(200, [buildFixture()]));
    for (let i = 1; i <= BUILD_CACHE_MAX_ENTRIES + 10; i += 1) {
      await loadBuild(i, 0, DIAMOND, { fetchImpl: impl });
    }
    expect(buildCacheStats().entries).toBe(BUILD_CACHE_MAX_ENTRIES);
    // The most recent writes survive; the oldest were evicted.
    expect(peekBuild(BUILD_CACHE_MAX_ENTRIES + 10, 0, DIAMOND)?.status).toBe("ok");
    expect(peekBuild(1, 0, DIAMOND)).toBeNull();
  });
});
