/**
 * Tests for prostageTimeline.ts's fetch/cache logic (`loadProstageTimeline`)
 * — no jsdom/RTL in this repo's harness, so the React hook itself
 * (`useProstageTimeline`) isn't exercised here, but the underlying
 * fetch/cache/dedup function it wraps only touches the global `fetch` (no
 * DOM), so it's directly testable by stubbing that global. Fresh module
 * instance per test (`vi.resetModules` + dynamic import) since `resultCache`
 * / `inFlight` are module-level singletons that would otherwise leak state
 * across tests/keys.
 *
 * 2026-07-11 P3 fix: the server route computes synchronously and never
 * returns `{status:"pending"}`, so the client's old retry-poll branch for it
 * was dead code and has been deleted (not kept as unreachable forward-compat
 * — see module header). These tests also cover the case where a
 * hypothetical "pending" (or any other unrecognized status) response comes
 * back anyway: it must now fall through to the plain `error` state rather
 * than being special-cased.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

describe("loadProstageTimeline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves 'ok' status to the ok state with the purchase order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: "ok", purchaseOrder: [{ itemId: 1055, ts: 90 }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    const result = await loadProstageTimeline("game-1", "player-1");

    expect(result).toEqual({ status: "ok", purchaseOrder: [{ itemId: 1055, ts: 90 }] });
  });

  it("resolves 'unavailable' status (with reason) to the unavailable state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "unavailable", reason: "no_timeline_data" }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    const result = await loadProstageTimeline("game-2", "player-1");

    expect(result).toEqual({ status: "unavailable", reason: "no_timeline_data" });
  });

  it("resolves a non-2xx response to the error state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false));
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    const result = await loadProstageTimeline("game-3", "player-1");

    expect(result).toEqual({ status: "error" });
  });

  it("resolves a network throw to the error state, never throws itself", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    await expect(loadProstageTimeline("game-4", "player-1")).resolves.toEqual({ status: "error" });
  });

  it("treats a 'pending' response (the removed branch's old shape) as an unrecognized body -> error, not a special pending state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    const result = await loadProstageTimeline("game-5", "player-1");

    expect(result).toEqual({ status: "error" });
    // Only one call — no retry-poll loop kicking in behind the scenes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a terminal 'ok' result — a second call for the same key does not refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: "ok", purchaseOrder: [{ itemId: 3020, ts: 600 }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    const first = await loadProstageTimeline("game-6", "player-1");
    const second = await loadProstageTimeline("game-6", "player-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("never caches an 'error' result — a later call re-hits the network", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false));
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    await loadProstageTimeline("game-7", "player-1");
    await loadProstageTimeline("game-7", "player-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent in-flight requests for the same key into one fetch", async () => {
    let resolveFetch!: (v: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { loadProstageTimeline } = await import("../prostageTimeline");
    const p1 = loadProstageTimeline("game-8", "player-1");
    const p2 = loadProstageTimeline("game-8", "player-1");

    resolveFetch(jsonResponse({ status: "ok", purchaseOrder: [] }));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });
});
