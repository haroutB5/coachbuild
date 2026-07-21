import { describe, it, expect } from "vitest";
import { resolveChampSelectFollow, resolveCurrentChampSelectChampionId } from "../live/champSelectFollow";
import type { CompanionChampSelectSnapshot } from "../live/companionClient";

function snapshot(overrides: Partial<CompanionChampSelectSnapshot> = {}): CompanionChampSelectSnapshot {
  return {
    localPlayerCellId: 0,
    cellChampionId: null,
    pickIntent: null,
    actionChampionId: null,
    roleId: null,
    theirTeam: [],
    timerPhase: null,
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

// v0.35.0 — split out of resolveChampSelectFollow so app/page.tsx's poll
// tick can mirror "what does the client currently say" on EVERY tick,
// including when it matches what's already showing (resolveChampSelectFollow
// itself returns null in that case, by design, since it's a "should I
// change" decision, not a "what does it currently resolve to" one).
describe("resolveCurrentChampSelectChampionId", () => {
  it("null when champSelect is null", () => {
    expect(resolveCurrentChampSelectChampionId(null)).toBeNull();
  });

  it("null when nothing has resolved yet (all fields null)", () => {
    expect(resolveCurrentChampSelectChampionId(snapshot())).toBeNull();
  });

  it("resolves via cellChampionId first (locked)", () => {
    expect(resolveCurrentChampSelectChampionId(snapshot({ cellChampionId: 103, pickIntent: 7 }))).toBe(103);
  });

  it("falls back to pickIntent when cellChampionId is unresolved", () => {
    expect(resolveCurrentChampSelectChampionId(snapshot({ pickIntent: 7 }))).toBe(7);
  });

  it("falls back to actionChampionId last", () => {
    expect(resolveCurrentChampSelectChampionId(snapshot({ actionChampionId: 64 }))).toBe(64);
  });

  it("returns the resolved champion even when it's the SAME as what's already showing (unlike resolveChampSelectFollow)", () => {
    // This is the whole reason this helper is split out: a plain mirror,
    // not a "should something change" decision.
    expect(resolveCurrentChampSelectChampionId(snapshot({ cellChampionId: 103 }))).toBe(103);
  });
});
