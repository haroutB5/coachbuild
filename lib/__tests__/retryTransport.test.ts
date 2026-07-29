/**
 * Tests for lib/retryTransport.ts — the shared bounded retry-with-backoff
 * used by scripts/ingest-draft.mjs (u.gg curl timeouts) and
 * scripts/ingest-prostage.mjs (Leaguepedia CargoExport Cloudflare blips).
 * Fake timers so the real delays never make this suite slow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retryWithBackoff, withRetryTransport } from "../retryTransport";

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success with no retries", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockResolvedValueOnce("recovered");
    const promise = retryWithBackoff(fn, { delaysMs: [5_000, 15_000] });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waits the exact configured delay before each retry", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockResolvedValueOnce("recovered");
    const promise = retryWithBackoff(fn, { delaysMs: [5_000, 15_000] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1); // first attempt made, retry not yet due
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fn).toHaveBeenCalledTimes(1); // retry still not due
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve(); // let the retried call's microtask run
    expect(fn).toHaveBeenCalledTimes(2);
    await promise;
  });

  it("throws the LAST error once every attempt is exhausted (never swallows into a fallback)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("final"));
    const promise = retryWithBackoff(fn, { delaysMs: [1_000, 2_000] });
    const assertion = expect(promise).rejects.toThrow("final");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, then stop
  });

  it("is bounded — never retries past delaysMs.length (not a tight loop)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    const promise = retryWithBackoff(fn, { delaysMs: [1_000] });
    const assertion = expect(promise).rejects.toThrow("always fails");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + exactly 1 retry
  });

  it("shouldRetry:false propagates immediately, consuming no retry budget", async () => {
    class NotRetryable extends Error {}
    const fn = vi.fn().mockRejectedValue(new NotRetryable("nope"));
    const promise = retryWithBackoff(fn, {
      delaysMs: [1_000, 2_000],
      shouldRetry: (err) => !(err instanceof NotRetryable),
    });
    await expect(promise).rejects.toBeInstanceOf(NotRetryable);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("shouldRetry lets a matched error class retry while an unmatched one still fails fast", async () => {
    class RetryableError extends Error {}
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("transient"))
      .mockResolvedValueOnce("ok");
    const promise = retryWithBackoff(fn, {
      delaysMs: [1_000],
      shouldRetry: (err) => err instanceof RetryableError,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("calls onRetry with the 1-indexed attempt number, the error, and the delay used", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    const promise = retryWithBackoff(fn, { delaysMs: [7_000], onRetry });
    await vi.runAllTimersAsync();
    await promise;
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, err, delayMs] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect((err as Error).message).toBe("boom");
    expect(delayMs).toBe(7_000);
  });
});

describe("withRetryTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps a (url) => Promise<string> transport and passes the url through on every attempt", async () => {
    const raw = vi
      .fn()
      .mockRejectedValueOnce(new Error("curl transport failed (exit 28): timed out"))
      .mockResolvedValueOnce("payload body");
    const wrapped = withRetryTransport(raw, { delaysMs: [5_000] });
    const promise = wrapped("https://stats2.u.gg/lol/1.5/matchups/16_13/ranked_solo_5x5/142/1.5.0.json");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("payload body");
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw).toHaveBeenNthCalledWith(1, "https://stats2.u.gg/lol/1.5/matchups/16_13/ranked_solo_5x5/142/1.5.0.json");
    expect(raw).toHaveBeenNthCalledWith(2, "https://stats2.u.gg/lol/1.5/matchups/16_13/ranked_solo_5x5/142/1.5.0.json");
  });
});
