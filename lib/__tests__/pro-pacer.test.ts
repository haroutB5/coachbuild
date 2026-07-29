/**
 * Tests for lib/pro/pacer.ts's HOLD gate — the closed loop added 2026-07-29.
 *
 * The interesting assertions are about time, so fake timers are used
 * throughout: `vi.useFakeTimers()` also freezes `Date.now()`, which is the
 * clock the pacer computes its waits from, so advancing timers advances both
 * consistently. Nothing here sleeps for real and nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  __resetPacerForTests,
  holdPacer,
  MAX_HOLD_MS,
  MIN_INTERVAL_MS,
  effectiveReserve,
  observeRateLimitBuckets,
  pacedCall,
  pacerHoldRemainingMs,
  pacerPeakCallsPerWindow,
  RATE_LIMIT_RESERVE,
} from "@/lib/pro/pacer";

beforeEach(() => {
  vi.useFakeTimers();
  __resetPacerForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the reserve invariant (this number decides safety vs self-inflicted outage)", () => {
  it("RATE_LIMIT_RESERVE leaves this process's OWN peak below the trip threshold", () => {
    // Riot's live app bucket, 2026-07-29: `x-app-rate-limit: 100:120`.
    const limit = 100;
    const ourPeak = pacerPeakCallsPerWindow(120);
    expect(ourPeak).toBe(93);
    // Trip point. If our own peak reached it, the pacer would hold a full
    // window every window with nothing wrong and the sweep would never finish.
    expect(ourPeak).toBeLessThan(limit - RATE_LIMIT_RESERVE);
  });

  it("the 1s bucket cannot be tripped by this process alone either", () => {
    expect(pacerPeakCallsPerWindow(1)).toBe(1);
    expect(1).toBeLessThan(20 - RATE_LIMIT_RESERVE);
  });
});

describe("holdPacer", () => {
  it("is monotonic — a later, SHORTER backoff never shortens one already agreed", () => {
    holdPacer(60_000);
    expect(pacerHoldRemainingMs()).toBe(60_000);
    holdPacer(5_000);
    expect(pacerHoldRemainingMs()).toBe(60_000);
  });

  it("extends for a longer backoff", () => {
    holdPacer(5_000);
    holdPacer(60_000);
    expect(pacerHoldRemainingMs()).toBe(60_000);
  });

  it("clamps to MAX_HOLD_MS so a bad Retry-After cannot wedge the sweep", () => {
    holdPacer(99 * 60 * 60 * 1000);
    expect(pacerHoldRemainingMs()).toBe(MAX_HOLD_MS);
  });

  it("ignores zero, negative and non-finite values", () => {
    expect(holdPacer(0)).toBe(0);
    expect(holdPacer(-5000)).toBe(0);
    expect(holdPacer(Number.NaN)).toBe(0);
    expect(pacerHoldRemainingMs()).toBe(0);
  });

  it("decays with the clock", () => {
    holdPacer(10_000);
    vi.advanceTimersByTime(4_000);
    expect(pacerHoldRemainingMs()).toBe(6_000);
    vi.advanceTimersByTime(20_000);
    expect(pacerHoldRemainingMs()).toBe(0);
  });
});

describe("pacedCall honours a hold", () => {
  it("does not run a call until the hold expires, even though the interval is clear", async () => {
    holdPacer(30_000);
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = pacedCall(fn);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toBe("ok");
  });

  it("a hold EXTENDED while a call is already waiting is respected (the re-evaluation loop)", async () => {
    // The bug this pins: computing the wait once and handing it to a single
    // setTimeout would sail straight through a backoff agreed mid-wait.
    holdPacer(10_000);
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = pacedCall(fn);

    await vi.advanceTimersByTimeAsync(5_000);
    holdPacer(30_000); // now 30s from THIS moment
    await vi.advanceTimersByTimeAsync(6_000); // past the original 10s deadline
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(fn).toHaveBeenCalledTimes(1);
    await promise;
  });

  it("a hold set by ONE call delays every OTHER call queued behind it", async () => {
    const first = vi.fn(async () => {
      holdPacer(60_000);
      return "first";
    });
    const second = vi.fn().mockResolvedValue("second");

    const p1 = pacedCall(first);
    const p2 = pacedCall(second);

    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    await p1;

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS + 1_000);
    expect(second).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(second).toHaveBeenCalledTimes(1);
    await p2;
  });

  it("still enforces the plain interval when nothing is held", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await pacedCall(fn);
    const p2 = pacedCall(fn);

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 100);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(2);
    await p2;
  });
});

describe("observeRateLimitBuckets — the closed loop", () => {
  it("does nothing at the steady state this process produces on its own", () => {
    expect(observeRateLimitBuckets([{ count: 93, limit: 100, windowSec: 120 }])).toBeNull();
    expect(pacerHoldRemainingMs()).toBe(0);
  });

  it("holds for the FULL window once the reserve is crossed", () => {
    const over = observeRateLimitBuckets([{ count: 95, limit: 100, windowSec: 120 }]);
    expect(over?.windowSec).toBe(120);
    // A full window is the only delay we can PROVE clears the bucket: the
    // headers say how much is spent, never when the window started.
    expect(pacerHoldRemainingMs()).toBe(120_000);
  });

  it("holds on the longest over-reserve window when both buckets are hot", () => {
    observeRateLimitBuckets([
      { count: 19, limit: 20, windowSec: 1 },
      { count: 98, limit: 100, windowSec: 120 },
    ]);
    expect(pacerHoldRemainingMs()).toBe(120_000);
  });

  it("no buckets (headers absent) means no hold — degrades to the old behaviour, never to a stall", () => {
    expect(observeRateLimitBuckets([])).toBeNull();
    expect(pacerHoldRemainingMs()).toBe(0);
  });
});

describe("effectiveReserve — the guard against the pacer tripping on its OWN traffic", () => {
  it("keeps the full reserve for Riot's real app bucket", () => {
    expect(effectiveReserve({ count: 0, limit: 100, windowSec: 120 })).toBe(RATE_LIMIT_RESERVE);
  });

  it("keeps the full reserve for Riot's 1s bucket", () => {
    expect(effectiveReserve({ count: 0, limit: 20, windowSec: 1 })).toBe(RATE_LIMIT_RESERVE);
  });

  it("shrinks the reserve rather than self-trip on a bucket we could nearly saturate", () => {
    // 10s window, 1.3s floor -> our own peak is 8. limit 15 leaves headroom 6,
    // so the full reserve of 5 is still safe.
    expect(effectiveReserve({ count: 0, limit: 15, windowSec: 10 })).toBe(5);
    // limit 12 leaves headroom 3 — the reserve shrinks to fit.
    expect(effectiveReserve({ count: 0, limit: 12, windowSec: 10 })).toBe(3);
  });

  it("drops to 0 for a bucket this process can saturate unaided", () => {
    // Our own peak in 10s is 8. A limit of 8 or less means a flat reserve would
    // hold the queue permanently on our own traffic.
    expect(effectiveReserve({ count: 0, limit: 8, windowSec: 10 })).toBe(0);
    expect(effectiveReserve({ count: 0, limit: 4, windowSec: 10 })).toBe(0);
  });

  it("a saturable bucket still holds when genuinely AT its cap", () => {
    __resetPacerForTests();
    expect(observeRateLimitBuckets([{ count: 7, limit: 8, windowSec: 10 }])).toBeNull();
    expect(pacerHoldRemainingMs()).toBe(0);
    expect(observeRateLimitBuckets([{ count: 8, limit: 8, windowSec: 10 }])?.limit).toBe(8);
    expect(pacerHoldRemainingMs()).toBe(10_000);
  });

  it("a small method bucket does NOT hold the queue at a healthy count", () => {
    __resetPacerForTests();
    // The regression this guards: with a flat reserve of 5, count 4 against
    // limit 8 would already be "over" (threshold max(1, 3) = 3) and the pacer
    // would hold 10s on every single call.
    expect(observeRateLimitBuckets([{ count: 4, limit: 8, windowSec: 10 }])).toBeNull();
    expect(pacerHoldRemainingMs()).toBe(0);
  });

  it("the longest over-reserve window still wins after per-bucket reserves are applied", () => {
    __resetPacerForTests();
    observeRateLimitBuckets([
      { count: 8, limit: 8, windowSec: 10 },
      { count: 96, limit: 100, windowSec: 120 },
    ]);
    expect(pacerHoldRemainingMs()).toBe(120_000);
  });
});

describe("__resetPacerForTests", () => {
  it("clears the hold as well as the interval clock", () => {
    holdPacer(60_000);
    __resetPacerForTests();
    expect(pacerHoldRemainingMs()).toBe(0);
  });
});
