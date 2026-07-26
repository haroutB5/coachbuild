/**
 * Pure-logic tests for aggregateProConsensus (components/hextech/proConsensus.ts)
 * — the "what do pros actually build" frequency aggregation backing the new
 * PRO CONSENSUS card (v0.27.0, refined v0.27.1). No JSX, no network — plain
 * ProGame[] + a fake item-metadata Map in, ProConsensusModel out.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateProConsensus,
  isBuildItem,
  formatSharePct,
  resolvePrimaryTree,
  STARTING_ITEM_ALLOWLIST,
  missingRunePageReason,
  proConsensusRuneApplyInput,
} from "../hextech/proConsensus";
import { isSupportFinalItem, rankSupportFinals, SUPPORT_FINAL_ITEM_IDS } from "../hextech/supportFinalGroup";
import {
  SUPPORT_FINAL_ITEMS,
  SUPPORT_STARTER_ID,
  SUPPORT_TIER2_ID,
  SUPPORT_QUEST_HUB_ID,
} from "../hextech/supportItem";
import { buildRuneApplyBody } from "../hextech/runeApplyBody";
import { isKeystoneOf, primaryMinorRow } from "../hextech/perkSlots";
import type { ProGame, ProGameRunes } from "../proGames.types";
import type { ItemDetail } from "../itemDetail";
import type { ShardSet } from "@/lib/types";

// Real rune tree + rune ids, used by the v0.29.0 tree-conditioning tests so
// the fixtures read like an actual rune page.
const SORCERY = 8200;
const PRECISION = 8000;
// Sorcery: keystone Deathfire Touch (8992), minors Manaflow Band (8226),
// Celerity (8234), Transcendence (8210).
const DEATHFIRE_TOUCH = 8992;
// Sorcery minor rows (perkstyles): row0 [8224,8226,8275], row1 [8210,8234,8233],
// row2 [8237,8232,8236]. NOTE Manaflow Band (8226)=row0, BUT Celerity (8234) AND
// Transcendence (8210) are BOTH row1 — the pre-fix apply-path fixtures paired
// them as if they were distinct minor rows, which is exactly the slot collision
// the 2026-07-22 fix guards against. Row-coherent apply fixtures below use
// MANAFLOW_BAND (row0) + TRANSCENDENCE (row1) + SCORCH (row2).
const MANAFLOW_BAND = 8226; // Sorcery row0
const CELERITY = 8234; // Sorcery row1
const TRANSCENDENCE = 8210; // Sorcery row1
const SCORCH = 8237; // Sorcery row2
// Precision: keystone Press the Attack (8005), minors Presence of Mind (8009),
// Triumph (9111), Coup de Grace (8014).
const PRESS_THE_ATTACK = 8005;
const PRESENCE_OF_MIND = 8009;
const TRIUMPH = 9111;
const COUP_DE_GRACE = 8014;

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

/** Fake item-metadata factory — mirrors the real ddragon-shaped fields
 *  itemDetail.ts's getItemDetailMap resolves (into/from/tags/purchasable),
 *  with sane "completed item" defaults so tests only need to override what
 *  they're exercising. */
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

// Real ids from a live 16.13.1 item.json pull (2026-07-13), used across
// several tests below so the fixtures read like the actual champion cards.
const ROCKETBELT = 3152; // completed — from:[...], into:[] (empty)
const NEEDLESSLY_LARGE_ROD = 1058; // component — into: 6 core mage items
const DARK_SEAL = 1082; // allowlisted starting item — into:["3041"] (Mejai's)
const TEAR_OF_THE_GODDESS = 3070; // allowlisted starting item — into: 4 mana items
const DORANS_RING = 1056; // allowlisted + already empty-into
const SORCERERS_SHOES = 3020; // tier-2 boots — into:["3175"], from:["1001"], tags:["Boots",...]
const RAW_BOOTS = 1001; // tier-1 boots — into: many, from: [] — must NOT count
const SWIFTMARCH = 3170; // tier-3 boots enchant — from:["3009"], into:[] — completed either way

// Support-quest FINALS (2026-07-26 collapse). Ids come from the real
// SUPPORT_FINAL_ITEMS export, never re-typed here — same rule the production
// module follows, so a patch that moves an id can't leave the tests asserting
// against a stale number that still passes.
const ZAZZAKS = SUPPORT_FINAL_ITEMS.zazzaks.id; // 3871
const SOLSTICE_SLEIGH = SUPPORT_FINAL_ITEMS.solsticeSleigh.id; // 3876
const BLOODSONG = SUPPORT_FINAL_ITEMS.bloodsong.id; // 3877
const DREAM_MAKER = SUPPORT_FINAL_ITEMS.dreamMaker.id; // 3870
/** Ascending id order — several tests below rely on the itemId-asc tie-break,
 *  so a stable, explicit order beats Set/Object iteration order. */
const ALL_SUPPORT_FINAL_IDS = Array.from(SUPPORT_FINAL_ITEM_IDS).sort((a, b) => a - b);
/** The real 16.13.1 ddragon shape for all five finals (verified 2026-07-26
 *  against the coachless CDN mirror): built FROM the quest hub, a recipe-tree
 *  leaf, purchasable, and NOT Boots-tagged — i.e. they pass `isBuildItem` and
 *  reach the items partition on their own merits, which is exactly why the
 *  duplication bug was possible. */
const SUPPORT_FINAL_META = {
  from: ["3867"],
  into: [],
  purchasable: true,
  tags: ["Health", "HealthRegen", "ManaRegen", "Vision", "GoldPer", "Lane"],
};

describe("isBuildItem", () => {
  it("excludes a component with a populated `into` (Needlessly Large Rod)", () => {
    const meta = itemMeta(item(NEEDLESSLY_LARGE_ROD, { into: ["3157", "4645", "3089", "3102", "3128", "4403"], tags: ["SpellDamage"] }));
    expect(isBuildItem(NEEDLESSLY_LARGE_ROD, meta.get(NEEDLESSLY_LARGE_ROD))).toBe(false);
  });

  it("includes a completed item with an empty `into` (Rocketbelt)", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["3145", "3108", "1028"], tags: ["Health", "SpellDamage"] }));
    expect(isBuildItem(ROCKETBELT, meta.get(ROCKETBELT))).toBe(true);
  });

  it("includes a tier-2 boot even though it still has an `into` (Sorcerer's Shoes)", () => {
    const meta = itemMeta(item(SORCERERS_SHOES, { into: ["3175"], from: ["1001"], tags: ["Boots", "MagicPenetration"] }));
    expect(isBuildItem(SORCERERS_SHOES, meta.get(SORCERERS_SHOES))).toBe(true);
  });

  it("excludes raw tier-1 Boots (no `from`, so not a boots final)", () => {
    const meta = itemMeta(item(RAW_BOOTS, { into: ["3005", "3020"], from: [], tags: ["Boots"] }));
    expect(isBuildItem(RAW_BOOTS, meta.get(RAW_BOOTS))).toBe(false);
  });

  it("includes a tier-3 boots enchant (Swiftmarch)", () => {
    const meta = itemMeta(item(SWIFTMARCH, { from: ["3009"], into: [], tags: ["Boots"] }));
    expect(isBuildItem(SWIFTMARCH, meta.get(SWIFTMARCH))).toBe(true);
  });

  it("includes an allowlisted starting item even though it has a real `into` (Dark Seal)", () => {
    const meta = itemMeta(item(DARK_SEAL, { into: ["3041"], tags: ["Health", "SpellDamage", "Lane"] }));
    expect(isBuildItem(DARK_SEAL, meta.get(DARK_SEAL))).toBe(true);
  });

  it("includes an allowlisted starting item with no metadata at all (allowlist wins over unknown-data exclusion)", () => {
    expect(isBuildItem(TEAR_OF_THE_GODDESS, undefined)).toBe(true);
  });

  it("excludes a non-purchasable item (quest-root / legacy id) even with empty into", () => {
    const meta = itemMeta(item(9999, { into: [], purchasable: false }));
    expect(isBuildItem(9999, meta.get(9999))).toBe(false);
  });

  it("excludes an item id with no metadata and no allowlist entry", () => {
    expect(isBuildItem(424242, undefined)).toBe(false);
  });

  it("real prod regression: a legacy-shape meta object (pre-v0.27.1 cache entry missing into/from/tags/purchasable) never throws", () => {
    // Reproduces the reported "Pro consensus data couldn't load (undefined is
    // not an object (evaluating 'D.tags.includes'))" crash — a device with a
    // stale localStorage cache from before v0.27.1 added into/from/tags/
    // purchasable to ItemDetail returned an entry missing those fields.
    // itemDetail.ts now normalizes the cache on read (v1->v2 prefix bump +
    // defensive coercion), but isBuildItem must also degrade gracefully on
    // its own, since `meta` is only a TYPE guarantee, not a runtime one, for
    // any value that ultimately came from JSON.parse.
    const legacyMeta = {
      id: SORCERERS_SHOES,
      name: "Sorcerer's Shoes",
      goldTotal: 1100,
      descriptionText: "",
      // into/from/tags/purchasable intentionally omitted — legacy shape
    } as unknown as ItemDetail;
    expect(() => isBuildItem(SORCERERS_SHOES, legacyMeta)).not.toThrow();
    expect(typeof isBuildItem(SORCERERS_SHOES, legacyMeta)).toBe("boolean");
    // Boots special case can't confirm (tags missing) and into is undefined
    // (not an empty array) -> falls through to "exclude, don't assume".
    expect(isBuildItem(SORCERERS_SHOES, legacyMeta)).toBe(false);
  });
});

