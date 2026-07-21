import { describe, it, expect } from "vitest";
import { SEASON_START_MS, SEASON_LABEL, isInSeason, seasonStartEpochSec, checkSeasonAnomaly } from "@/lib/mystats/season";

describe("SEASON_START_MS", () => {
  it("is 2026-01-08T00:00:00.000Z (Season 16/2026, patch 26.1/16.1)", () => {
    expect(new Date(SEASON_START_MS).toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("SEASON_LABEL is a human-readable season name", () => {
    expect(SEASON_LABEL).toBe("Season 2026");
  });

  it("seasonStartEpochSec is the epoch-seconds form (for Riot's startTime param)", () => {
    expect(seasonStartEpochSec()).toBe(Math.floor(SEASON_START_MS / 1000));
    expect(Number.isInteger(seasonStartEpochSec())).toBe(true);
  });
});

describe("isInSeason", () => {
  it("boundary match: EXACTLY the season start instant is IN season (inclusive)", () => {
    expect(isInSeason(SEASON_START_MS)).toBe(true);
  });

  it("boundary match: one millisecond BEFORE the season start is pre-season (excluded)", () => {
    expect(isInSeason(SEASON_START_MS - 1)).toBe(false);
  });

  it("boundary match: one millisecond AFTER the season start is in-season (included)", () => {
    expect(isInSeason(SEASON_START_MS + 1)).toBe(true);
  });

  it("a clearly pre-season timestamp (2025) is excluded", () => {
    expect(isInSeason(Date.UTC(2025, 11, 31))).toBe(false);
  });

  it("a clearly in-season timestamp (mid-2026) is included", () => {
    expect(isInSeason(Date.UTC(2026, 5, 15))).toBe(true);
  });
});

describe("checkSeasonAnomaly", () => {
  it("no disagreement: in-season timestamp + 16.x patch -> null", () => {
    expect(
      checkSeasonAnomaly({ matchId: "M1", gameCreation: "2026-02-01T00:00:00.000Z", patch: "16.3" })
    ).toBeNull();
  });

  it("no disagreement: pre-season timestamp + pre-season patch -> null", () => {
    expect(
      checkSeasonAnomaly({ matchId: "M2", gameCreation: "2025-12-01T00:00:00.000Z", patch: "15.24" })
    ).toBeNull();
  });

  it("flags: in-season timestamp but a non-16.x patch", () => {
    const reason = checkSeasonAnomaly({ matchId: "M3", gameCreation: "2026-03-01T00:00:00.000Z", patch: "15.24" });
    expect(reason).not.toBeNull();
    expect(reason).toContain("not 16.x");
  });

  it("flags: 16.x patch but a pre-season timestamp", () => {
    const reason = checkSeasonAnomaly({ matchId: "M4", gameCreation: "2025-12-01T00:00:00.000Z", patch: "16.1" });
    expect(reason).not.toBeNull();
    expect(reason).toContain("pre-season");
  });

  it("an empty/missing patch can't corroborate -> null, not an automatic disagreement", () => {
    expect(checkSeasonAnomaly({ matchId: "M5", gameCreation: "2026-02-01T00:00:00.000Z", patch: "" })).toBeNull();
  });

  it("an unparseable game_creation is reported, not silently swallowed", () => {
    const reason = checkSeasonAnomaly({ matchId: "M6", gameCreation: "not-a-date", patch: "16.1" });
    expect(reason).toContain("unparseable");
  });

  it("boundary: exactly SEASON_START_MS with a 16.x patch -> no disagreement", () => {
    expect(
      checkSeasonAnomaly({ matchId: "M7", gameCreation: new Date(SEASON_START_MS).toISOString(), patch: "16.1" })
    ).toBeNull();
  });
});
