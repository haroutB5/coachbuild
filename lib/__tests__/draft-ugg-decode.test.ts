/**
 * Fixture-based decode tests for lib/draft/ugg.ts — zero network. Fixture
 * shape mirrors counterpick-research.md's empirical findings:
 * data[region][tier][uggRole] -> [ [rows], meta ], row = [oppId, wins, games, ...extra].
 */
import { describe, it, expect } from "vitest";
import {
  decodeMatchupsJson,
  decodeRankingsJson,
  UGG_ROLE_TO_APP_ROLE,
  WORLD_REGION,
  EMERALD_TIER,
} from "@/lib/draft/ugg";

function buildFixture(rowsByUggRole: Record<number, unknown[][]>): unknown {
  const roleNode: Record<string, unknown> = {};
  for (const [role, rows] of Object.entries(rowsByUggRole)) {
    roleNode[role] = [rows, { totalGames: 12345 }];
  }
  return { [String(WORLD_REGION)]: { [String(EMERALD_TIER)]: roleNode } };
}

describe("decodeMatchupsJson", () => {
  it("decodes a well-formed row per u.gg role, mapped to the app role", () => {
    // role 4 (u.gg top) -> app role 0; live-cited example: Aatrox(266) vs
    // Mordekaiser(82) 3173/6100 = 52.02% @ region 12/tier 10/role 4.
    const fixture = buildFixture({
      4: [[82, 3173, 6100, 1, 2, 3]],
    });
    const result = decodeMatchupsJson(fixture);
    expect(result.skippedRows).toBe(0);
    expect(result.byRole[0]).toEqual([{ oppId: 82, wins: 3173, games: 6100 }]);
    const wr = result.byRole[0]![0].wins / result.byRole[0]![0].games;
    expect(wr).toBeCloseTo(0.5202, 3);
  });

  it("maps every u.gg role id to its app role per the locked table", () => {
    const fixture = buildFixture({
      4: [[1, 1, 2]], // top -> 0
      1: [[2, 1, 2]], // jungle -> 1
      5: [[3, 1, 2]], // mid -> 2
      3: [[4, 1, 2]], // adc/bottom -> 3
      2: [[5, 1, 2]], // support -> 4
    });
    const result = decodeMatchupsJson(fixture);
    expect(UGG_ROLE_TO_APP_ROLE).toEqual({ 4: 0, 1: 1, 5: 2, 3: 3, 2: 4 });
    expect(result.byRole[0]![0].oppId).toBe(1);
    expect(result.byRole[1]![0].oppId).toBe(2);
    expect(result.byRole[2]![0].oppId).toBe(3);
    expect(result.byRole[3]![0].oppId).toBe(4);
    expect(result.byRole[4]![0].oppId).toBe(5);
  });

  it("drops (and counts) a row where wins > games", () => {
    const fixture = buildFixture({
      4: [
        [82, 100, 50], // wins > games -- invalid, drop
        [83, 50, 100], // valid
      ],
    });
    const result = decodeMatchupsJson(fixture);
    expect(result.skippedRows).toBe(1);
    expect(result.byRole[0]).toEqual([{ oppId: 83, wins: 50, games: 100 }]);
  });

  it("drops (and counts) malformed rows: too short, wrong types, negative values", () => {
    const fixture = buildFixture({
      4: [
        [82, 10] as unknown[], // too short
        ["not-a-number", 10, 20] as unknown[], // wrong type
        [83, -5, 20] as unknown[], // negative wins
        [84, 5, -20] as unknown[], // negative games
        [85, 10, 20], // valid
      ],
    });
    const result = decodeMatchupsJson(fixture);
    expect(result.skippedRows).toBe(4);
    expect(result.byRole[0]).toEqual([{ oppId: 85, wins: 10, games: 20 }]);
  });

  it("missing region/tier/role node -> empty result, never throws", () => {
    expect(decodeMatchupsJson(null)).toEqual({ byRole: {}, skippedRows: 0 });
    expect(decodeMatchupsJson({})).toEqual({ byRole: {}, skippedRows: 0 });
    expect(decodeMatchupsJson({ [String(WORLD_REGION)]: {} })).toEqual({ byRole: {}, skippedRows: 0 });
    expect(decodeMatchupsJson({ [String(WORLD_REGION)]: { [String(EMERALD_TIER)]: {} } })).toEqual({
      byRole: {},
      skippedRows: 0,
    });
  });

  it("only reads WORLD_REGION/EMERALD_TIER, ignoring other regions/tiers present in the payload", () => {
    const fixture = {
      [String(WORLD_REGION)]: {
        [String(EMERALD_TIER)]: { 4: [[[82, 10, 20]], {}] },
        99: { 4: [[[999, 1, 2]], {}] }, // different tier -- must be ignored
      },
      55: { [String(EMERALD_TIER)]: { 4: [[[888, 1, 2]], {}] } }, // different region -- must be ignored
    };
    const result = decodeMatchupsJson(fixture);
    expect(result.byRole[0]).toEqual([{ oppId: 82, wins: 10, games: 20 }]);
  });
});

describe("decodeRankingsJson (deliberate no-op stub — see lib/draft/ugg.ts)", () => {
  it("always returns an empty byRole map regardless of input, and never throws", () => {
    expect(decodeRankingsJson(null)).toEqual({ byRole: {} });
    expect(decodeRankingsJson({ anything: "goes" })).toEqual({ byRole: {} });
    expect(decodeRankingsJson([1, 2, 3])).toEqual({ byRole: {} });
  });
});