describe("aggregateProConsensus", () => {
  it("returns an empty model for N=0", () => {
    const model = aggregateProConsensus([], itemMeta());
    expect(model.gamesTotal).toBe(0);
    expect(model.items).toEqual([]);
    expect(model.boots).toEqual([]);
    expect(model.starters).toEqual([]);
    expect(model.supportFinals).toBeNull();
    expect(model.keystone).toBeNull();
    expect(model.primaryTree).toBeNull();
    expect(model.primaryTreeSampleSize).toBe(0);
    expect(model.secondaryTree).toBeNull();
    expect(model.spellPair).toBeNull();
    expect(model.tournaments).toEqual({ names: [], soloqCount: 0, prostageCount: 0 });
    expect(model.primaryMinors).toEqual({ entries: [], sampleSize: 0, soloqCount: 0, prostageCount: 0 });
    expect(model.secondaryPicks).toEqual({ entries: [], sampleSize: 0, soloqCount: 0, prostageCount: 0 });
    expect(model.shards).toEqual({ entries: [], sampleSize: 0, soloqCount: 0, prostageCount: 0 });
  });

  it("counts item pick rate against itemsSampleSize, excluding consumables", () => {
    // Every game here carries a non-empty finalItems array, so itemsSampleSize
    // == gamesTotal (== 3) and the shares below are numerically unchanged from
    // before the 2026-07-25 fix — see the dedicated dilution test below for the
    // case where the two denominators actually diverge.
    const meta = itemMeta(
      item(ROCKETBELT, { from: ["x"] }),
      item(3020, { into: ["3175"], from: ["1001"], tags: ["Boots"] }) // Sorc Shoes
    );
    const games = [
      game({ finalItems: [ROCKETBELT, 2003, 3020] }), // Rocketbelt, Health Potion, Sorc Shoes
      game({ finalItems: [ROCKETBELT, 3020] }),
      game({ finalItems: [4645] }), // no metadata at all -> excluded
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.gamesTotal).toBe(3);
    expect(model.itemsSampleSize).toBe(3);
    const rocketbelt = model.items.find((i) => i.itemId === ROCKETBELT);
    expect(rocketbelt).toEqual({ itemId: ROCKETBELT, count: 2, share: 2 / 3 });
    // Health Potion (2003) is a consumable — must never appear in item counts.
    expect(model.items.find((i) => i.itemId === 2003)).toBeUndefined();
    // Sorc Shoes is boots -> carved into `boots`, not `items` (v0.28.0).
    expect(model.items.find((i) => i.itemId === 3020)).toBeUndefined();
    const sorcShoes = model.boots.find((i) => i.itemId === 3020);
    expect(sorcShoes?.count).toBe(2);
    // 4645 has no metadata and isn't allowlisted -> excluded, not just "unnamed".
    expect(model.items.find((i) => i.itemId === 4645)).toBeUndefined();
  });

  it("2026-07-25 P1-2 fix: itemless (live-ingested) rows dilute itemsSampleSize, not gamesTotal — item shares stay honest", () => {
    // Regression for the P1-2 audit finding: live-ingested prostage rows
    // (lib/prostage/liveIngest.ts) write final_items='[]' before a human
    // opens that game's detail sheet. Before this fix, every ItemFrequency
    // share divided by gamesTotal, so those itemless rows silently understated
    // every item/boots/starter percentage.
    const meta = itemMeta(
      item(ROCKETBELT, { from: ["x"] }),
      item(3020, { into: ["3175"], from: ["1001"], tags: ["Boots"] }), // Sorc Shoes
      item(DARK_SEAL, { into: ["3041"] })
    );
    const games = [
      game({ finalItems: [ROCKETBELT, 3020, DARK_SEAL] }),
      game({ finalItems: [ROCKETBELT, 3020, DARK_SEAL] }),
      game({ finalItems: [] }), // live row, item data not resolved yet
      game({ finalItems: [] }), // live row, item data not resolved yet
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.gamesTotal).toBe(4);
    expect(model.itemsSampleSize).toBe(2); // only the 2 games that actually carried item data
    // 2 of 2 item-bearing games -> 100%, NOT 2 of 4 gamesTotal (50%, the
    // pre-fix understated number).
    expect(model.items.find((i) => i.itemId === ROCKETBELT)).toEqual({ itemId: ROCKETBELT, count: 2, share: 1 });
    expect(model.boots.find((i) => i.itemId === 3020)).toEqual({ itemId: 3020, count: 2, share: 1 });
    expect(model.starters.find((i) => i.itemId === DARK_SEAL)).toEqual({ itemId: DARK_SEAL, count: 2, share: 1 });
  });

  it("real-data regression: Needlessly Large Rod never appears even when frequently bought as a component", () => {
    const meta = itemMeta(
      item(ROCKETBELT, { from: ["x"] }),
      item(NEEDLESSLY_LARGE_ROD, { into: ["3157", "4645", "3089", "3102", "3128", "4403"], tags: ["SpellDamage"] })
    );
    const games = Array.from({ length: 5 }, () => game({ finalItems: [ROCKETBELT, NEEDLESSLY_LARGE_ROD] }));
    const model = aggregateProConsensus(games, meta);
    expect(model.items.find((i) => i.itemId === NEEDLESSLY_LARGE_ROD)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === ROCKETBELT)?.count).toBe(5);
  });

  it("dedupes an item that appears twice in the same game's finalItems", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }), item(3020, { into: [], from: ["1001"], tags: ["Boots"] }));
    const games = [game({ finalItems: [ROCKETBELT, ROCKETBELT, 3020] })];
    const model = aggregateProConsensus(games, meta);
    const rocketbelt = model.items.find((i) => i.itemId === ROCKETBELT);
    expect(rocketbelt?.count).toBe(1);
  });

  it("caps the item list at 6, sorted by count desc then itemId asc", () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const meta = itemMeta(...ids.map((id) => item(id, { from: ["x"] })));
    // 8 distinct items, each in exactly one game except item 1 (in all 5) —
    // exercises both the top-6 cap and the deterministic tie order.
    const games = [
      game({ finalItems: ids }),
      game({ finalItems: [1] }),
      game({ finalItems: [1] }),
      game({ finalItems: [1] }),
      game({ finalItems: [1] }),
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.items).toHaveLength(6);
    expect(model.items[0]).toEqual({ itemId: 1, count: 5, share: 1 });
    // Remaining 7 items are tied at count=1 — itemId asc breaks the tie.
    expect(model.items.slice(1).map((i) => i.itemId)).toEqual([2, 3, 4, 5, 6]);
  });

  it("boots count as a real build choice once past tier 1, surfaced via `boots` not `items` (v0.28.0)", () => {
    const meta = itemMeta(item(3020, { into: ["3175"], from: ["1001"], tags: ["Boots"] }));
    const games = [game({ finalItems: [3020] }), game({ finalItems: [3020] })];
    const model = aggregateProConsensus(games, meta);
    expect(model.items.find((i) => i.itemId === 3020)).toBeUndefined();
    expect(model.boots.find((i) => i.itemId === 3020)).toEqual({ itemId: 3020, count: 2, share: 1 });
  });

  it("computes keystone frequency against runesSampleSize, not gamesTotal", () => {
    const games = [
      game({ runes: { ...NO_RUNES, keystone: 8229 } }), // Arcane Comet
      game({ runes: { ...NO_RUNES, keystone: 8229 } }),
      game({ runes: { ...NO_RUNES, keystone: 8112 } }), // Electrocute
      game({ runes: NO_RUNES }), // no rune data (prostage row Leaguepedia never filled)
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.gamesTotal).toBe(4);
    expect(model.runesSampleSize).toBe(3); // the keystone:0 row is excluded from the denominator
    expect(model.keystone).toEqual({ keystoneId: 8229, count: 2, share: 2 / 3 });
  });

  it("keystone is null when every game lacks rune data", () => {
    const games = [game({ runes: NO_RUNES }), game({ runes: NO_RUNES })];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.keystone).toBeNull();
    expect(model.runesSampleSize).toBe(0);
  });

  it("computes secondary tree over the page sample, independent of keystone resolution within that sample (v0.29.0)", () => {
    const games = [
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, secondaryTree: 8100 } }),
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: 0, secondaryTree: 8100 } }), // keystone missing, tree still known
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: 0, secondaryTree: 0 } }), // secondary missing
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.primaryTree).toBe(SORCERY);
    expect(model.primaryTreeSampleSize).toBe(3);
    expect(model.secondaryTreeSampleSize).toBe(2); // the secondaryTree:0 row is excluded from the denominator
    expect(model.secondaryTree).toEqual({ treeId: 8100, count: 2, share: 1 });
  });

  it("merges a spell pair regardless of D/F key order, excludes any pair with an unresolved slot", () => {
    const games = [
      game({ spells: [4, 14] }), // Flash, Ignite
      game({ spells: [14, 4] }), // Ignite, Flash — same combo, swapped keybind
      game({ spells: [4, 0] }), // unresolved second slot — excluded entirely
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.spellSampleSize).toBe(2);
    expect(model.spellPair).toEqual({ spells: [4, 14], count: 2, share: 1 });
  });

  it("low-N (<3) still returns real fractions — the UI decides how to flag it", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const games = [game({ finalItems: [ROCKETBELT] })];
    const model = aggregateProConsensus(games, meta);
    expect(model.gamesTotal).toBe(1);
    expect(model.items[0]).toEqual({ itemId: ROCKETBELT, count: 1, share: 1 });
  });

  it("counts soloq/prostage source split and unique prostage tournaments, most-frequent first", () => {
    const games = [
      game({ source: "soloq" }),
      game({ source: "prostage", tournament: "LEC 2026 Summer" }),
      game({ source: "prostage", tournament: "LEC 2026 Summer" }),
      game({ source: "prostage", tournament: "LCK Summer 2026" }),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.tournaments.soloqCount).toBe(1);
    expect(model.tournaments.prostageCount).toBe(3);
    expect(model.tournaments.names).toEqual(["LEC 2026 Summer", "LCK Summer 2026"]);
  });

  it("never crashes on missing/undefined finalItems or spells arrays", () => {
    const malformed = { ...game(), finalItems: undefined, spells: undefined } as unknown as ProGame;
    expect(() => aggregateProConsensus([malformed], itemMeta())).not.toThrow();
  });

  // ── v0.27.1: additional-runes aggregation ─────────────────────────────────

  it("aggregates primary-tree minors per-slot-group, denominator = games with a non-empty primary[]", () => {
    const games = [
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, primary: [8226, 8210, 8237] } }),
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, primary: [8226, 8210, 8237] } }),
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, primary: [] } }), // prostage row, keystone-only — must not dilute
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.primaryMinors.sampleSize).toBe(2);
    expect(model.primaryMinors.entries).toHaveLength(3);
    expect(model.primaryMinors.entries[0]).toEqual({ runeId: 8210, count: 2, share: 1 }); // 8210 < 8226 < 8237 asc tiebreak
  });

  it("caps primary minors at 3 and secondary picks at 2", () => {
    const games = [
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, primary: [1, 2, 3, 4], secondaryTree: PRECISION, secondary: [5, 6, 7] } }),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.primaryMinors.entries).toHaveLength(3);
    expect(model.secondaryPicks.entries).toHaveLength(2);
  });

  it("a prostage row without minors doesn't dilute the primary-minors sample (per-slot denominator independence)", () => {
    const games = [
      game({ source: "soloq", runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [8226, 8210, 8237] } }),
      game({ source: "prostage", tournament: "LCK", runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH } }), // keystone-only, no minors
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.runesSampleSize).toBe(2); // keystone resolved on both
    expect(model.primaryTreeSampleSize).toBe(2); // both ran the primary tree
    expect(model.primaryMinors.sampleSize).toBe(1); // only the soloq row carried minors
    expect(model.primaryMinors.soloqCount).toBe(1);
    expect(model.primaryMinors.prostageCount).toBe(0);
  });

  it("shards are structurally soloq-only when prostage rows never populate them, and the breakdown says so", () => {
    const games = [
      game({ source: "soloq", runes: { ...NO_RUNES, shards: [5008, 5005, 5013] } }),
      game({ source: "soloq", runes: { ...NO_RUNES, shards: [5008, 5005, 5013] } }),
      game({ source: "prostage", tournament: "MSI", runes: { ...NO_RUNES, shards: [] } }),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.shards.sampleSize).toBe(2);
    expect(model.shards.soloqCount).toBe(2);
    expect(model.shards.prostageCount).toBe(0);
    expect(model.shards.entries[0]).toEqual({ runeId: 5005, count: 2, share: 1 }); // 5005 < 5008 < 5013 asc tiebreak
  });

  it("secondary picks dedupe within a single game (defensive — a real page never repeats a pick)", () => {
    const games = [
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, secondaryTree: PRECISION, secondary: [8009, 8009, 8014] } }),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.secondaryPicks.entries.find((e) => e.runeId === 8009)?.count).toBe(1);
  });

  it("never crashes when runes.primary/secondary/shards are missing entirely (malformed payload)", () => {
    const malformed = { ...game(), runes: { ...NO_RUNES, primary: undefined, secondary: undefined, shards: undefined } } as unknown as ProGame;
    expect(() => aggregateProConsensus([malformed], itemMeta())).not.toThrow();
  });

  // ── v0.28.0: boots carved out of `items` into their own `boots` list ──────

  it("carves boots out of items into their own list, freeing an items slot for a real item", () => {
    const CRIMSON_LUCIDITY = 3117; // fake but tagged as tier-3 boots enchant
    const SPELLSLINGERS_SHOES = 3020;
    const meta = itemMeta(
      item(ROCKETBELT, { from: ["x"] }),
      item(CRIMSON_LUCIDITY, { from: ["1001"], tags: ["Boots"] }),
      item(SPELLSLINGERS_SHOES, { into: ["3157"], from: ["1001"], tags: ["Boots", "MagicPenetration"] })
    );
    const games = [
      ...Array.from({ length: 5 }, () => game({ finalItems: [ROCKETBELT, CRIMSON_LUCIDITY] })),
      ...Array.from({ length: 3 }, () => game({ finalItems: [ROCKETBELT, SPELLSLINGERS_SHOES] })),
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.items.find((i) => i.itemId === CRIMSON_LUCIDITY)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === SPELLSLINGERS_SHOES)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === ROCKETBELT)?.count).toBe(8);
    expect(model.boots).toEqual([
      { itemId: CRIMSON_LUCIDITY, count: 5, share: 5 / 8 },
      { itemId: SPELLSLINGERS_SHOES, count: 3, share: 3 / 8 },
    ]);
  });

  it("caps boots at top 2, sorted count desc then itemId asc, and backfills items to top 6 non-boots", () => {
    const bootIds = [3006, 3009, 3020, 3047, 3111, 3158]; // 6 distinct boots
    const nonBootIds = [1, 2, 3, 4, 5, 6, 7]; // 7 distinct non-boots
    const meta = itemMeta(
      ...bootIds.map((id) => item(id, { from: ["1001"], tags: ["Boots"] })),
      ...nonBootIds.map((id) => item(id, { from: ["x"] }))
    );
    // Every id appears in exactly one game each -> all tied at count=1 within
    // their own partition; itemId asc breaks the tie in both lists.
    const games = [...bootIds, ...nonBootIds].map((id) => game({ finalItems: [id] }));
    const model = aggregateProConsensus(games, meta);
    expect(model.boots).toHaveLength(2);
    expect(model.boots.map((b) => b.itemId)).toEqual([3006, 3009]);
    expect(model.items).toHaveLength(6);
    expect(model.items.map((i) => i.itemId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("never classifies an item with no metadata as boots, even at high pick rate", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const games = [
      ...Array.from({ length: 4 }, () => game({ finalItems: [ROCKETBELT] })),
      // 4645 has no metadata -> excluded entirely (isBuildItem returns false),
      // and must never appear in `boots` even if it somehow slipped through.
      game({ finalItems: [4645] }),
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.boots).toEqual([]);
    expect(model.items.find((i) => i.itemId === 4645)).toBeUndefined();
  });

  it("boots list is empty (not undefined/throwing) when the sample has no boots at all", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const model = aggregateProConsensus([game({ finalItems: [ROCKETBELT] })], meta);
    expect(model.boots).toEqual([]);
  });

  // ── 2026-07-22: starters carved out of `items` into their own `starters`
  // list — hard user directive, screenshot-verified live bug: Pro Consensus's
  // ITEMS grid on Viktor mid showed "Dark Seal 24% (23/95)" mixed in with
  // Blackfire Torch/Rabadon's/etc. Mirrors the v0.28.0 boots partition
  // exactly (same mechanism, same test shapes below).

  it("carves starter-allowlist items out of items into their own starters list, freeing an items slot for a real item", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] })); // Dark Seal/Tear need no metadata (allowlist wins)
    const games = [
      ...Array.from({ length: 23 }, () => game({ finalItems: [ROCKETBELT, DARK_SEAL] })),
      ...Array.from({ length: 5 }, () => game({ finalItems: [ROCKETBELT, TEAR_OF_THE_GODDESS] })),
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.items.find((i) => i.itemId === DARK_SEAL)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === TEAR_OF_THE_GODDESS)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === ROCKETBELT)?.count).toBe(28);
    expect(model.starters).toEqual([
      { itemId: DARK_SEAL, count: 23, share: 23 / 28 },
      { itemId: TEAR_OF_THE_GODDESS, count: 5, share: 5 / 28 },
    ]);
  });

  it("REGRESSION PIN: the main items aggregation can never contain an allowlist id, across every real allowlist entry", () => {
    // Every id in the real STARTING_ITEM_ALLOWLIST, each pumped to a high
    // pick rate alongside one ordinary completed item — if the partition
    // regressed for even one entry (e.g. someone reordered the boots/starter
    // checks, or a future allowlist addition), this catches it generically
    // rather than only re-testing the two ids the header comment calls out.
    // Each allowlist id gets a DISTINCT game count (descending) specifically
    // so every one of them clears TOP_STARTERS_LIMIT's cap and is checked in
    // `starters` too, not just excluded from `items` — see the dedicated cap
    // test below for the truncation behavior itself.
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const allowlistIds = Array.from(STARTING_ITEM_ALLOWLIST);
    for (const id of allowlistIds) {
      const games = [game({ finalItems: [ROCKETBELT, id] })];
      const model = aggregateProConsensus(games, meta);
      expect(model.items.some((i) => i.itemId === id)).toBe(false);
      expect(model.starters.some((i) => i.itemId === id)).toBe(true);
    }
  });

  it("starters is capped, sorted count desc then itemId asc, mirroring the boots cap", () => {
    // 9 real allowlist entries in the module today — pump all of them so the
    // cap is actually exercised, not just documented.
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const allowlistIds = Array.from(STARTING_ITEM_ALLOWLIST).sort((a, b) => a - b);
    const games = allowlistIds.map((id) => game({ finalItems: [ROCKETBELT, id] }));
    const model = aggregateProConsensus(games, meta);
    expect(model.starters.length).toBeLessThanOrEqual(2);
    expect(model.starters.length).toBeGreaterThan(0);
    // All tied at count=1 -> itemId asc breaks the tie -> the two lowest ids win.
    expect(model.starters.map((s) => s.itemId)).toEqual(allowlistIds.slice(0, 2));
  });

  it("starters list is empty (not undefined/throwing) when the sample has no starter-class items at all", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const model = aggregateProConsensus([game({ finalItems: [ROCKETBELT] })], meta);
    expect(model.starters).toEqual([]);
  });

  it("a starter that is ALSO the modal item still only ever appears in starters, never in items, at any pick rate", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const games = [
      ...Array.from({ length: 20 }, () => game({ finalItems: [DARK_SEAL] })), // Dark Seal as the ONLY item this game, high pick rate
      game({ finalItems: [ROCKETBELT] }),
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.items).toEqual([{ itemId: ROCKETBELT, count: 1, share: 1 / 21 }]);
    expect(model.starters).toEqual([{ itemId: DARK_SEAL, count: 20, share: 20 / 21 }]);
  });

  // ── 2026-07-26: support-quest FINALS collapsed into ONE slot ──────────────
  // Live user report, screenshot-confirmed: the ITEMS grid rendered Zaz'Zak's
  // Realmspike 80% AND Solstice Sleigh 20% at once. Only ONE of the five
  // finals can ever be owned (Bounty of Worlds upgrades into exactly one), so
  // that was one choice split across the sample burning two of six slots.
  // Mirrors the v0.28.0 boots and 2026-07-22 starters partitions exactly.

  it("USER BUG REPRO: two support finals in one sample collapse to one slot plus an alternative, freeing an items slot", () => {
    // The exact reported shape: Zaz'Zak's in 8 of 10 item-bearing games,
    // Solstice Sleigh in the other 2. Real 16.13.1 metadata (from:["3867"],
    // into:[], purchasable, no Boots tag) so isBuildItem counts both.
    const meta = itemMeta(
      item(ROCKETBELT, { from: ["x"] }),
      item(ZAZZAKS, SUPPORT_FINAL_META),
      item(SOLSTICE_SLEIGH, SUPPORT_FINAL_META)
    );
    const games = [
      ...Array.from({ length: 8 }, () => game({ finalItems: [ROCKETBELT, ZAZZAKS] })),
      ...Array.from({ length: 2 }, () => game({ finalItems: [ROCKETBELT, SOLSTICE_SLEIGH] })),
    ];
    const model = aggregateProConsensus(games, meta);

    // Neither final may appear in the main grid any more.
    expect(model.items.find((i) => i.itemId === ZAZZAKS)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === SOLSTICE_SLEIGH)).toBeUndefined();
    expect(model.items.find((i) => i.itemId === ROCKETBELT)?.count).toBe(10);

    // One slot: the modal pick, with the runner-up as an alternative.
    expect(model.supportFinals).toEqual({
      top: { itemId: ZAZZAKS, count: 8, share: 8 / 10 },
      alternatives: [{ itemId: SOLSTICE_SLEIGH, count: 2, share: 2 / 10 }],
    });
    // Each keeps its OWN honest percentage — never merged/re-normalised into
    // a combined "the family was built 100%" stat describing nobody's build.
    expect(model.supportFinals!.top.share + model.supportFinals!.alternatives[0].share).toBe(1);
    expect(model.supportFinals!.top.share).not.toBe(1);
  });

  it("a single support final still renders: top pick, no alternatives", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }), item(DREAM_MAKER, SUPPORT_FINAL_META));
    const games = Array.from({ length: 4 }, () => game({ finalItems: [ROCKETBELT, DREAM_MAKER] }));
    const model = aggregateProConsensus(games, meta);
    expect(model.supportFinals).toEqual({
      top: { itemId: DREAM_MAKER, count: 4, share: 1 },
      alternatives: [],
    });
    expect(model.items.find((i) => i.itemId === DREAM_MAKER)).toBeUndefined();
  });

  it("zero support finals renders NOTHING — null, not an empty object (absent-not-empty, same as boots/starters)", () => {
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }));
    const model = aggregateProConsensus([game({ finalItems: [ROCKETBELT] })], meta);
    expect(model.supportFinals).toBeNull();
  });

  it("REGRESSION PIN: no support final can ever reach `items`, across all five family ids", () => {
    // Generic across the real SUPPORT_FINAL_ITEMS export rather than only the
    // two ids the bug report named — a future 6th final, or a reordered
    // partition, is caught here rather than in production.
    const meta = itemMeta(item(ROCKETBELT, { from: ["x"] }), ...ALL_SUPPORT_FINAL_IDS.map((id) => item(id, SUPPORT_FINAL_META)));
    for (const id of ALL_SUPPORT_FINAL_IDS) {
      const model = aggregateProConsensus([game({ finalItems: [ROCKETBELT, id] })], meta);
      expect(model.items.some((i) => i.itemId === id)).toBe(false);
      expect(model.supportFinals?.top.itemId).toBe(id);
    }
  });

  it("tie-break is deterministic: equal counts resolve by itemId asc, regardless of first-seen order", () => {
    const meta = itemMeta(item(ZAZZAKS, SUPPORT_FINAL_META), item(SOLSTICE_SLEIGH, SUPPORT_FINAL_META));
    // Solstice Sleigh (3876) is seen FIRST, so it leads the underlying Map's
    // insertion order; Zaz'Zak's (3871) is the lower id and must still win.
    const games = [game({ finalItems: [SOLSTICE_SLEIGH] }), game({ finalItems: [ZAZZAKS] })];
    const model = aggregateProConsensus(games, meta);
    expect(model.supportFinals?.top.itemId).toBe(ZAZZAKS);
    expect(model.supportFinals?.alternatives.map((a) => a.itemId)).toEqual([SOLSTICE_SLEIGH]);
  });

  it("caps the slot at 3 entries (top + 2 alternatives) and never drops the top pick", () => {
    // All five finals at DISTINCT counts so the ranking is unambiguous and
    // the cap trims the weakest runners-up, not the winner.
    const meta = itemMeta(...ALL_SUPPORT_FINAL_IDS.map((id) => item(id, SUPPORT_FINAL_META)));
    const ranked = [...ALL_SUPPORT_FINAL_IDS];
    const games = ranked.flatMap((id, i) =>
      Array.from({ length: ranked.length - i }, () => game({ finalItems: [id] }))
    );
    const model = aggregateProConsensus(games, meta);
    expect(model.supportFinals?.top.itemId).toBe(ranked[0]);
    expect(model.supportFinals?.alternatives).toHaveLength(2);
    expect(model.supportFinals?.alternatives.map((a) => a.itemId)).toEqual([ranked[1], ranked[2]]);
  });

  it("the quest chain's other tiers are unaffected: World Atlas stays a STARTER, 3866/3867 stay excluded entirely", () => {
    // Order-of-checks guard. World Atlas (3865) is in STARTING_ITEM_ALLOWLIST
    // and must keep landing in `starters`, never in the new slot.
    //
    // 3866/3867 are excluded by isBuildItem — but NOT the way you'd assume,
    // and this fixture encodes the LIVE 16.13.1 shape rather than the
    // intuitive one: Bounty of Worlds (3867) has a populated `into` AND is
    // non-purchasable, while Runic Compass (3866) has NO `into` at all
    // (normalized to []) and is held out by `purchasable: false` ALONE. If a
    // future refactor drops the purchasable check believing `into` covers the
    // intermediate tiers, this test is what fails.
    const meta = itemMeta(
      item(SUPPORT_STARTER_ID, { from: [], into: [], tags: ["Health", "ManaRegen", "Vision", "GoldPer", "Lane"] }),
      item(SUPPORT_TIER2_ID, { from: [], into: [], purchasable: false, tags: ["SpellDamage", "Lane"] }),
      item(SUPPORT_QUEST_HUB_ID, {
        from: [],
        into: ["3869", "3870", "3871", "3876", "3877"],
        purchasable: false,
        tags: ["SpellDamage", "Lane"],
      }),
      item(ZAZZAKS, SUPPORT_FINAL_META)
    );
    const games = Array.from({ length: 3 }, () =>
      game({ finalItems: [SUPPORT_STARTER_ID, SUPPORT_TIER2_ID, SUPPORT_QUEST_HUB_ID, ZAZZAKS] })
    );
    const model = aggregateProConsensus(games, meta);

    expect(model.starters.map((s) => s.itemId)).toEqual([SUPPORT_STARTER_ID]);
    expect(model.supportFinals?.top.itemId).toBe(ZAZZAKS);
    expect(model.supportFinals?.alternatives).toEqual([]);
    for (const id of [SUPPORT_TIER2_ID, SUPPORT_QUEST_HUB_ID]) {
      expect(model.items.some((i) => i.itemId === id)).toBe(false);
      expect(model.starters.some((s) => s.itemId === id)).toBe(false);
      expect(model.supportFinals?.top.itemId).not.toBe(id);
      expect(model.supportFinals?.alternatives.some((a) => a.itemId === id)).toBe(false);
      expect(isBuildItem(id, meta.get(id))).toBe(false);
    }
  });

  it("the boots and starters partitions are unaffected by the support-final carve-out", () => {
    const meta = itemMeta(
      item(ROCKETBELT, { from: ["x"] }),
      item(SORCERERS_SHOES, { into: ["3175"], from: ["1001"], tags: ["Boots", "MagicPenetration"] }),
      item(ZAZZAKS, SUPPORT_FINAL_META)
    );
    const games = Array.from({ length: 5 }, () =>
      game({ finalItems: [ROCKETBELT, SORCERERS_SHOES, DARK_SEAL, ZAZZAKS] })
    );
    const model = aggregateProConsensus(games, meta);
    expect(model.boots).toEqual([{ itemId: SORCERERS_SHOES, count: 5, share: 1 }]);
    expect(model.starters).toEqual([{ itemId: DARK_SEAL, count: 5, share: 1 }]);
    expect(model.items).toEqual([{ itemId: ROCKETBELT, count: 5, share: 1 }]);
    expect(model.supportFinals?.top).toEqual({ itemId: ZAZZAKS, count: 5, share: 1 });
  });

  it("support-final shares use itemsSampleSize, the same denominator as items/boots/starters", () => {
    const meta = itemMeta(item(ZAZZAKS, SUPPORT_FINAL_META));
    const games = [
      ...Array.from({ length: 3 }, () => game({ finalItems: [ZAZZAKS] })),
      // Live-ingested prostage rows carry no item data — they must not dilute
      // this fraction any more than they dilute items/boots/starters.
      ...Array.from({ length: 2 }, () => game({ source: "prostage", finalItems: [] })),
    ];
    const model = aggregateProConsensus(games, meta);
    expect(model.gamesTotal).toBe(5);
    expect(model.itemsSampleSize).toBe(3);
    expect(model.supportFinals?.top).toEqual({ itemId: ZAZZAKS, count: 3, share: 1 });
  });
});

