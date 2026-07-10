/**
 * Tests for lib/prostage/extract.ts — pure row extraction against mocked
 * DdragonMaps (no network). Covers name resolution, the numeric-id hedge,
 * rune tree-membership splitting, and skip/log behavior for unresolvable rows.
 */
import { describe, it, expect, vi } from "vitest";
import { extractProstageRow, tournamentDisplayFromOverviewPage } from "../prostage/extract";
import type { CargoScoreboardPlayerRow, DdragonMaps } from "../prostage/types";

function makeMaps(overrides: Partial<DdragonMaps> = {}): DdragonMaps {
  return {
    version: "16.13.1",
    championByName: new Map([
      ["ahri", 103],
      ["wukong", 62],
    ]),
    championNameById: new Map([
      [103, "Ahri"],
      [62, "Wukong"],
    ]),
    itemByName: new Map([
      ["riftmaker", 6653],
      ["bootsofspeed", 1001],
      ["controlward", 2055],
    ]),
    summonerByName: new Map([
      ["flash", 4],
      ["ignite", 14],
    ]),
    runeByName: new Map([
      ["electrocute", { id: 8112, parentStyleId: 8100 }],
      ["suddenimpact", { id: 8138, parentStyleId: 8100 }],
      ["cheapshot", { id: 8126, parentStyleId: 8100 }],
      ["absolutefocus", { id: 8112, parentStyleId: 8100 }],
      ["manaflowband", { id: 8226, parentStyleId: 8200 }],
      ["transcendence", { id: 8210, parentStyleId: 8200 }],
    ]),
    styleByName: new Map([
      ["domination", 8100],
      ["sorcery", 8200],
    ]),
    ...overrides,
  };
}

const BASE_ROW: CargoScoreboardPlayerRow = {
  Link: "Faker",
  Champion: "Ahri",
  Items: "Riftmaker, Boots of Speed",
  Trinket: "Control Ward",
  Runes: "Electrocute, Sudden Impact, Cheap Shot, Manaflow Band, Transcendence",
  KeystoneRune: "Electrocute",
  PrimaryTree: "Domination",
  SecondaryTree: "Sorcery",
  SummonerSpells: "Flash, Ignite",
  Kills: "5",
  Deaths: "2",
  Assists: "7",
  Team: "T1",
  Role: "Mid",
  GameId: "LEC_2026_Summer_1_1",
  OverviewPage: "LEC 2026 Summer",
  "DateTime UTC": "2026-06-01 18:00:00",
  PlayerWin: "1",
};

