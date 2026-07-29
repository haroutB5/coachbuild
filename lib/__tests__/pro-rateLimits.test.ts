/**
 * Tests for lib/pro/rateLimits.ts — the pure half of the 2026-07-29 Riot 429
 * fix. Every assertion here is about reading what Riot ACTUALLY said; the
 * behaviour built on top of it lives in pro-pacer.test.ts / pro-riot-429.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  bucketOverReserve,
  MAX_RETRY_AFTER_SEC,
  MIN_RETRY_AFTER_SEC,
  parseRateBuckets,
  parseRetryAfterSec,
  peakCallsPerWindow,
} from "@/lib/pro/rateLimits";

describe("parseRateBuckets", () => {
  it("parses the live header shape observed on 2026-07-29", () => {
    expect(parseRateBuckets("100:120,20:1", "93:120,1:1")).toEqual([
      { count: 93, limit: 100, windowSec: 120 },
      { count: 1, limit: 20, windowSec: 1 },
    ]);
  });

  it("joins on WINDOW LENGTH, not position — a reordered count header still lines up", () => {
    // Same data, pairs swapped in the count header only. A positional zip would
    // report the 1s count (1) against the 120s limit (100) and conclude there
    // are 99 requests of headroom at the exact moment there are 7.
    const buckets = parseRateBuckets("100:120,20:1", "1:1,93:120");
    const twoMinute = buckets.find((b) => b.windowSec === 120);
    expect(twoMinute).toEqual({ count: 93, limit: 100, windowSec: 120 });
  });

  it("drops a bucket whose other half is missing rather than inventing the value", () => {
    expect(parseRateBuckets("100:120,20:1", "93:120")).toEqual([
      { count: 93, limit: 100, windowSec: 120 },
    ]);
    expect(parseRateBuckets("100:120", "1:1")).toEqual([]);
  });

  it("returns [] for absent or malformed headers instead of throwing", () => {
    expect(parseRateBuckets(null, null)).toEqual([]);
    expect(parseRateBuckets(undefined, undefined)).toEqual([]);
    expect(parseRateBuckets("", "")).toEqual([]);
    expect(parseRateBuckets("garbage", "also:garbage")).toEqual([]);
    expect(parseRateBuckets("100:0", "5:0")).toEqual([]); // zero-length window
  });

  it("tolerates whitespace around the pairs", () => {
    expect(parseRateBuckets(" 100:120 , 20:1 ", " 93:120 , 1:1 ")).toHaveLength(2);
  });
});

describe("parseRetryAfterSec", () => {
  it("reads Riot's integer-seconds form", () => {
    expect(parseRetryAfterSec("5")).toBe(5);
    expect(parseRetryAfterSec("  12  ")).toBe(12);
  });

  it("returns null when the header is absent — 'the server did not say', never zero", () => {
    expect(parseRetryAfterSec(null)).toBeNull();
    expect(parseRetryAfterSec(undefined)).toBeNull();
    expect(parseRetryAfterSec("")).toBeNull();
    expect(parseRetryAfterSec("soon")).toBeNull();
    expect(parseRetryAfterSec("-3")).toBeNull();
  });

  it("clamps 0 up to the minimum — 'retry instantly' is the behaviour that caused this bug", () => {
    expect(parseRetryAfterSec("0")).toBe(MIN_RETRY_AFTER_SEC);
  });

  it("clamps an absurd delay so a bad header cannot wedge the sweep", () => {
    expect(parseRetryAfterSec("99999")).toBe(MAX_RETRY_AFTER_SEC);
  });

  it("resolves the HTTP-date form against now, and rounds UP", () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    expect(parseRetryAfterSec("Wed, 29 Jul 2026 12:00:30 GMT", now)).toBe(30);
    // 4.2s -> 5s: never round a backoff down.
    expect(parseRetryAfterSec("Wed, 29 Jul 2026 12:00:04 GMT", now + 800)).toBe(4);
    expect(parseRetryAfterSec("Wed, 29 Jul 2026 12:00:05 GMT", now + 800)).toBe(5);
  });

  it("a past HTTP-date still yields the minimum, not zero", () => {
    const now = Date.parse("2026-07-29T12:00:00.000Z");
    expect(parseRetryAfterSec("Wed, 29 Jul 2026 11:59:00 GMT", now)).toBe(MIN_RETRY_AFTER_SEC);
  });
});

describe("peakCallsPerWindow", () => {
  it("gives 93 for the 1.3s floor against Riot's 120s bucket", () => {
    expect(peakCallsPerWindow(1300, 120)).toBe(93);
  });

  it("gives 1 for the 1.3s floor against Riot's 1s bucket", () => {
    expect(peakCallsPerWindow(1300, 1)).toBe(1);
  });
});

describe("bucketOverReserve", () => {
  const app = (count: number) => ({ count, limit: 100, windowSec: 120 });

  it("is null while headroom remains", () => {
    expect(bucketOverReserve([app(93)], 5)).toBeNull();
    expect(bucketOverReserve([app(94)], 5)).toBeNull();
  });

  it("trips exactly at limit - reserve", () => {
    expect(bucketOverReserve([app(95)], 5)).toEqual(app(95));
    expect(bucketOverReserve([app(100)], 5)).toEqual(app(100));
  });

  it("returns the LONGEST window when several are over — the one that takes longest to clear", () => {
    const over = bucketOverReserve(
      [
        { count: 18, limit: 20, windowSec: 1 },
        { count: 99, limit: 100, windowSec: 120 },
      ],
      5
    );
    expect(over?.windowSec).toBe(120);
  });

  it("keeps a small bucket meaningful: a reserve larger than the limit floors at 1", () => {
    // limit 3, reserve 5 -> threshold max(1, -2) = 1. Without the floor the
    // threshold would be negative and a 0-count bucket would trip forever.
    expect(bucketOverReserve([{ count: 0, limit: 3, windowSec: 1 }], 5)).toBeNull();
    expect(bucketOverReserve([{ count: 1, limit: 3, windowSec: 1 }], 5)).toEqual({
      count: 1,
      limit: 3,
      windowSec: 1,
    });
  });

  it("is null for no buckets at all (headers absent) — degrades to the old open-loop behaviour", () => {
    expect(bucketOverReserve([], 5)).toBeNull();
  });
});