// ── rankSupportFinals — the pure collapse helper ────────────────────────────

describe("rankSupportFinals (supportFinalGroup.ts)", () => {
  const e = (itemId: number, count: number) => ({ itemId, count });

  it("returns null for an empty list", () => {
    expect(rankSupportFinals([])).toBeNull();
  });

  it("returns null when no entry belongs to the family", () => {
    expect(rankSupportFinals([e(ROCKETBELT, 10), e(DARK_SEAL, 5), e(SORCERERS_SHOES, 3)])).toBeNull();
  });

  it("ignores non-family ids and never returns them", () => {
    const ranking = rankSupportFinals([e(ROCKETBELT, 99), e(ZAZZAKS, 1)]);
    expect(ranking).toEqual({ top: e(ZAZZAKS, 1), alternatives: [] });
  });

  it("ranks count desc then itemId asc, sorting the input itself rather than trusting its order", () => {
    // Deliberately handed over in the WORST order: ascending count, and with
    // the higher id ahead of the lower one at the tied count.
    const ranking = rankSupportFinals([e(SOLSTICE_SLEIGH, 2), e(BLOODSONG, 2), e(ZAZZAKS, 9)]);
    expect(ranking?.top).toEqual(e(ZAZZAKS, 9));
    // 3871 Zaz'Zak's > tie between 3877 Bloodsong and 3876 Solstice Sleigh,
    // broken by itemId asc -> 3876 first.
    expect(ranking?.alternatives).toEqual([e(SOLSTICE_SLEIGH, 2), e(BLOODSONG, 2)]);
  });

  it("does not mutate the caller's array", () => {
    const input = [e(SOLSTICE_SLEIGH, 1), e(ZAZZAKS, 5)];
    const snapshot = input.map((x) => ({ ...x }));
    rankSupportFinals(input);
    expect(input).toEqual(snapshot);
  });

  it("applies no cap of its own — capping is the model boundary's job", () => {
    const all = ALL_SUPPORT_FINAL_IDS.map((id, i) => e(id, ALL_SUPPORT_FINAL_IDS.length - i));
    const ranking = rankSupportFinals(all);
    expect(1 + (ranking?.alternatives.length ?? 0)).toBe(ALL_SUPPORT_FINAL_IDS.length);
  });

  it("isSupportFinalItem recognises exactly the five finals and nothing adjacent in the quest chain", () => {
    for (const id of ALL_SUPPORT_FINAL_IDS) expect(isSupportFinalItem(id)).toBe(true);
    for (const id of [SUPPORT_STARTER_ID, SUPPORT_TIER2_ID, SUPPORT_QUEST_HUB_ID, ROCKETBELT, DARK_SEAL]) {
      expect(isSupportFinalItem(id)).toBe(false);
    }
  });
});

