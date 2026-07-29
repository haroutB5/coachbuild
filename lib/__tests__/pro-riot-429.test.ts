/**
 * Tests for lib/pro/riot.ts's 429 handling (2026-07-29).
 *
 * WHAT BROKE. The 12:20 solo-queue sweep took 15 x 429 in three bursts of five
 * consecutive failures. The pacer's 1.3s interval was working — the run's
 * measured rate was ~91 calls per 120s — but nothing read the response, so
 * after Riot said "you are over, wait N seconds" the very next call went out
 * 1.3s later into the same exhausted bucket. Rejected requests still count as
 * requests, and hammering an exhausted bucket is the documented path from a
 * transient 429 to a SUSPENDED key, which blanks every surface in the app.
 *
 * lib/fetchTimeout is mocked; no network, no timers slept for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.mock("@/lib/fetchTimeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  DEFAULT_FETCH_TIMEOUT_MS: 8000,
  FAST_FETCH_TIMEOUT_MS: 4000,
}));

import {
  DEFAULT_429_HOLD_SEC,
  getMatchIdsByPuuid,
  isRateLimited,
  MAX_RATE_LIMIT_RETRIES,
  readRateBuckets,
  RiotRequestError,
} from "@/lib/pro/riot";
import { __resetPacerForTests, pacerHoldRemainingMs } from "@/lib/pro/pacer";

/** Minimal stand-in for the parts of Response this module touches. */
function response(
  status: number,
  headers: Record<string, string> = {},
  body: unknown = []
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? "Too Many Requests" : "OK",
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

const OK_HEADERS = { "x-app-rate-limit": "100:120,20:1", "x-app-rate-limit-count": "40:120,1:1" };

beforeEach(() => {
  vi.useFakeTimers();
  __resetPacerForTests();
  mockFetch.mockReset();
  process.env.RIOT_API_KEY = "test-key";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Retry-After is honoured, and is authoritative", () => {
  it("holds for exactly the stated delay, then retries and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(response(429, { "retry-after": "5", "x-rate-limit-type": "application" }))
      .mockResolvedValueOnce(response(200, OK_HEADERS, ["EUW1_1"]));

    const promise = getMatchIdsByPuuid("europe", "puuid-1", { queue: 420 });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pacerHoldRemainingMs()).toBe(5_000);

    // The retry must NOT go out before the server said so. 1.3s is the old
    // interval — the exact moment the pre-fix code would have fired again.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toEqual(["EUW1_1"]);
  });

  it("falls back to a FULL app-limit window when Riot states no delay — never to a guess", async () => {
    mockFetch.mockResolvedValue(response(429, {}));
    const promise = getMatchIdsByPuuid("europe", "puuid-1").catch((e) => e);

    await vi.advanceTimersByTimeAsync(0);
    expect(pacerHoldRemainingMs()).toBe(DEFAULT_429_HOLD_SEC * 1000);
    expect(DEFAULT_429_HOLD_SEC).toBe(120); // one x-app-rate-limit window

    await vi.advanceTimersByTimeAsync(DEFAULT_429_HOLD_SEC * 1000 * (MAX_RATE_LIMIT_RETRIES + 2));
    const err = await promise;
    expect(err).toBeInstanceOf(RiotRequestError);
  });

  it("a Retry-After of 0 is clamped up, not treated as 'retry immediately'", async () => {
    mockFetch
      .mockResolvedValueOnce(response(429, { "retry-after": "0" }))
      .mockResolvedValueOnce(response(200, OK_HEADERS, []));
    const promise = getMatchIdsByPuuid("europe", "puuid-1");

    await vi.advanceTimersByTimeAsync(0);
    expect(pacerHoldRemainingMs()).toBe(1_000);

    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("retry budget", () => {
  it("gives up after MAX_RATE_LIMIT_RETRIES and surfaces the 429 with its metadata", async () => {
    mockFetch.mockResolvedValue(
      response(429, { "retry-after": "2", "x-rate-limit-type": "application" })
    );

    const promise = getMatchIdsByPuuid("europe", "puuid-1").catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await promise;

    expect(err).toBeInstanceOf(RiotRequestError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(2);
    expect(err.limitType).toBe("application");
    expect(isRateLimited(err)).toBe(true);
    // First attempt + MAX_RATE_LIMIT_RETRIES retries, and not one call more:
    // an unbounded retry on a saturated key is the failure mode this whole
    // change exists to prevent.
    expect(mockFetch).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
  });

  it("does NOT retry a non-429 — one attempt, no hold, error propagates unchanged", async () => {
    mockFetch.mockResolvedValue(response(404, {}));
    const promise = getMatchIdsByPuuid("europe", "puuid-1").catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await promise;

    expect(err).toBeInstanceOf(RiotRequestError);
    expect(err.status).toBe(404);
    expect(isRateLimited(err)).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pacerHoldRemainingMs()).toBe(0);
  });

  it("a non-429 failure still feeds its bucket counts to the closed loop", async () => {
    // A 404 spent a request too. Ignoring its headers would blind the loop for
    // exactly as long as a run of failures lasts.
    mockFetch.mockResolvedValue(
      response(404, { "x-app-rate-limit": "100:120", "x-app-rate-limit-count": "97:120" })
    );
    const promise = getMatchIdsByPuuid("europe", "puuid-1").catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(pacerHoldRemainingMs()).toBe(120_000);
  });

  it("a transport throw (timeout) is not a 429 and is not retried", async () => {
    mockFetch.mockRejectedValue(new DOMException("fetch timed out after 8000ms", "TimeoutError"));
    const promise = getMatchIdsByPuuid("europe", "puuid-1").catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("the closed loop on successful responses", () => {
  it("a near-cap count header holds the queue BEFORE the cap is reached", async () => {
    mockFetch.mockResolvedValue(
      response(200, { "x-app-rate-limit": "100:120,20:1", "x-app-rate-limit-count": "96:120,1:1" }, [])
    );
    const promise = getMatchIdsByPuuid("europe", "puuid-1");
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(pacerHoldRemainingMs()).toBe(120_000);
  });

  it("a healthy count header leaves the queue running at full speed", async () => {
    mockFetch.mockResolvedValue(response(200, OK_HEADERS, []));
    const promise = getMatchIdsByPuuid("europe", "puuid-1");
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(pacerHoldRemainingMs()).toBe(0);
  });

  it("a 429 does NOT let the count headers override Retry-After", async () => {
    // The 429 response reports the bucket at its cap. Deriving a hold from that
    // would apply a full 120s window and make the server's own 3s statement
    // dead code. Retry-After wins.
    mockFetch.mockResolvedValueOnce(
      response(429, {
        "retry-after": "3",
        "x-app-rate-limit": "100:120,20:1",
        "x-app-rate-limit-count": "100:120,1:1",
      })
    );
    mockFetch.mockResolvedValueOnce(response(200, OK_HEADERS, []));
    const promise = getMatchIdsByPuuid("europe", "puuid-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(pacerHoldRemainingMs()).toBe(3_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
  });
});

describe("readRateBuckets", () => {
  it("reads the method buckets as well as the app ones", () => {
    const buckets = readRateBuckets(
      new Headers({
        "x-app-rate-limit": "100:120",
        "x-app-rate-limit-count": "40:120",
        "x-method-rate-limit": "250:10",
        "x-method-rate-limit-count": "249:10",
      })
    );
    expect(buckets).toEqual([
      { count: 40, limit: 100, windowSec: 120 },
      { count: 249, limit: 250, windowSec: 10 },
    ]);
  });

  it("is empty when Riot sends no rate headers at all", () => {
    expect(readRateBuckets(new Headers())).toEqual([]);
  });
});
