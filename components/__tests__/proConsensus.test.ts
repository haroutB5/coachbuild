/**
 * Pure-logic tests for aggregateProConsensus (components/hextech/proConsensus.ts)
 * — the "what do pros actually build" frequency aggregation backing the new
 * PRO CONSENSUS card (v0.27.0). No JSX, no network — plain ProGame[] in,
 * ProConsensusModel out.
 */
import { describe, it, expect } from "vitest";
import { aggregateProConsensus } from "../hextech/proConsensus";
import type { ProGame, ProGameRunes } from "../proGames.types";

const NO_RUNES: ProGameRunes = {
  primaryTree: 0,
  keystone: 0,
  primary: [],
  secondaryTree: 0,
  secondary: [],
  shards: [],
};

function game(overrides: Partial<ProGame> = {}): ProGame {
  return {
    id: `g-${Math.random()}`,
    source: "soloq",
    player: { name: "Faker", team: "T1", role: 2, country: "KR" },
    account: { riotId: "Faker#KR1", region: "KR" },
    championId: 112,
    championName: "Viktor",
    role: 2,
    patch: "16.13",
    win: true,
    kills: 5,
    deaths: 2,
    assists: 5,
    gameCreation: new Date().toISOString(),
    gameDurationSec: 1800,
    spells: [4, 14],
    finalItems: [],
    trinket: null,
    purchaseOrder: [],
    skillOrder: [],
    runes: NO_RUNES,
    ...overrides,
  };
}

