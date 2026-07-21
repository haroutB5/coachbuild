import { describe, it, expect } from "vitest";
import {
  resolveDraftLiveTarget,
  shouldShowResetToLive,
  normalizeDraftEnemyIds,
  MAX_DRAFT_ENEMIES,
} from "../live/draftLiveSync";
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

describe("normalizeDraftEnemyIds", () => {
  it("passes through a clean list unchanged", () => {
    expect(normalizeDraftEnemyIds([103, 64, 51])).toEqual([103, 64, 51]);
  });

  it("drops non-positive entries", () => {
    expect(normalizeDraftEnemyIds([103, 0, -5, 64])).toEqual([103, 64]);
  });

  it("dedupes, keeping first occurrence order", () => {
    expect(normalizeDraftEnemyIds([103, 64, 103, 51])).toEqual([103, 64, 51]);
  });

  it(`caps at MAX_DRAFT_ENEMIES (${MAX_DRAFT_ENEMIES})`, () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    const result = normalizeDraftEnemyIds(ids);
    expect(result).toHaveLength(MAX_DRAFT_ENEMIES);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("empty input -> empty output", () => {
    expect(normalizeDraftEnemyIds([])).toEqual([]);
  });
});

describe("resolveDraftLiveTarget", () => {
  it("returns null when dirty (manual edits win, regardless of phase)", () => {
    expect(
      resolveDraftLiveTarget({ phase: "ChampSelect", champSelect: snapshot({ cellChampionId: 103 }), dirty: true })
    ).toBeNull();
  });

  it("returns null when phase isn't ChampSelect", () => {
    expect(resolveDraftLiveTarget({ phase: "InProgress", champSelect: snapshot(), dirty: false })).toBeNull();
  });

  it("returns null when phase is null (no companion / no session)", () => {
    expect(resolveDraftLiveTarget({ phase: null, champSelect: null, dirty: false })).toBeNull();
  });

  it("returns null when champSelect is null even in ChampSelect phase", () => {
    expect(resolveDraftLiveTarget({ phase: "ChampSelect", champSelect: null, dirty: false })).toBeNull();
  });

  it("resolves lane from roleId, enemies from theirTeam, hover from own-champ resolution", () => {
    const target = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ roleId: 2, cellChampionId: 112, theirTeam: [103, 64, 51, 222, 412] }),
      dirty: false,
    });
    expect(target).not.toBeNull();
    expect(target!.lane).toBe("mid");
    expect(target!.enemies).toEqual([103, 64, 51, 222, 412]);
    expect(target!.hover).toBe(112);
  });

  it("role-less (blank/unmapped assignedPosition) -> lane undefined, doesn't touch the caller's current lane", () => {
    const target = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ roleId: null, theirTeam: [103] }),
      dirty: false,
    });
    expect(target).not.toBeNull();
    expect(target!.lane).toBeUndefined();
  });

  it("an out-of-range roleId degrades to lane undefined rather than propagating garbage", () => {
    const target = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ roleId: 99 as unknown as number, theirTeam: [103] }),
      dirty: false,
    });
    expect(target!.lane).toBeUndefined();
  });

  it("hover falls back through pickIntent then actionChampionId (mirrors resolveCurrentChampSelectChampionId)", () => {
    const viaIntent = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ pickIntent: 7 }),
      dirty: false,
    });
    expect(viaIntent!.hover).toBe(7);

    const viaAction = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ actionChampionId: 64 }),
      dirty: false,
    });
    expect(viaAction!.hover).toBe(64);
  });

  it("hover is null when nothing has resolved yet", () => {
    const target = resolveDraftLiveTarget({ phase: "ChampSelect", champSelect: snapshot(), dirty: false });
    expect(target!.hover).toBeNull();
  });

  it("theirTeam is deduped/capped the same way normalizeDraftEnemyIds does", () => {
    const target = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ theirTeam: [1, 1, 2, 3, 4, 5, 6] }),
      dirty: false,
    });
    expect(target!.enemies).toEqual([1, 2, 3, 4, 5]);
  });

  it("audit P2-1: DraftLiveTarget never carries an index-based lane-opponent guess (removed entirely)", () => {
    const target = resolveDraftLiveTarget({
      phase: "ChampSelect",
      champSelect: snapshot({ roleId: 3, theirTeam: [10, 20, 30, 40, 50] }),
      dirty: false,
    });
    expect(target).not.toHaveProperty("laneOpponentIndex");
  });
});

describe("shouldShowResetToLive", () => {
  it("false when not dirty", () => {
    expect(shouldShowResetToLive(false, "ChampSelect", snapshot())).toBe(false);
  });

  it("false when dirty but not in ChampSelect (nothing live to reset to)", () => {
    expect(shouldShowResetToLive(true, "InProgress", snapshot())).toBe(false);
  });

  it("false when dirty and ChampSelect but champSelect snapshot is null", () => {
    expect(shouldShowResetToLive(true, "ChampSelect", null)).toBe(false);
  });

  it("true when dirty, in ChampSelect, and a snapshot exists", () => {
    expect(shouldShowResetToLive(true, "ChampSelect", snapshot())).toBe(true);
  });
});