// ── v0.29.0: tree-conditioned rune page ─────────────────────────────────────

describe("aggregateProConsensus — tree conditioning (v0.29.0)", () => {
  // Sorcery page: Deathfire Touch keystone + Sorcery minors + Precision secondary.
  const sorceryGame = (overrides: Partial<ProGame> = {}) =>
    game({
      runes: {
        primaryTree: SORCERY,
        keystone: DEATHFIRE_TOUCH,
        primary: [MANAFLOW_BAND, CELERITY, TRANSCENDENCE],
        secondaryTree: PRECISION,
        secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE],
        shards: [],
      },
      ...overrides,
    });
  // Precision page: Press the Attack keystone + Precision minors + Sorcery
  // secondary. These are the games that leaked into the old flat aggregate:
  // their Precision minor Presence of Mind polluted the minors row, and their
  // Sorcery secondary (Manaflow/Celerity) duplicated the primary minors.
  const precisionGame = (overrides: Partial<ProGame> = {}) =>
    game({
      runes: {
        primaryTree: PRECISION,
        keystone: PRESS_THE_ATTACK,
        primary: [PRESENCE_OF_MIND, TRIUMPH, COUP_DE_GRACE],
        secondaryTree: SORCERY,
        secondary: [MANAFLOW_BAND, CELERITY],
        shards: [],
      },
      ...overrides,
    });

  it("reproduces the screenshot shape (16 Sorcery + 14 Precision) and shows ONLY the tree-A-conditioned page", () => {
    const games = [
      ...Array.from({ length: 16 }, () => sorceryGame()),
      ...Array.from({ length: 14 }, () => precisionGame()),
    ];
    const model = aggregateProConsensus(games, itemMeta());

    // Keystone stays modal over ALL keystone games — the honest 16/30.
    expect(model.keystone).toEqual({ keystoneId: DEATHFIRE_TOUCH, count: 16, share: 16 / 30 });
    expect(model.runesSampleSize).toBe(30);

    // Page conditioned on Sorcery (the modal keystone's tree).
    expect(model.primaryTree).toBe(SORCERY);
    expect(model.primaryTreeSampleSize).toBe(16);

    // Minors are ALL Sorcery — Presence of Mind (Precision) never leaks in.
    const minorIds = [...model.primaryMinors.entries.map((e) => e.runeId)].sort((a, b) => a - b);
    expect(minorIds).toEqual([TRANSCENDENCE, MANAFLOW_BAND, CELERITY].sort((a, b) => a - b));
    expect(minorIds).not.toContain(PRESENCE_OF_MIND);
    expect(model.primaryMinors.sampleSize).toBe(16);

    // Secondary is the modal non-primary tree (Precision), picks all Precision.
    expect(model.secondaryTree?.treeId).toBe(PRECISION);
    const pickIds = [...model.secondaryPicks.entries.map((e) => e.runeId)].sort((a, b) => a - b);
    expect(pickIds).toEqual([PRESENCE_OF_MIND, COUP_DE_GRACE].sort((a, b) => a - b));
    expect(model.secondaryPicks.sampleSize).toBe(16);
  });

  it("INVARIANT: no rune id appears in both primaryMinors and secondaryPicks", () => {
    const games = [
      ...Array.from({ length: 16 }, () => sorceryGame()),
      ...Array.from({ length: 14 }, () => precisionGame()),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    const minors = new Set(model.primaryMinors.entries.map((e) => e.runeId));
    const overlap = model.secondaryPicks.entries.filter((e) => minors.has(e.runeId));
    expect(overlap).toEqual([]);
  });

  it("INVARIANT: secondaryTree is never equal to primaryTree (impossible-in-game rows dropped)", () => {
    const games = [
      ...Array.from({ length: 3 }, () => sorceryGame()),
      // Contaminant: a Sorcery page whose secondaryTree is ALSO Sorcery — an
      // impossible in-game page. Must be excluded from the secondary sample.
      ...Array.from({ length: 2 }, () =>
        sorceryGame({
          runes: {
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND],
            secondaryTree: SORCERY,
            secondary: [CELERITY],
            shards: [],
          },
        })
      ),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.primaryTree).toBe(SORCERY);
    expect(model.secondaryTree?.treeId).toBe(PRECISION); // Sorcery-on-Sorcery rows dropped
    expect(model.secondaryTree?.treeId).not.toBe(model.primaryTree);
    expect(model.secondaryTreeSampleSize).toBe(3); // only the 3 Precision-secondary rows count
  });

  it("a game with a different-tree keystone contributes NOTHING to minors/secondary aggregation", () => {
    const games = [sorceryGame(), sorceryGame(), precisionGame()];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.primaryTree).toBe(SORCERY);
    expect(model.primaryTreeSampleSize).toBe(2); // the Precision game is excluded
    // Precision minors never appear.
    const minorIds = model.primaryMinors.entries.map((e) => e.runeId);
    expect(minorIds).not.toContain(PRESENCE_OF_MIND);
    expect(minorIds).not.toContain(TRIUMPH);
    // Secondary picks are the Sorcery games' Precision secondary — NOT the
    // excluded Precision game's Sorcery secondary (Manaflow/Celerity).
    const pickIds = model.secondaryPicks.entries.map((e) => e.runeId);
    expect(pickIds).not.toContain(MANAFLOW_BAND);
    expect(pickIds).not.toContain(CELERITY);
  });

  it("denominators equal the conditioned sample sizes, not gamesTotal", () => {
    const games = [
      ...Array.from({ length: 16 }, () => sorceryGame()),
      ...Array.from({ length: 14 }, () => precisionGame()),
    ];
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.gamesTotal).toBe(30);
    expect(model.primaryMinors.sampleSize).toBe(16);
    expect(model.secondaryTreeSampleSize).toBe(16);
    expect(model.secondaryPicks.sampleSize).toBe(16);
    // keystone denominator stays the FULL keystone sample (unchanged), not N_page.
    expect(model.runesSampleSize).toBe(30);
  });

  it("degrades to no rune page (null primaryTree, empty conditioned rows) when no game carries tree data", () => {
    const games = [game({ runes: { ...NO_RUNES, keystone: DEATHFIRE_TOUCH } })]; // keystone but no primaryTree
    const model = aggregateProConsensus(games, itemMeta());
    expect(model.keystone?.keystoneId).toBe(DEATHFIRE_TOUCH); // keystone still shows
    expect(model.primaryTree).toBeNull();
    expect(model.primaryMinors.entries).toEqual([]);
    expect(model.secondaryTree).toBeNull();
    expect(model.secondaryPicks.entries).toEqual([]);
  });

  // ── v0.29.1 (Fable review 2026-07-17, P3): fallback-tree/keystone guard ──
  // Exact degraded shape from the bug report: every game carrying the modal
  // keystone has primaryTree:0 (Leaguepedia resolved KeystoneRune but not
  // PrimaryTree), so resolvePrimaryTree falls back to the sample-wide modal
  // tree — which here belongs entirely to a DIFFERENT keystone's games.
  // Without the guard, the keystone tile would show the ORIGINAL modal
  // keystone (Deathfire Touch) above a Precision-tree page (Press the
  // Attack's minors/secondary) it never ran with — the "impossible page".

  it("drops the keystone to the fallback tree's own modal keystone when the fallback tree's games don't run the original modal keystone (case a)", () => {
    const games = [
      // Modal keystone (5 games) — every one has an UNRESOLVED primaryTree.
      ...Array.from({ length: 5 }, () => game({ runes: { ...NO_RUNES, keystone: DEATHFIRE_TOUCH } })),
      // A different keystone's games (3) — these are the ONLY games with a
      // resolved primaryTree, so resolvePrimaryTree's fallback lands here.
      ...Array.from({ length: 3 }, () =>
        game({
          runes: {
            primaryTree: PRECISION,
            keystone: PRESS_THE_ATTACK,
            primary: [PRESENCE_OF_MIND, TRIUMPH, COUP_DE_GRACE],
            secondaryTree: 0,
            secondary: [],
            shards: [],
          },
        })
      ),
    ];
    const model = aggregateProConsensus(games, itemMeta());

    // Without the guard this would be { keystoneId: DEATHFIRE_TOUCH, count: 5,
    // share: 5/8 } paired with the Precision page below — an impossible page.
    expect(model.keystone).toEqual({ keystoneId: PRESS_THE_ATTACK, count: 3, share: 1 });
    expect(model.runesSampleSize).toBe(3); // scoped to the page it actually describes, not gamesTotal's 8

    expect(model.primaryTree).toBe(PRECISION);
    expect(model.primaryTreeSampleSize).toBe(3);
    const minorIds = model.primaryMinors.entries.map((e) => e.runeId).sort((a, b) => a - b);
    expect(minorIds).toEqual([PRESENCE_OF_MIND, TRIUMPH, COUP_DE_GRACE].sort((a, b) => a - b));
    // Deathfire Touch's tree never leaks in — there IS no Deathfire-tree data
    // in this fixture, so this is really just confirming the page is 100%
    // Precision, consistent with the (now-corrected) keystone tile.
  });

  it("degrades to tree-less (keeps the honest global keystone, drops the page) when the fallback tree's games have no resolved keystone either (case b)", () => {
    const games = [
      // Modal keystone (5 games) — every one has an UNRESOLVED primaryTree.
      ...Array.from({ length: 5 }, () => game({ runes: { ...NO_RUNES, keystone: DEATHFIRE_TOUCH } })),
      // The only games with a resolved primaryTree — but THEIR keystone is
      // also unresolved, so there's nothing honest to pair the page with.
      ...Array.from({ length: 3 }, () => game({ runes: { ...NO_RUNES, primaryTree: PRECISION } })),
    ];
    const model = aggregateProConsensus(games, itemMeta());

    // Keystone tile keeps the honest global fraction (unchanged, no page paired with it).
    expect(model.keystone).toEqual({ keystoneId: DEATHFIRE_TOUCH, count: 5, share: 1 });
    expect(model.runesSampleSize).toBe(5);

    // No coherent page to show — same shape as the "no tree data at all" degraded pattern above.
    expect(model.primaryTree).toBeNull();
    expect(model.primaryTreeSampleSize).toBe(0);
    expect(model.primaryMinors.entries).toEqual([]);
    expect(model.secondaryTree).toBeNull();
    expect(model.secondaryPicks.entries).toEqual([]);
  });
});

