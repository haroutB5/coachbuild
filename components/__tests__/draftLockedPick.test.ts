import { describe, it, expect } from "vitest";
import {
  resolveLockedPickChampionId,
  shouldShowLockedPickBanner,
  type DraftLockedPickBannerInput,
} from "../live/draftLockedPick";

function input(overrides: Partial<DraftLockedPickBannerInput> = {}): DraftLockedPickBannerInput {
  return {
    phase: "ChampSelect",
    session: "session-token",
    cellChampionId: 112,
    dismissedChampionId: null,
    ...overrides,
  };
}

describe("resolveLockedPickChampionId", () => {
  it("requires a companion session and ChampSelect phase", () => {
    expect(resolveLockedPickChampionId(input({ session: null }))).toBeNull();
    expect(resolveLockedPickChampionId(input({ phase: "InProgress" }))).toBeNull();
    expect(resolveLockedPickChampionId(input({ phase: null }))).toBeNull();
  });

  it("requires a positive locked cell champion id", () => {
    expect(resolveLockedPickChampionId(input({ cellChampionId: null }))).toBeNull();
    expect(resolveLockedPickChampionId(input({ cellChampionId: 0 }))).toBeNull();
    expect(resolveLockedPickChampionId(input({ cellChampionId: -1 }))).toBeNull();
  });

  it("uses cellChampionId only, never a hover fallback", () => {
    expect(resolveLockedPickChampionId(input({ cellChampionId: null }))).toBeNull();
    expect(resolveLockedPickChampionId(input({ cellChampionId: 64 }))).toBe(64);
  });
});

describe("shouldShowLockedPickBanner", () => {
  it("shows for an undismissed lock", () => {
    expect(shouldShowLockedPickBanner(input())).toBe(true);
  });

  it("stays hidden when the current champion was dismissed", () => {
    expect(shouldShowLockedPickBanner(input({ dismissedChampionId: 112 }))).toBe(false);
  });

  it("shows again for a different locked champion", () => {
    expect(shouldShowLockedPickBanner(input({ cellChampionId: 64, dismissedChampionId: 112 }))).toBe(true);
  });

  it("never renders without the live session even if a champion is locked", () => {
    expect(shouldShowLockedPickBanner(input({ session: undefined }))).toBe(false);
  });
});
