import { describe, expect, it } from "vitest";
import {
  COMPANION_STATUS_STALE_AFTER_MS,
  isCompanionStatusFresh,
} from "../live/companionLiveness";

describe("companion status freshness", () => {
  it("accepts a recent successful /status poll", () => {
    expect(isCompanionStatusFresh(10_000, 10_000 + COMPANION_STATUS_STALE_AFTER_MS - 1)).toBe(true);
  });

  it("flips stale at three missed poll intervals", () => {
    expect(isCompanionStatusFresh(10_000, 10_000 + COMPANION_STATUS_STALE_AFTER_MS)).toBe(false);
  });

  it("re-arms after a new successful poll", () => {
    const staleAt = 10_000 + COMPANION_STATUS_STALE_AFTER_MS;
    expect(isCompanionStatusFresh(10_000, staleAt)).toBe(false);
    expect(isCompanionStatusFresh(staleAt, staleAt)).toBe(true);
  });

  it("fails closed without a valid successful-poll timestamp", () => {
    expect(isCompanionStatusFresh(null, 10_000)).toBe(false);
    expect(isCompanionStatusFresh(Number.NaN, 10_000)).toBe(false);
  });
});