describe("resolvePrimaryTree", () => {
  it("prefers the tree the modal keystone actually ran under", () => {
    const games = [
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH } }),
      game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH } }),
      game({ runes: { ...NO_RUNES, primaryTree: PRECISION, keystone: PRESS_THE_ATTACK } }),
    ];
    expect(resolvePrimaryTree(games, DEATHFIRE_TOUCH)).toBe(SORCERY);
  });

  it("falls back to the sample-wide modal primary tree when the modal keystone's games lack tree data", () => {
    const games = [
      game({ runes: { ...NO_RUNES, keystone: DEATHFIRE_TOUCH } }), // keystone but primaryTree 0
      game({ runes: { ...NO_RUNES, primaryTree: PRECISION } }),
      game({ runes: { ...NO_RUNES, primaryTree: PRECISION } }),
    ];
    expect(resolvePrimaryTree(games, DEATHFIRE_TOUCH)).toBe(PRECISION);
  });

  it("returns 0 when no game carries any primary tree data", () => {
    const games = [game({ runes: NO_RUNES }), game({ runes: NO_RUNES })];
    expect(resolvePrimaryTree(games, 0)).toBe(0);
  });
});

describe("formatSharePct", () => {
  it("rounds to a whole-percent string", () => {
    expect(formatSharePct(35 / 39)).toBe("90%");
    expect(formatSharePct(11 / 39)).toBe("28%");
    expect(formatSharePct(1)).toBe("100%");
    expect(formatSharePct(0)).toBe("0%");
  });
});

