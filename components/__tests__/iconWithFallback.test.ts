import { describe, expect, it } from "vitest";
import { ICON_MAX_ATTEMPTS, shouldRetryIconLoad } from "../IconWithFallback";

describe("icon load retries", () => {
  it("retries a failing src before giving up on it", () => {
    expect(shouldRetryIconLoad(0)).toBe(true);
    expect(shouldRetryIconLoad(ICON_MAX_ATTEMPTS - 2)).toBe(true);
    expect(shouldRetryIconLoad(ICON_MAX_ATTEMPTS - 1)).toBe(false);
    expect(shouldRetryIconLoad(ICON_MAX_ATTEMPTS)).toBe(false);
  });

  it("caps total attempts at a small constant", () => {
    expect(ICON_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(ICON_MAX_ATTEMPTS).toBeLessThanOrEqual(4);
  });
});
