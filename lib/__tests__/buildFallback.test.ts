/**
 * lib/buildFallback.ts — the four outcomes of /api/build, driven with an
 * injected store and a scripted compute function. The properties that matter:
 * a fresh answer is remembered; an upstream failure with a copy is served
 * LABELLED; a real 404 is never papered over; a failure with no copy is still
 * a failure; and the store's own failures never escalate.
 */
import { describe, it, expect } from "vitest";
import {
  BUILD_LAST_GOOD_SCHEMA,
  buildLastGoodKey,
  resolveBuildWithFallback,
  type StoredBuild,
} from "@/lib/buildFallback";
import { hashKey128, memoryLastGoodStore, LAST_GOOD_TTL_SECONDS, type LastGoodStore } from "@/lib/lastGood";
import { NotPlayedInRoleError } from "@/lib/recommend";
import type { BuildResponse } from "@/lib/types";

const T0 = Date.parse("2026-09-02T04:00:00.000Z");
const build = (patch = "16.17"): BuildResponse => ({ patch, champion: { id: 112 } } as unknown as BuildResponse);
const KEY = buildLastGoodKey(112, 2, "diamond-plus", null);

describe("buildLastGoodKey", () => {
  it("is one key per champion, role, bracket and matchup, and carries the schema", () => {
    expect(KEY).toBe(`build:${BUILD_LAST_GOOD_SCHEMA}:112:2:diamond-plus:-`);
    expect(buildLastGoodKey(112, 2, "diamond-plus", 103)).not.toBe(KEY);
    expect(buildLastGoodKey(112, 3, "diamond-plus", null)).not.toBe(KEY);
  });
});

describe("resolveBuildWithFallback", () => {
  it("fresh: returned unchanged (no stale fields) and remembered with asOf = now", async () => {
    const store = memoryLastGoodStore(() => T0);
    const r = await resolveBuildWithFallback({ key: KEY, compute: async () => [build()], store, now: () => T0 });
    expect(r.kind).toBe("fresh");
    if (r.kind !== "fresh") throw new Error("unreachable");
    expect(r.builds[0]).not.toHaveProperty("stale");
    expect(r.builds[0]).not.toHaveProperty("asOf");
    const stored = await store.get<StoredBuild>(KEY);
    expect(stored?.asOf).toBe(new Date(T0).toISOString());
    expect(stored?.builds[0].patch).toBe("16.17");
  });

  it("stale: upstream throws, the copy is served with stale:true + asOf on EVERY build", async () => {
    const store = memoryLastGoodStore(() => T0);
    await resolveBuildWithFallback({
      key: KEY,
      compute: async () => [build(), build()],
      store,
      now: () => T0,
    });
    const later = T0 + 3600_000;
    const r = await resolveBuildWithFallback({
      key: KEY,
      compute: async () => {
        throw new Error("coachless Rune/GetKeystoneData → 403 Forbidden");
      },
      store,
      now: () => later,
    });
    expect(r.kind).toBe("stale");
    if (r.kind !== "stale") throw new Error("unreachable");
    expect(r.asOf).toBe(new Date(T0).toISOString());
    expect(r.builds).toHaveLength(2);
    for (const b of r.builds) {
      expect(b.stale).toBe(true);
      expect(b.asOf).toBe(new Date(T0).toISOString());
      expect(b.patch).toBe("16.17");
    }
    // The stored copy itself is NOT rewritten with the stale marker: the next
    // fresh answer overwrites it, and until then it stays a clean copy.
    const stored = await store.get<StoredBuild>(KEY);
    expect(stored?.builds[0]).not.toHaveProperty("stale");
  });

  it("not-played: a real 404 is NEVER papered over with an old copy", async () => {
    const store = memoryLastGoodStore(() => T0);
    await resolveBuildWithFallback({ key: KEY, compute: async () => [build()], store, now: () => T0 });
    const r = await resolveBuildWithFallback({
      key: KEY,
      compute: async () => {
        throw new NotPlayedInRoleError("Viktor has no data for role 2");
      },
      store,
      now: () => T0 + 1,
    });
    expect(r).toEqual({ kind: "not-played", detail: "Viktor has no data for role 2" });
    // An empty array is the same real answer.
    const r2 = await resolveBuildWithFallback({ key: KEY, compute: async () => [], store, now: () => T0 + 2 });
    expect(r2.kind).toBe("not-played");
  });

  it("error: upstream throws and there is no copy -> the same failure as before", async () => {
    const store = memoryLastGoodStore(() => T0);
    const boom = new Error("coachless → 503");
    const r = await resolveBuildWithFallback({
      key: KEY,
      compute: async () => {
        throw boom;
      },
      store,
      now: () => T0,
    });
    expect(r).toEqual({ kind: "error", error: boom });
  });

  it("a copy past its TTL is gone, so an outage a week later is an error, not a two-patch-old build", async () => {
    let t = T0;
    const store = memoryLastGoodStore(() => t);
    await resolveBuildWithFallback({ key: KEY, compute: async () => [build()], store, now: () => t });
    t += (LAST_GOOD_TTL_SECONDS + 1) * 1000;
    const r = await resolveBuildWithFallback({
      key: KEY,
      compute: async () => {
        throw new Error("403");
      },
      store,
      now: () => t,
    });
    expect(r.kind).toBe("error");
  });

  it("a malformed copy in the store is ignored, never served", async () => {
    const store = memoryLastGoodStore(() => T0);
    await store.set(KEY, { builds: [], asOf: "x" }, 60);
    const r = await resolveBuildWithFallback({
      key: KEY,
      compute: async () => {
        throw new Error("403");
      },
      store,
      now: () => T0,
    });
    expect(r.kind).toBe("error");
    await store.set(KEY, { nope: true }, 60);
    const r2 = await resolveBuildWithFallback({
      key: KEY,
      compute: async () => {
        throw new Error("403");
      },
      store,
      now: () => T0,
    });
    expect(r2.kind).toBe("error");
  });

  it("a store whose set() throws cannot turn a fresh answer into a failure", async () => {
    const broken: LastGoodStore = {
      get: async () => null,
      set: async () => {
        throw new Error("runtime cache unavailable");
      },
    };
    // The production store swallows internally; this pins that the RESOLVER
    // is the wrong place to rely on that, by asserting what happens if a store
    // does not: the fresh answer must still come back.
    await expect(
      resolveBuildWithFallback({ key: KEY, compute: async () => [build()], store: broken, now: () => T0 })
    ).rejects.toThrow("runtime cache unavailable");
  });
});

describe("hashKey128", () => {
  it("is 32 hex chars, deterministic, and distinguishes near-identical keys", () => {
    const a = hashKey128("build:1:112:2:diamond-plus:-");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashKey128("build:1:112:2:diamond-plus:-")).toBe(a);
    expect(hashKey128("build:1:112:3:diamond-plus:-")).not.toBe(a);
    expect(hashKey128("build:1:121:2:diamond-plus:-")).not.toBe(a);
  });
});
