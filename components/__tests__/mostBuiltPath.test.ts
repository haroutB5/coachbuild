import { describe, expect, it } from "vitest";
import type { ProGame, ProGameRunes } from "../proGames.types";
import type { ItemDetail } from "../itemDetail";
import { aggregateProConsensus } from "../hextech/proConsensus";
import { mostBuiltPath } from "../hextech/mostBuiltPath";

const NO_RUNES: ProGameRunes = {
  primaryTree: 0,
  keystone: 0,
  primary: [],
  secondaryTree: 0,
  secondary: [],
  shards: [],
};

let gameNumber = 0;

function game(overrides: Partial<ProGame> = {}): ProGame {
  gameNumber += 1;
  return {
    id: `path-${gameNumber}`,
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

function pathGame(finalItems: number[], purchaseItems = finalItems): ProGame {
  return game({
    finalItems,
    purchaseOrder: purchaseItems.map((itemId, index) => ({ itemId, ts: index + 1 })),
  });
}

function item(id: number, overrides: Partial<ItemDetail> = {}): [number, ItemDetail] {
  return [
    id,
    {
      id,
      name: `Item #${id}`,
      goldTotal: 3000,
      descriptionText: "",
      into: [],
      from: [],
      tags: [],
      purchasable: true,
      ...overrides,
    },
  ];
}

function itemMeta(...entries: [number, ItemDetail][]): Map<number, ItemDetail> {
  return new Map(entries);
}

function emptyModel() {
  return aggregateProConsensus([], itemMeta());
}

describe("mostBuiltPath", () => {
  it("reported regression: excludes a modal item already chosen earlier and keeps the replacement's raw count", () => {
    const START = 1056; // Doran's Ring
    const DUPLICATE = 4645; // Blackfire Torch
    const ALTERNATIVE = 3001;
    const OTHER = 3002;
    const meta = itemMeta(item(START), item(DUPLICATE), item(ALTERNATIVE), item(OTHER));
    const games = [
      ...Array.from({ length: 2 }, () => pathGame([START, DUPLICATE, ALTERNATIVE])),
      ...Array.from({ length: 2 }, () => pathGame([START, DUPLICATE, OTHER])),
      ...Array.from({ length: 2 }, () => pathGame([START, ALTERNATIVE, DUPLICATE])),
      ...Array.from({ length: 2 }, () => pathGame([START, OTHER, DUPLICATE])),
    ];

    const entries = mostBuiltPath(games, emptyModel(), meta);

    expect(entries.map((entry) => entry.itemId)).toEqual([START, DUPLICATE, ALTERNATIVE]);
    expect(new Set(entries.map((entry) => entry.itemId)).size).toBe(entries.length);
    expect(entries[1]).toEqual({ itemId: DUPLICATE, count: 4, denominator: 8 });
    expect(entries[2]).toEqual({ itemId: ALTERNATIVE, count: 2, denominator: 8 });
  });

  it("leaves a normal six-item path unchanged", () => {
    const ids = [4101, 4102, 4103, 4104, 4105, 4106];
    const meta = itemMeta(...ids.map((id) => item(id)));
    const entries = mostBuiltPath(
      [pathGame(ids), pathGame(ids)],
      emptyModel(),
      meta
    );

    expect(entries).toEqual(ids.map((itemId) => ({ itemId, count: 2, denominator: 2 })));
  });

  it("drops a position with no unused candidate and collapses the remaining path", () => {
    const FIRST = 5100;
    const OTHER_FIRST = 5101;
    const COMPONENT = 5102;
    const meta = itemMeta(
      item(FIRST),
      item(OTHER_FIRST),
      item(COMPONENT, { into: ["9999"] })
    );
    const games = [
      ...Array.from({ length: 3 }, () => pathGame([FIRST, COMPONENT])),
      ...Array.from({ length: 2 }, () => pathGame([OTHER_FIRST, FIRST])),
    ];

    const entries = mostBuiltPath(games, emptyModel(), meta);

    expect(entries).toEqual([{ itemId: FIRST, count: 3, denominator: 5 }]);
  });

  it("dedupes repeated purchases of the same id within one game", () => {
    const ids = [5200, 5201, 5202];
    const entries = mostBuiltPath(
      [pathGame(ids, [ids[0], ids[1], ids[1], ids[2]])],
      emptyModel(),
      itemMeta(...ids.map((id) => item(id)))
    );

    expect(entries).toEqual(ids.map((itemId) => ({ itemId, count: 1, denominator: 1 })));
  });

  it("uses the no-timeline starters/boots/items fallback and dedupes ids across partitions", () => {
    const STARTER = 5300;
    const BOOTS = 5301;
    const ITEM = 5302;
    const model = {
      ...emptyModel(),
      starters: [{ itemId: STARTER, count: 5, share: 1 }],
      boots: [{ itemId: BOOTS, count: 4, share: 0.8 }],
      items: [
        { itemId: STARTER, count: 3, share: 0.6 },
        { itemId: ITEM, count: 2, share: 0.4 },
      ],
      itemsSampleSize: 5,
    };

    const entries = mostBuiltPath([game()], model, itemMeta());

    expect(entries).toEqual([
      { itemId: STARTER, count: 5, denominator: 5 },
      { itemId: BOOTS, count: 4, denominator: 5 },
      { itemId: ITEM, count: 2, denominator: 5 },
    ]);
  });

  it("breaks equal counts by the lower item id", () => {
    const LOWER = 5401;
    const HIGHER = 5402;
    const meta = itemMeta(item(LOWER), item(HIGHER));

    const entries = mostBuiltPath(
      [pathGame([HIGHER]), pathGame([LOWER])],
      emptyModel(),
      meta
    );

    expect(entries[0]).toEqual({ itemId: LOWER, count: 1, denominator: 2 });
  });

  it("passes the item catalog so recipe ancestry classifies an untagged boot", () => {
    const GUNMETAL_GREAVES = 3172;
    const BERSERKERS_GREAVES = 3006;
    const RAW_BOOTS = 1001;
    const meta = itemMeta(
      item(GUNMETAL_GREAVES, { from: [String(BERSERKERS_GREAVES)] }),
      item(BERSERKERS_GREAVES, { from: [String(RAW_BOOTS)], tags: ["Boots"], into: [String(GUNMETAL_GREAVES)] }),
      item(RAW_BOOTS, { tags: ["Boots"], into: [String(BERSERKERS_GREAVES)] })
    );

    const entries = mostBuiltPath([pathGame([GUNMETAL_GREAVES])], emptyModel(), meta);

    expect(entries).toEqual([{ itemId: GUNMETAL_GREAVES, count: 1, denominator: 1 }]);
  });
  // ── RC-3 (2026-08-27): items UPGRADED IN PLACE were deleted from the path ──
  // Riot's timeline fires ITEM_PURCHASED for the thing you BUY. A tier-3 boot
  // enchant is not bought — the tier-2 boot becomes it — so the filter
  // `finalIds.has(purchase.itemId)` matched nothing and the item vanished.
  // Measured live: 85 of 127 Ahri Mid timelines end holding Crimson Lucidity
  // and ZERO of them purchased it, so the card's "most built path" rendered
  // with no boots in it at all.
  it("keeps an item that was upgraded in place, at the position it was bought", () => {
    const IONIAN = 3158;
    const CRIMSON_LUCIDITY = 3171;
    const FIRST_ITEM = 3152;
    const LATE_ITEM = 3157;
    const meta = itemMeta(
      item(IONIAN, { from: ["1001"], into: [String(CRIMSON_LUCIDITY)], tags: ["Boots"] }),
      item(CRIMSON_LUCIDITY, { from: [String(IONIAN)], tags: ["Boots"] }),
      item(FIRST_ITEM),
      item(LATE_ITEM)
    );
    const games = Array.from({ length: 3 }, () =>
      game({
        finalItems: [FIRST_ITEM, CRIMSON_LUCIDITY, LATE_ITEM],
        purchaseOrder: [
          { itemId: FIRST_ITEM, ts: 700 },
          { itemId: IONIAN, ts: 830 },
          { itemId: LATE_ITEM, ts: 1400 },
        ],
      })
    );

    const entries = mostBuiltPath(games, emptyModel(), meta);

    expect(entries.map((e) => e.itemId)).toEqual([FIRST_ITEM, CRIMSON_LUCIDITY, LATE_ITEM]);
  });

  // The hazard the RC-3 brief flagged, pinned in the OTHER direction: World
  // Atlas is bought at 0:00 and the quest final it becomes completes ~13
  // minutes in, so a naive ancestor walk would put a mid-build item at
  // position 1. It does not happen here, and the measurement says it cannot:
  // across 145 Thresh Support timelines the whole chain (World Atlas, Runic
  // Compass, Bounty of Worlds) fires ZERO purchase events.
  it("never promotes a support-quest final to position 1", () => {
    const WORLD_ATLAS = 3865;
    const BOUNTY_OF_WORLDS = 3867;
    const SOLSTICE_SLEIGH = 3876;
    const LOCKET = 3190;
    const meta = itemMeta(
      item(WORLD_ATLAS, { into: [String(BOUNTY_OF_WORLDS)] }),
      item(BOUNTY_OF_WORLDS, { into: [String(SOLSTICE_SLEIGH)], purchasable: false }),
      item(SOLSTICE_SLEIGH, { from: [String(BOUNTY_OF_WORLDS)] }),
      item(LOCKET)
    );
    // Even in the WORST case — the chain root DOES fire an event at ts 0 —
    // the quest final must not inherit it.
    const games = Array.from({ length: 3 }, () =>
      game({
        finalItems: [SOLSTICE_SLEIGH, LOCKET],
        purchaseOrder: [
          { itemId: WORLD_ATLAS, ts: 0 },
          { itemId: LOCKET, ts: 870 },
        ],
      })
    );

    const entries = mostBuiltPath(games, emptyModel(), meta);

    expect(entries.map((e) => e.itemId)).toEqual([LOCKET]);
  });
});