// ── 2026-07-22: manual "push the pro-consensus page" ────────────────────────
// missingRunePageReason / proConsensusRuneApplyInput — the pure translation
// from ProConsensusModel into the SAME RunesBlock shape runeApplyBody.ts's
// buildRuneApplyBody() consumes, feeding the Pro Consensus card's new
// "Apply pro runes" button.
describe("proConsensus.ts — pro-consensus rune-apply input (2026-07-22)", () => {
  const fallbackShards: ShardSet = {
    offense: { id: 5008, name: "Adaptive Force", icon: "", wpa: 0, winrate: null, occurrence: 0 },
    flex: { id: 5010, name: "Move Speed", icon: "", wpa: 0, winrate: null, occurrence: 0 },
    defense: { id: 5011, name: "Health", icon: "", wpa: 0, winrate: null, occurrence: 0 },
  };

  // A complete, SLOT-coherent Sorcery page: keystone + one minor per row
  // (MANAFLOW_BAND row0, TRANSCENDENCE row1, SCORCH row2) + Precision secondary
  // with 2 picks from 2 different rows (PRESENCE_OF_MIND secRow0, COUP_DE_GRACE
  // secRow2). soloq source (game()'s default), so the 3 minors are read
  // positionally as rows 0/1/2.
  const completePageGame = (overrides: Partial<ProGame> = {}) =>
    game({
      runes: {
        primaryTree: SORCERY,
        keystone: DEATHFIRE_TOUCH,
        primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH],
        secondaryTree: PRECISION,
        secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE],
        shards: [],
      },
      ...overrides,
    });

  function completeModel() {
    const games = Array.from({ length: 20 }, () => completePageGame());
    return aggregateProConsensus(games, itemMeta());
  }

  describe("missingRunePageReason", () => {
    it("is null for a complete page (keystone + 3 minors + secondary tree + 2 picks)", () => {
      expect(missingRunePageReason(completeModel())).toBeNull();
    });

    it("flags a sample with no resolved keystone", () => {
      const model = aggregateProConsensus([game({ runes: NO_RUNES })], itemMeta());
      expect(missingRunePageReason(model)).toMatch(/keystone/i);
    });

    it("flags fewer than 3 primary minors", () => {
      const games = Array.from({ length: 5 }, () =>
        game({
          runes: {
            ...NO_RUNES,
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND], // only 1, needs 3
            secondaryTree: PRECISION,
            secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE],
          },
        })
      );
      const model = aggregateProConsensus(games, itemMeta());
      expect(missingRunePageReason(model)).toMatch(/primary/i);
    });

    it("flags a sample with no resolved secondary tree", () => {
      const games = Array.from({ length: 5 }, () =>
        game({
          runes: {
            ...NO_RUNES,
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH],
            secondaryTree: 0,
            secondary: [],
          },
        })
      );
      const model = aggregateProConsensus(games, itemMeta());
      expect(missingRunePageReason(model)).toMatch(/secondary/i);
    });

    it("flags fewer than 2 secondary picks", () => {
      const games = Array.from({ length: 5 }, () =>
        game({
          runes: {
            ...NO_RUNES,
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH],
            secondaryTree: PRECISION,
            secondary: [PRESENCE_OF_MIND], // only 1, needs 2
          },
        })
      );
      const model = aggregateProConsensus(games, itemMeta());
      expect(missingRunePageReason(model)).toMatch(/secondary/i);
    });
  });

  describe("proConsensusRuneApplyInput", () => {
    it("returns null (never fabricates a slot) when the page is incomplete", () => {
      const model = aggregateProConsensus([], itemMeta());
      expect(proConsensusRuneApplyInput(model, fallbackShards)).toBeNull();
    });

    it("builds a RunesBlock whose buildRuneApplyBody() output is the correct 9-slot id order: keystone, 3 primary, 2 secondary, 3 shards", () => {
      const model = completeModel();
      const result = proConsensusRuneApplyInput(model, fallbackShards);
      expect(result).not.toBeNull();

      // ProConsensusCard applies with pageSuffix:"Pro" so the pro page is a
      // SEPARATE LCU page from the WPA auto-export's — the two coexist instead
      // of one reverting the other (companion 1.6.3).
      const body = buildRuneApplyBody("Viktor", "Mid", result!.runes, { pageSuffix: "Pro" });
      // SLOT-COHERENT + ROW-ORDERED (2026-07-22): primary minors are emitted in
      // perkstyles row order — MANAFLOW_BAND (row0), TRANSCENDENCE (row1), SCORCH
      // (row2) — NOT frequency order, so no two ids can share a slot. Secondary
      // picks are the 2 most-adopted secondary rows in ascending row order:
      // PRESENCE_OF_MIND (Precision secRow0), COUP_DE_GRACE (Precision secRow2).
      expect(body.selectedPerkIds).toEqual([
        DEATHFIRE_TOUCH,
        MANAFLOW_BAND,
        TRANSCENDENCE,
        SCORCH,
        PRESENCE_OF_MIND,
        COUP_DE_GRACE,
        5008,
        5010,
        5011,
      ]);
      expect(body.primaryStyleId).toBe(SORCERY);
      expect(body.subStyleId).toBe(PRECISION);
      // The Pro page has its OWN distinct title ("... Pro", suffix AFTER
      // champ/role) so the WPA page ("CoachBuild Viktor Mid") is never
      // overwritten by the pro apply, while the champ-scoped replacePrefix
      // ("CoachBuild Viktor ") still matches BOTH pages for champ-change cleanup.
      expect(body.name).toBe("CoachBuild Viktor Mid Pro");
      expect(body.replacePrefix).toBe("CoachBuild Viktor ");
      // The WPA variant (no suffix) keeps its own title, distinct from the Pro one.
      expect(buildRuneApplyBody("Viktor", "Mid", result!.runes).name).toBe("CoachBuild Viktor Mid");
    });

    it("falls back to the caller's fallbackShards and flags shardsFromFallback when the sample has NO positional shard data (completePageGame's games all carry shards:[])", () => {
      const model = completeModel();
      expect(model.shardPage).toEqual({ offense: null, flex: null, defense: null });
      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      expect(result.shardsFromFallback).toBe(true);
      // Value-equal (not reference-equal — each slot is now individually
      // resolved, so the ShardSet is a freshly built object even when every
      // slot ends up sourcing from fallbackShards).
      expect(result.runes.shards).toEqual(fallbackShards);
    });

    it("per-row modal + row order: primary picks are one-per-row, in row order, never frequency order", () => {
      // A soloq sample split WITHIN row0 while row1/row2 are stable — the exact
      // shape the old flat top-3 broke on. soloq primary[] is read positionally
      // (rows 0/1/2), so:
      //   row0: MANAFLOW_BAND x2 vs NULLIFYING_ORB x1  -> MANAFLOW_BAND
      //   row1: TRANSCENDENCE x3                       -> TRANSCENDENCE
      //   row2: SCORCH x3                              -> SCORCH
      const NULLIFYING_ORB = 8224; // Sorcery row0 (alternative to MANAFLOW_BAND)
      const games = [
        game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] } }),
        game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] } }),
        game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [NULLIFYING_ORB, TRANSCENDENCE, SCORCH], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] } }),
      ];
      const model = aggregateProConsensus(games, itemMeta());
      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      // Row-ordered, one per row — NULLIFYING_ORB (the row0 minority) is dropped
      // in favor of the row0 modal, and no row is ever doubled or skipped.
      expect(result.runes.primary.map((p) => p.id)).toEqual([MANAFLOW_BAND, TRANSCENDENCE, SCORCH]);
      const rows = model.runePage.primaryRows.map((r) => r?.runeId);
      expect(rows).toEqual([MANAFLOW_BAND, TRANSCENDENCE, SCORCH]);
    });
  });

  // ── Per-slot PRO shards, not WPA fallback shards (2026-07-24 fix) ──────────
  // USER BUG (Senna Pro page): the pro consensus for Senna's offense slot IS
  // Attack Speed, but "Apply pro runes" wrote the WPA build's shard
  // (Adaptive Force) instead — proConsensusRuneApplyInput always used
  // fallbackShards wholesale. Fix: model.shardPage resolves each of the 3
  // positional rows (game.runes.shards[0/1/2]) independently via a per-slot
  // modal, and proConsensusRuneApplyInput now sources each slot from it.
  describe("per-slot pro shards (2026-07-24 fix)", () => {
    const ATTACK_SPEED = 5005;
    const ADAPTIVE_FORCE = 5008;
    const MOVE_SPEED = 5010;
    const HEALTH = 5011;
    const ABILITY_HASTE = 5007;
    const TENACITY = 5013;

    it("Senna acceptance pin: offense pro shard is Attack Speed (soloq modal), NOT the WPA fallback's Adaptive Force", () => {
      const games = Array.from({ length: 10 }, () =>
        completePageGame({
          runes: {
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH],
            secondaryTree: PRECISION,
            secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE],
            shards: [ATTACK_SPEED, MOVE_SPEED, HEALTH],
          },
        })
      );
      const model = aggregateProConsensus(games, itemMeta());
      expect(model.shardPage.offense).toMatchObject({ runeId: ATTACK_SPEED, count: 10, sampleSize: 10 });
      expect(model.shardPage.flex).toMatchObject({ runeId: MOVE_SPEED });
      expect(model.shardPage.defense).toMatchObject({ runeId: HEALTH });

      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      expect(result.runes.shards.offense.id).toBe(ATTACK_SPEED);
      expect(result.runes.shards.offense.id).not.toBe(fallbackShards.offense.id); // not Adaptive Force
      expect(result.runes.shards.flex.id).toBe(MOVE_SPEED);
      expect(result.runes.shards.defense.id).toBe(HEALTH);
      expect(result.shardsFromFallback).toBe(false); // real pro data drove every slot

      const body = buildRuneApplyBody("Senna", "Support", result.runes);
      expect(body.selectedPerkIds.slice(6)).toEqual([ATTACK_SPEED, MOVE_SPEED, HEALTH]);
    });

    it("per-slot MAJORITY wins on a split soloq sample (2 Attack Speed vs 1 Ability Haste at offense)", () => {
      const mk = (offense: number) =>
        completePageGame({
          runes: {
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH],
            secondaryTree: PRECISION,
            secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE],
            shards: [offense, MOVE_SPEED, HEALTH],
          },
        });
      const model = aggregateProConsensus([mk(ATTACK_SPEED), mk(ATTACK_SPEED), mk(ABILITY_HASTE)], itemMeta());
      expect(model.shardPage.offense).toMatchObject({ runeId: ATTACK_SPEED, count: 2, sampleSize: 3 });
    });

    it("falls back to fallbackShards (all 3 slots) and flags shardsFromFallback ONLY when NO game has positional shard data (all-prostage sample)", () => {
      const games = Array.from({ length: 5 }, () =>
        completePageGame({ source: "prostage", tournament: "MSI", runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE], shards: [] } })
      );
      const model = aggregateProConsensus(games, itemMeta());
      expect(model.shardPage).toEqual({ offense: null, flex: null, defense: null });
      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      expect(result.shardsFromFallback).toBe(true);
      expect(result.runes.shards).toEqual(fallbackShards);
    });

    it("an id invalid for a slot (e.g. Health at the offense position) is never crowned that slot's pro pick — falls back for THAT slot only, other slots stay pro", () => {
      // Corrupted/misaligned offense position (5011 Health belongs to
      // defense, not offense) — OFFENSE_SHARD_IDS excludes it, so the
      // offense slot resolves null and falls back individually while
      // flex/defense (both valid) still resolve from pro data.
      const games = Array.from({ length: 5 }, () =>
        completePageGame({
          runes: {
            primaryTree: SORCERY,
            keystone: DEATHFIRE_TOUCH,
            primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH],
            secondaryTree: PRECISION,
            secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE],
            shards: [HEALTH, MOVE_SPEED, TENACITY],
          },
        })
      );
      const model = aggregateProConsensus(games, itemMeta());
      expect(model.shardPage.offense).toBeNull(); // invalid id, never counted
      expect(model.shardPage.flex).toMatchObject({ runeId: MOVE_SPEED });
      expect(model.shardPage.defense).toMatchObject({ runeId: TENACITY });

      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      expect(result.runes.shards.offense.id).toBe(fallbackShards.offense.id); // per-slot fallback
      expect(result.runes.shards.flex.id).toBe(MOVE_SPEED); // pro data, unaffected
      expect(result.runes.shards.defense.id).toBe(TENACITY); // pro data, unaffected
      expect(result.shardsFromFallback).toBe(false); // NOT the all-fallback case — 2 of 3 slots are real pro data
    });
  });

  // ── Slot coherence, validated against the real perkstyles map ──────────────
  // The root-cause guard: every applied page must be a LEGAL LCU page — one
  // rune per slot, each id valid for its slot. This is the invariant the flat
  // top-N assembly broke (live "Ashe Bot Pro" empty-slots report).
  describe("slot coherence — perkstyles-validated (2026-07-22 fix)", () => {
    /** Asserts the 6 rune ids of an assembled apply body form a legal page:
     *  keystone valid for the primary tree, one primary minor per row in row
     *  order, 2 secondary picks from 2 DIFFERENT rows ascending, no dup id. */
    function assertSlotCoherent(perkIds: number[], primaryStyleId: number, subStyleId: number) {
      const [ks, m0, m1, m2, s0, s1] = perkIds;
      expect(isKeystoneOf(primaryStyleId, ks)).toBe(true);
      expect(primaryMinorRow(primaryStyleId, m0)).toBe(0);
      expect(primaryMinorRow(primaryStyleId, m1)).toBe(1);
      expect(primaryMinorRow(primaryStyleId, m2)).toBe(2);
      const sr0 = primaryMinorRow(subStyleId, s0);
      const sr1 = primaryMinorRow(subStyleId, s1);
      expect(sr0).not.toBeNull();
      expect(sr1).not.toBeNull();
      expect(sr0 as number).toBeLessThan(sr1 as number);
      expect(new Set(perkIds.slice(0, 6)).size).toBe(6); // no id shared across slots
    }

    it("a complete consensus builds a page valid for every perkstyles slot", () => {
      const result = proConsensusRuneApplyInput(completeModel(), fallbackShards)!;
      const body = buildRuneApplyBody("Viktor", "Mid", result.runes);
      assertSlotCoherent(body.selectedPerkIds, body.primaryStyleId, body.subStyleId);
    });

    it("a thin 1-game consensus still yields a COMPLETE valid page (filled from the one real game, never empty slots)", () => {
      const model = aggregateProConsensus([completePageGame()], itemMeta());
      expect(model.gamesTotal).toBe(1);
      expect(missingRunePageReason(model)).toBeNull(); // button stays usable on thin data
      expect(model.runePage.primaryRows.every((r) => r !== null)).toBe(true);
      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      const body = buildRuneApplyBody("Ashe", "Bot", result.runes);
      assertSlotCoherent(body.selectedPerkIds, body.primaryStyleId, body.subStyleId);
    });

    it("prostage sample colliding on one row resolves via perkstyles — no two ids share a slot (the Ashe-bot repro class)", () => {
      // prostage primary[] is NOT row-ordered (Leaguepedia buckets by tree), so
      // ids are resolved by the perkstyles MAP, not position. Two of three games
      // disagree on row0 while row1/row2 are stable — the exact shape a naive
      // flat top-3 could collide on (two row0 runes, row2 dropped).
      const NULLIFYING_ORB = 8224; // Sorcery row0 (alternative to MANAFLOW_BAND)
      const pg = (primary: number[]) =>
        game({
          source: "prostage",
          tournament: "LCK",
          runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary, secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] },
        });
      const model = aggregateProConsensus(
        [pg([NULLIFYING_ORB, TRANSCENDENCE, SCORCH]), pg([MANAFLOW_BAND, TRANSCENDENCE, SCORCH]), pg([MANAFLOW_BAND, TRANSCENDENCE, SCORCH])],
        itemMeta()
      );
      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      const body = buildRuneApplyBody("Viktor", "Mid", result.runes);
      assertSlotCoherent(body.selectedPerkIds, body.primaryStyleId, body.subStyleId);
      // row0 modal wins (MANAFLOW_BAND x2 > NULLIFYING_ORB x1); no row doubled/skipped.
      expect(result.runes.primary.map((p) => p.id)).toEqual([MANAFLOW_BAND, TRANSCENDENCE, SCORCH]);
    });

    it("missingRunePageReason fires ONLY when a slot is truly uncoverable (row2 absent from EVERY sampled game)", () => {
      // Every prostage game maps rows 0 and 1 but never row2 -> genuinely
      // uncoverable (no game supplies it, so no 'modal game' could either) ->
      // disable, never write an empty slot.
      const pg = game({
        source: "prostage",
        tournament: "LEC",
        runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, TRANSCENDENCE], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] },
      });
      const model = aggregateProConsensus([pg, pg, pg], itemMeta());
      expect(model.runePage.primaryRows[2]).toBeNull();
      expect(missingRunePageReason(model)).toMatch(/primary/i);
      expect(proConsensusRuneApplyInput(model, fallbackShards)).toBeNull();
    });

    it("a full page IS resolvable when different games cover different rows (cross-game fill, not one perfect game)", () => {
      // No single game has all 3 rows, but the per-row modal stitches a complete
      // page across the sample — the 'fill from real games' behavior, done at
      // the row level. Game A misses row2, game B misses row1; together all 3
      // rows resolve.
      const gA = game({ source: "prostage", tournament: "LCK", runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, TRANSCENDENCE], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] } });
      const gB = game({ source: "prostage", tournament: "LCK", runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, SCORCH], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, COUP_DE_GRACE] } });
      const model = aggregateProConsensus([gA, gA, gB, gB], itemMeta());
      expect(missingRunePageReason(model)).toBeNull();
      const result = proConsensusRuneApplyInput(model, fallbackShards)!;
      expect(result.runes.primary.map((p) => p.id)).toEqual([MANAFLOW_BAND, TRANSCENDENCE, SCORCH]);
    });

    it("secondary collision: two picks from the SAME secondary row never masquerade as a valid pair", () => {
      // Both secondary picks map to Precision secRow0 (8009 and 9101) -> only 1
      // distinct secondary row -> incomplete -> disabled.
      const ABSORB_LIFE = 9101; // Precision row0 (same row as PRESENCE_OF_MIND 8009)
      const pg = game({ runes: { ...NO_RUNES, primaryTree: SORCERY, keystone: DEATHFIRE_TOUCH, primary: [MANAFLOW_BAND, TRANSCENDENCE, SCORCH], secondaryTree: PRECISION, secondary: [PRESENCE_OF_MIND, ABSORB_LIFE] } });
      const model = aggregateProConsensus([pg, pg, pg], itemMeta());
      expect(model.runePage.secondaryRows.filter((r) => r !== null).length).toBe(1);
      expect(missingRunePageReason(model)).toMatch(/secondary/i);
      expect(proConsensusRuneApplyInput(model, fallbackShards)).toBeNull();
    });
  });
});
