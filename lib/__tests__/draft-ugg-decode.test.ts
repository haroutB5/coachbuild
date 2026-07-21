/**
 * Fixture-based decode tests for lib/draft/ugg.ts — zero network. Fixture
 * shape mirrors counterpick-research.md's empirical findings:
 * data[region][tier][uggRole] -> [ [rows], meta ], row = [oppId, rawWins, games, ...extra].
 *
 * P0 PERSPECTIVE FIX (2026-07-21): `rawWins` in a champion's OWN matchups
 * file is the OPPONENT's wins in that row, not the champion's own — see
 * decodeMatchupsJson's doc comment in lib/draft/ugg.ts for the full story
 * (user-caught, external + internal evidence). Every fixture below uses
 * deliberately ASYMMETRIC win/loss numbers (never a coincidental 50/50
 * split) specifically so these tests would FAIL if a future change
 * silently dropped the `games - rawWins` flip — a symmetric fixture would
 * pass either way and prove nothing.
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
  it("flips rawWins to the file-owner's own wins (P0 perspective fix)", () => {
    // Live-cited example: Aatrox(266) vs Mordekaiser(82), raw row 3173/6100
    // @ region 12/tier 10/role 4 (top). rawWins=3173 is MORDEKAISER's wins
    // in this pairing (the opponent) -- Aatrox's own wins is the
    // complement, 6100-3173=2927 (47.98%), not 3173 (52.02%, the stale/
    // wrong anchor counterpick-research.md originally cited).
    const fixture = buildFixture({
      4: [[82, 3173, 6100, 1, 2, 3]],
    });
    const result = decodeMatchupsJson(fixture);
    expect(result.skippedRows).toBe(0);
    expect(result.byRole[0]).toEqual([{ oppId: 82, wins: 2927, games: 6100 }]);
    const wr = result.byRole[0]![0].wins / result.byRole[0]![0].games;
    expect(wr).toBeCloseTo(0.4798, 3);
  });

  it("maps every u.gg role id to its app role per the locked table", () => {
    const fixture = buildFixture({
      4: [[1, 3, 10]], // top -> 0; rawWins=3 -> flipped wins=7
      1: [[2, 4, 10]], // jungle -> 1; flipped wins=6
      5: [[3, 6, 10]], // mid -> 2; flipped wins=4
      3: [[4, 2, 10]], // adc/bottom -> 3; flipped wins=8
      2: [[5, 9, 10]], // support -> 4; flipped wins=1
    });
    const result = decodeMatchupsJson(fixture);
    expect(UGG_ROLE_TO_APP_ROLE).toEqual({ 4: 0, 1: 1, 5: 2, 3: 3, 2: 4 });
    expect(result.byRole[0]).toEqual([{ oppId: 1, wins: 7, games: 10 }]);
    expect(result.byRole[1]).toEqual([{ oppId: 2, wins: 6, games: 10 }]);
    expect(result.byRole[2]).toEqual([{ oppId: 3, wins: 4, games: 10 }]);
    expect(result.byRole[3]).toEqual([{ oppId: 4, wins: 8, games: 10 }]);
    expect(result.byRole[4]).toEqual([{ oppId: 5, wins: 1, games: 10 }]);
  });

  it("drops (and counts) a row where rawWins > games", () => {
    const fixture = buildFixture({
      4: [
        [82, 100, 50], // rawWins > games -- invalid, drop
        [83, 30, 100], // valid; rawWins=30 -> flipped wins=70
      ],
    });
    const result = decodeMatchupsJson(fixture);
    expect(result.skippedRows).toBe(1);
    expect(result.byRole[0]).toEqual([{ oppId: 83, wins: 70, games: 100 }]);
  });

  it("drops (and counts) malformed rows: too short, wrong types, negative values", () => {
    const fixture = buildFixture({
      4: [
        [82, 10] as unknown[], // too short
        ["not-a-number", 10, 20] as unknown[], // wrong type
        [83, -5, 20] as unknown[], // negative rawWins
        [84, 5, -20] as unknown[], // negative games
        [85, 15, 20], // valid; rawWins=15 -> flipped wins=5
      ],
    });
    const result = decodeMatchupsJson(fixture);
    expect(result.skippedRows).toBe(4);
    expect(result.byRole[0]).toEqual([{ oppId: 85, wins: 5, games: 20 }]);
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
        [String(EMERALD_TIER)]: { 4: [[[82, 12, 20]], {}] }, // rawWins=12 -> flipped wins=8
        99: { 4: [[[999, 1, 2]], {}] }, // different tier -- must be ignored
      },
      55: { [String(EMERALD_TIER)]: { 4: [[[888, 1, 2]], {}] } }, // different region -- must be ignored
    };
    const result = decodeMatchupsJson(fixture);
    expect(result.byRole[0]).toEqual([{ oppId: 82, wins: 8, games: 20 }]);
  });
});

describe("decodeRankingsJson (deliberate no-op stub — see lib/draft/ugg.ts)", () => {
  it("always returns an empty byRole map regardless of input, and never throws", () => {
    expect(decodeRankingsJson(null)).toEqual({ byRole: {} });
    expect(decodeRankingsJson({ anything: "goes" })).toEqual({ byRole: {} });
    expect(decodeRankingsJson([1, 2, 3])).toEqual({ byRole: {} });
  });
});
