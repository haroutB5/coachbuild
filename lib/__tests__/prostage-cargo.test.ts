/**
 * Tests for lib/prostage/cargo.ts — the both-spellings field helper and the
 * ratelimit-retry contract. fetch is mocked; the pacer's real 30s floor is
 * bypassed via fake timers so this stays fast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cargoField,
  cargoQuery,
  cargoQueryWithRetry,
  CargoRateLimitedError,
  CargoRequestError,
  __resetCargoPacerForTests,
} from "../prostage/cargo";

describe("cargoField", () => {
  it("reads the field verbatim when the JSON key matches exactly", () => {
    expect(cargoField({ Champion: "Ahri" }, "Champion")).toBe("Ahri");
  });

  it("reads an underscore-requested field back via its space-keyed twin", () => {
    expect(cargoField({ "DateTime UTC": "2026-06-01 18:00:00" }, "DateTime_UTC")).toBe(
      "2026-06-01 18:00:00"
    );
  });

  it("reads a space-requested field back via its underscore-keyed twin", () => {
    expect(cargoField({ Date_Start: "2026-06-01" }, "Date Start")).toBe("2026-06-01");
  });

  it("returns undefined when neither spelling is present", () => {
    expect(cargoField({ Foo: "bar" }, "DateTime_UTC")).toBeUndefined();
  });
});

describe("cargoQuery / cargoQueryWithRetry", () => {
  beforeEach(() => {
    __resetCargoPacerForTests();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, ok = true) {
    return { ok, status: ok ? 200 : 500, json: async () => body };
  }

  it("returns mapped cargoquery rows on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ cargoquery: [{ title: { Champion: "Ahri" } }] }) as never
    );
    const promise = cargoQuery({ tables: "ScoreboardPlayers", fields: "Champion" });
    await vi.runAllTimersAsync();
    const rows = await promise;
    expect(rows).toEqual([{ Champion: "Ahri" }]);
  });

  it("throws CargoRateLimitedError on a ratelimited API response (never returns [])", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: "ratelimited", info: "too many requests" } }) as never
    );
    const promise = cargoQuery({ tables: "ScoreboardPlayers", fields: "Champion" });
    // Attach the rejection handler BEFORE advancing fake timers — otherwise
    // the promise can reject during runAllTimersAsync() before `.rejects`
    // attaches, and Node flags it as a transiently-unhandled rejection even
    // though the test itself passes (a known vi.useFakeTimers + rejected-
    // promise-assertion ordering gotcha).
    const assertion = expect(promise).rejects.toBeInstanceOf(CargoRateLimitedError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("throws CargoRequestError on a non-ratelimit API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: "badquery", info: "bad field" } }) as never
    );
    const promise = cargoQuery({ tables: "ScoreboardPlayers", fields: "Champion" });
    const assertion = expect(promise).rejects.toBeInstanceOf(CargoRequestError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("throws CargoRequestError on a non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false) as never);
    const promise = cargoQuery({ tables: "ScoreboardPlayers", fields: "Champion" });
    const assertion = expect(promise).rejects.toBeInstanceOf(CargoRequestError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("cargoQueryWithRetry waits out a ratelimit and retries EXACTLY once", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "ratelimited", info: "too many requests" } }) as never
      )
      .mockResolvedValueOnce(
        jsonResponse({ cargoquery: [{ title: { Champion: "Ahri" } }] }) as never
      );
    const promise = cargoQueryWithRetry({ tables: "ScoreboardPlayers", fields: "Champion" });
    await vi.runAllTimersAsync();
    const rows = await promise;
    expect(rows).toEqual([{ Champion: "Ahri" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cargoQueryWithRetry propagates a SECOND ratelimit rather than looping again", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "ratelimited", info: "1" } }) as never
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "ratelimited", info: "2" } }) as never
      );
    const promise = cargoQueryWithRetry({ tables: "ScoreboardPlayers", fields: "Champion" });
    const assertion = expect(promise).rejects.toBeInstanceOf(CargoRateLimitedError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fastFail: propagates a ratelimit immediately, with NO cooldown wait and NO retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { code: "ratelimited", info: "too many requests" } }) as never
    );
    const promise = cargoQueryWithRetry(
      { tables: "ScoreboardPlayers", fields: "Champion" },
      { fastFail: true }
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(CargoRateLimitedError);
    // No vi.advanceTimersByTimeAsync/runAllTimersAsync at all here — if
    // fastFail silently fell through to the ~4.5min cooldown path, this
    // promise would never settle and the assertion below would hang/timeout
    // instead of resolving on microtasks alone.
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes back-to-back calls at least MIN_INTERVAL_MS apart", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ cargoquery: [{ title: { Champion: "Ahri" } }] }) as never
    );
    const p1 = cargoQuery({ tables: "ScoreboardPlayers", fields: "Champion" });
    const p2 = cargoQuery({ tables: "ScoreboardPlayers", fields: "Champion" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1); // second call hasn't fired yet — waiting on the pacer
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([p1, p2]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
