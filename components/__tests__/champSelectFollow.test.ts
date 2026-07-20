import { describe, it, expect } from "vitest";
import { resolveChampSelectFollow } from "../live/champSelectFollow";
import type { CompanionChampSelectSnapshot } from "../live/companionClient";

function snapshot(overrides: Partial<CompanionChampSelectSnapshot> = {}): CompanionChampSelectSnapshot {
  return {
    localPlayerCellId: 0,
    cellChampionId: null,
    pickIntent: null,
    actionChampionId: null,
    roleId: null,
    ...overrides,
  };
}

describe("resolveChampSelectFollow", () => {
  it("returns null when phase isn't ChampSelect", () => {
    expect(
      resolveChampSelectFollow({ phase: "InProgress", champSelect: snapshot({ cellChampionId: 103 }), currentChampionId: 64 })
    ).toBeNull();
  });

  it("returns null when champSelect is null", () => {
    expect(resolveChampSelectFollow({ phase: "ChampSelect", champSelect: null, currentChampionId: 64 })).toBeNull();
  });

  it("returns null when nothing has resolved yet (all fields null)", () => {
    expect(resolveChampSelectFollow({ phase: "ChampSelect", champSelect: snapshot(), currentChampionId: 64 })).toBeNull();
  });

  it("resolves via cellChampionId first (locked)", () => {
    const result = resolveChampSelectFollow({
      phase: "ChampSelect",
      champSelect: snapshot({ cellChampionId: 103, pickIntent: 7, roleId: 2 }),
      currentChampionId: 64,
    });
    expect(result).toEqual({ championId: 103, roleId: 2 });
  });

  it("falls back to pickIntent when cellChampionId is unresolved", () => {
    const result = resolveChampSelectFollow({
      phase: "ChampSelect",
      champSelect: snapshot({ pickIntent: 7, roleId: 0 }),
      currentChampionId: 64,
    });
    expect(result).toEqual({ championId: 7, roleId: 0 });
  });

  it("falls back to actionChampionId last", () => {
    const result = resolveChampSelectFollow({
      phase: "ChampSelect",
      champSelect: snapshot({ actionChampionId: 64, roleId: 1 }),
      currentChampionId: 103,
    });
    expect(result).toEqual({ championId: 64, roleId: 1 });
  });

  it("returns null when the resolved champion already matches what's shown (no change)", () => {
    expect(
      resolveChampSelectFollow({
        phase: "ChampSelect",
        champSelect: snapshot({ cellChampionId: 103 }),
        currentChampionId: 103,
      })
    ).toBeNull();
  });

  it("role-less (blank/unmapped assignedPosition) -> roleId undefined", () => {
    const result = resolveChampSelectFollow({
      phase: "ChampSelect",
      champSelect: snapshot({ cellChampionId: 103, roleId: null }),
      currentChampionId: 64,
    });
    expect(result).toEqual({ championId: 103, roleId: undefined });
  });

  it("an out-of-range roleId degrades to undefined rather than propagating garbage", () => {
    const result = resolveChampSelectFollow({
      phase: "ChampSelect",
      champSelect: snapshot({ cellChampionId: 103, roleId: 99 }),
      currentChampionId: 64,
    });
    expect(result).toEqual({ championId: 103, roleId: undefined });
  });
});