describe("extractProstageRow", () => {
  it("extracts a fully-populated row end to end", () => {
    const row = extractProstageRow(BASE_ROW, makeMaps());
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      gameId: "LEC_2026_Summer_1_1",
      playerLink: "Faker",
      overviewPage: "LEC 2026 Summer",
      tournamentDisplay: "LEC 2026 Summer",
      team: "T1",
      championId: 103,
      championName: "Ahri",
      role: 2,
      win: true,
      kills: 5,
      deaths: 2,
      assists: 7,
      gameDatetime: "2026-06-01T18:00:00.000Z",
      finalItems: [6653, 1001],
      trinket: 2055,
      spells: [4, 14],
    });
    expect(row!.runes.keystone).toBe(8112);
    expect(row!.runes.primaryTree).toBe(8100);
    expect(row!.runes.secondaryTree).toBe(8200);
    expect(row!.runes.primary.sort()).toEqual([8126, 8138].sort());
    expect(row!.runes.secondary.sort()).toEqual([8210, 8226].sort());
    expect(row!.runes.shards).toEqual([]);
  });

  it("accepts bare numeric ids in place of names (hedge against either Cargo convention)", () => {
    const row = extractProstageRow(
      { ...BASE_ROW, Champion: "103", Items: "6653,1001", Trinket: "2055", SummonerSpells: "4,14" },
      makeMaps()
    );
    expect(row).not.toBeNull();
    expect(row!.championId).toBe(103);
    expect(row!.finalItems).toEqual([6653, 1001]);
    expect(row!.trinket).toBe(2055);
    expect(row!.spells).toEqual([4, 14]);
  });

  it("reads DateTime_UTC through the space-keyed twin via cargoField", () => {
    const row = extractProstageRow(BASE_ROW, makeMaps());
    expect(row!.gameDatetime).toBe("2026-06-01T18:00:00.000Z");
  });

  it("skips a row missing an identity field (GameId/Link/OverviewPage)", () => {
    const log = vi.fn();
    expect(extractProstageRow({ ...BASE_ROW, GameId: undefined }, makeMaps(), log)).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it("skips a row with an unresolvable champion name", () => {
    const log = vi.fn();
    const row = extractProstageRow({ ...BASE_ROW, Champion: "TotallyUnknownChamp" }, makeMaps(), log);
    expect(row).toBeNull();
    expect(log.mock.calls.some(([msg]) => msg.includes("unresolved champion"))).toBe(true);
  });

  it("drops (not fails on) an unresolvable item, keeping the resolvable ones", () => {
    const log = vi.fn();
    const row = extractProstageRow(
      { ...BASE_ROW, Items: "Riftmaker, TotallyUnknownItem" },
      makeMaps(),
      log
    );
    expect(row).not.toBeNull();
    expect(row!.finalItems).toEqual([6653]);
    expect(log.mock.calls.some(([msg]) => msg.includes("unresolved item"))).toBe(true);
  });

  it("falls back to primaryTree/keystone with empty minors when Runes text is absent (per design)", () => {
    const row = extractProstageRow({ ...BASE_ROW, Runes: undefined }, makeMaps());
    expect(row).not.toBeNull();
    expect(row!.runes.keystone).toBe(8112);
    expect(row!.runes.primaryTree).toBe(8100);
    expect(row!.runes.secondaryTree).toBe(8200);
    expect(row!.runes.primary).toEqual([]);
    expect(row!.runes.secondary).toEqual([]);
  });

  it("leaves role null (not skipped) when Role is unrecognized", () => {
    const row = extractProstageRow({ ...BASE_ROW, Role: "Coach" }, makeMaps());
    expect(row).not.toBeNull();
    expect(row!.role).toBeNull();
  });

  it("returns null for an unparseable DateTime_UTC", () => {
    const row = extractProstageRow({ ...BASE_ROW, "DateTime UTC": "not-a-date" }, makeMaps());
    expect(row).toBeNull();
  });

  it("parses PlayerWin boolean conventions defensively", () => {
    expect(extractProstageRow({ ...BASE_ROW, PlayerWin: "0" }, makeMaps())!.win).toBe(false);
    expect(extractProstageRow({ ...BASE_ROW, PlayerWin: "" }, makeMaps())!.win).toBe(false);
    expect(extractProstageRow({ ...BASE_ROW, PlayerWin: "Yes" }, makeMaps())!.win).toBe(true);
  });

  describe("CargoExport transport shapes (live-verified 2026-07-10)", () => {
    // One real ScoreboardPlayers row via Special:CargoExport (LCK/2026
    // Season/Road to MSI) came back with Items and SummonerSpells as JSON
    // ARRAYS (not delimiter-joined strings like api.php) and Kills/Deaths/
    // Assists as JSON NUMBERS (not numeric strings). This is the regression
    // that crashed a live backfill with "raw.split is not a function" before
    // parseList()/parseCargoInt() were taught to accept both shapes.
    it("accepts array-typed Items/SummonerSpells/Runes (CargoExport shape) identically to delimited strings", () => {
      const row = extractProstageRow(
        {
          ...BASE_ROW,
          Items: ["Riftmaker", "Boots of Speed"],
          SummonerSpells: ["Flash", "Ignite"],
          Runes: ["Electrocute", "Sudden Impact", "Cheap Shot", "Manaflow Band", "Transcendence"],
        },
        makeMaps()
      );
      expect(row).not.toBeNull();
      expect(row!.finalItems).toEqual([6653, 1001]);
      expect(row!.spells).toEqual([4, 14]);
      expect(row!.runes.primary.sort()).toEqual([8126, 8138].sort());
      expect(row!.runes.secondary.sort()).toEqual([8210, 8226].sort());
    });

    it("accepts number-typed Kills/Deaths/Assists (CargoExport shape) identically to numeric strings", () => {
      const row = extractProstageRow({ ...BASE_ROW, Kills: 5, Deaths: 2, Assists: 7 }, makeMaps());
      expect(row).not.toBeNull();
      expect(row!.kills).toBe(5);
      expect(row!.deaths).toBe(2);
      expect(row!.assists).toBe(7);
    });

    it("does not split an array element on comma/semicolon (an array entry is already a whole token)", () => {
      // Regression guard: naively running an array through the OLD
      // string-only .split(/[,;]/) path would have been a silent-corruption
      // bug even after fixing the immediate crash, if a champion/item name
      // ever legitimately contained a comma or semicolon.
      const row = extractProstageRow(
        { ...BASE_ROW, Items: ["Riftmaker"], SummonerSpells: ["Flash", "Ignite"] },
        makeMaps()
      );
      expect(row!.finalItems).toEqual([6653]);
      expect(row!.spells).toEqual([4, 14]);
    });
  });
});

describe("tournamentDisplayFromOverviewPage", () => {
  it("passes through a flat page name unchanged", () => {
    expect(tournamentDisplayFromOverviewPage("MSI 2026")).toBe("MSI 2026");
  });

  it("joins a slash-hierarchical page, dropping a bare 'Season' segment", () => {
    expect(tournamentDisplayFromOverviewPage("LEC/2026/Summer/Season")).toBe("LEC 2026 Summer");
  });
});