describe("aggregateProConsensus", () => {
  it("returns an empty model for N=0", () => {
    const model = aggregateProConsensus([]);
    expect(model.gamesTotal).toBe(0);
    expect(model.items).toEqual([]);
    expect(model.keystone).toBeNull();
    expect(model.secondaryTree).toBeNull();
    expect(model.spellPair).toBeNull();
    expect(model.tournaments).toEqual({ names: [], soloqCount: 0, prostageCount: 0 });
  });

  it("counts item pick rate against gamesTotal, excluding consumables", () => {
    const games = [
      game({ finalItems: [3152, 2003, 3020] }), // Rocketbelt, Health Potion, Sorc Shoes
      game({ finalItems: [3152, 3020] }),
      game({ finalItems: [4645] }),
    ];
    const model = aggregateProConsensus(games);
    expect(model.gamesTotal).toBe(3);
    const rocketbelt = model.items.find((i) => i.itemId === 3152);
    expect(rocketbelt).toEqual({ itemId: 3152, count: 2, share: 2 / 3 });
    // Health Potion (2003) is a consumable — must never appear in item counts.
    expect(model.items.find((i) => i.itemId === 2003)).toBeUndefined();
    const sorcShoes = model.items.find((i) => i.itemId === 3020);
    expect(sorcShoes?.count).toBe(2);
  });

  it("dedupes an item that appears twice in the same game's finalItems", () => {
    const games = [game({ finalItems: [3152, 3152, 3020] })];
    const model = aggregateProConsensus(games);
    const rocketbelt = model.items.find((i) => i.itemId === 3152);
    expect(rocketbelt?.count).toBe(1);
  });

  it("caps the item list at 6, sorted by count desc then itemId asc", () => {
    // 8 distinct items, each in exactly one game except item 1 (in all 5) —
    // exercises both the top-6 cap and the deterministic tie order.
    const games = [
      game({ finalItems: [1, 2, 3, 4, 5, 6, 7, 8] }),
      game({ finalItems: [1] }),
      game({ finalItems: [1] }),
      game({ finalItems: [1] }),
      game({ finalItems: [1] }),
    ];
    const model = aggregateProConsensus(games);
    expect(model.items).toHaveLength(6);
    expect(model.items[0]).toEqual({ itemId: 1, count: 5, share: 1 });
    // Remaining 7 items are tied at count=1 — itemId asc breaks the tie.
    expect(model.items.slice(1).map((i) => i.itemId)).toEqual([2, 3, 4, 5, 6]);
  });

  it("boots count like any other item (not excluded)", () => {
    const games = [game({ finalItems: [3020] }), game({ finalItems: [3020] })];
    const model = aggregateProConsensus(games);
    expect(model.items.find((i) => i.itemId === 3020)).toEqual({ itemId: 3020, count: 2, share: 1 });
  });

  it("computes keystone frequency against runesSampleSize, not gamesTotal", () => {
    const games = [
      game({ runes: { ...NO_RUNES, keystone: 8229 } }), // Arcane Comet
      game({ runes: { ...NO_RUNES, keystone: 8229 } }),
      game({ runes: { ...NO_RUNES, keystone: 8112 } }), // Electrocute
      game({ runes: NO_RUNES }), // no rune data (prostage row Leaguepedia never filled)
    ];
    const model = aggregateProConsensus(games);
    expect(model.gamesTotal).toBe(4);
    expect(model.runesSampleSize).toBe(3); // the keystone:0 row is excluded from the denominator
    expect(model.keystone).toEqual({ keystoneId: 8229, count: 2, share: 2 / 3 });
  });

  it("keystone is null when every game lacks rune data", () => {
    const games = [game({ runes: NO_RUNES }), game({ runes: NO_RUNES })];
    const model = aggregateProConsensus(games);
    expect(model.keystone).toBeNull();
    expect(model.runesSampleSize).toBe(0);
  });

  it("computes secondary tree frequency the same way, independent of keystone resolution", () => {
    const games = [
      game({ runes: { ...NO_RUNES, keystone: 8229, secondaryTree: 8100 } }),
      game({ runes: { ...NO_RUNES, keystone: 0, secondaryTree: 8100 } }), // keystone missing, tree still known
      game({ runes: { ...NO_RUNES, keystone: 0, secondaryTree: 0 } }), // fully missing
    ];
    const model = aggregateProConsensus(games);
    expect(model.secondaryTreeSampleSize).toBe(2);
    expect(model.secondaryTree).toEqual({ treeId: 8100, count: 2, share: 1 });
  });

  it("merges a spell pair regardless of D/F key order, excludes any pair with an unresolved slot", () => {
    const games = [
      game({ spells: [4, 14] }), // Flash, Ignite
      game({ spells: [14, 4] }), // Ignite, Flash — same combo, swapped keybind
      game({ spells: [4, 0] }), // unresolved second slot — excluded entirely
    ];
    const model = aggregateProConsensus(games);
    expect(model.spellSampleSize).toBe(2);
    expect(model.spellPair).toEqual({ spells: [4, 14], count: 2, share: 1 });
  });

  it("low-N (<3) still returns real fractions — the UI decides how to flag it", () => {
    const games = [game({ finalItems: [3152] })];
    const model = aggregateProConsensus(games);
    expect(model.gamesTotal).toBe(1);
    expect(model.items[0]).toEqual({ itemId: 3152, count: 1, share: 1 });
  });

  it("counts soloq/prostage source split and unique prostage tournaments, most-frequent first", () => {
    const games = [
      game({ source: "soloq" }),
      game({ source: "prostage", tournament: "LEC 2026 Summer" }),
      game({ source: "prostage", tournament: "LEC 2026 Summer" }),
      game({ source: "prostage", tournament: "LCK Summer 2026" }),
    ];
    const model = aggregateProConsensus(games);
    expect(model.tournaments.soloqCount).toBe(1);
    expect(model.tournaments.prostageCount).toBe(3);
    expect(model.tournaments.names).toEqual(["LEC 2026 Summer", "LCK Summer 2026"]);
  });

  it("never crashes on missing/undefined finalItems or spells arrays", () => {
    const malformed = { ...game(), finalItems: undefined, spells: undefined } as unknown as ProGame;
    expect(() => aggregateProConsensus([malformed])).not.toThrow();
  });
});
