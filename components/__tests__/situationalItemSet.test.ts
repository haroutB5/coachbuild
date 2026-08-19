/**
 * situationalItemSet — the SITUATIONAL panel reaching the in-game shop
 * (2026-08-19 user directive: "i want you to also add the situational items
 * shown here into the in game item list as well as another item set").
 *
 * THE FIXTURE IS REAL DATA, NOT AN INVENTION. `GALIO_MID` below is the verbatim
 * `items` block of `GET /api/build?champ=3&role=2` on production, patch 16.16,
 * captured 2026-08-19 — the exact champion+lane in the user's screenshot,
 * identified by scanning all 173 champions x 5 lanes for the screenshot's own
 * delta signature (+4.27 / +2.79 / +1.13 / +0.45 / +0.39 / -0.06) and matching
 * exactly one combo. Every numeric item id in it is the id the LIVE API
 * returned, so this file also serves as the id proof for the six items in the
 * screenshot. Do not "tidy" the numbers.
 *
 * Why that matters: a fixture I wrote by hand could agree with the code and
 * both be wrong about the shape of `items.alts`. This one cannot — it came off
 * the wire.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildItemSets,
  situationalBlockPicks,
  situationalBlocks,
  champScopedReplacePrefix,
} from "../hextech/itemSetBody";
import { wpaText } from "../StatBadge";
import {
  flattenSituational,
  situationalShortlist,
  SITUATIONAL_DISPLAY_LIMIT,
} from "../hextech/situational";
import type { ChampionRef, BuildResponse, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";

// ── The six items in the screenshot, with the ids the live catalog resolves ──
// Proven against https://cdn.coachless.gg/static-files/16.16.1/16.16.1/data/
// en_US/item.json (868 entries) on 2026-08-19. Recorded as a table because
// every one of these names ALSO exists at a 22xxxx id (ARAM) and most at a
// 77xxxx id (Arena) — resolving a situational item BY NAME would pick whichever
// row came first and could ship an item that does not exist on Summoner's Rift.
// The builder never matches on name; `items.alts` already carries ids. This
// table exists so the assertion that it carries the RIGHT ones is explicit.
const SCREENSHOT_ITEMS = [
  { id: 3158, name: "Ionian Boots of Lucidity", wpa: 4.27, boots: true, aramId: 223158 },
  { id: 3009, name: "Boots of Swiftness", wpa: 2.79, boots: true, aramId: 223009 },
  { id: 3047, name: "Plated Steelcaps", wpa: 1.13, boots: true, aramId: 223047 },
  { id: 4645, name: "Shadowflame", wpa: 0.45, boots: false, aramId: 224645 },
  { id: 4646, name: "Stormsurge", wpa: 0.39, boots: false, aramId: 224646 },
  { id: 3068, name: "Sunfire Aegis", wpa: -0.06, boots: false, aramId: 223068 },
] as const;

function p(id: number, name: string, wpa: number, occurrence = 1000, lowSample = false): Pick {
  return { id, name, icon: `i-${id}`, wpa, winrate: 50, occurrence, ...(lowSample ? { lowSample } : {}) };
}

/** Verbatim prod capture, Galio mid, patch 16.16, 2026-08-19. */
function galioMidItems(): ItemsBlock {
  return {
    starter: p(1056, "Doran's Ring", 0),
    boots: p(3020, "Sorcerer's Shoes", 1.56),
    first: p(8020, "Abyssal Mask", 1.37),
    second: p(4633, "Riftmaker", 0.96),
    third: p(3157, "Zhonya's Hourglass", 0.0),
    fourthPlus: [p(3143, "Randuin's Omen", 6.43), p(3152, "Hextech Rocketbelt", 1.64)],
    alts: {
      // Slot provenance preserved exactly as the API returns it: three boots
      // alternatives, then the legendary-slot alternatives.
      boots: [
        p(3158, "Ionian Boots of Lucidity", 4.27, 530, true),
        p(3009, "Boots of Swiftness", 2.79, 462, true),
        p(3047, "Plated Steelcaps", 1.13, 4985),
      ],
      first: [p(4645, "Shadowflame", 0.45, 828, true), p(6664, "Hollow Radiance", -1.21, 6055)],
      second: [p(4646, "Stormsurge", 0.39, 1207), p(3068, "Sunfire Aegis", -0.06, 451, true)],
    },
  };
}

const GALIO: ChampionRef = { id: 3, key: "Galio", name: "Galio", icon: "galio.png" };

function fullMeta(id: number, boots = false): ItemDetail {
  return {
    id,
    name: `Item ${id}`,
    goldTotal: 3000,
    descriptionText: "",
    into: boots ? ["900000"] : [],
    from: ["1001"],
    tags: boots ? ["Boots"] : [],
    purchasable: true,
  };
}

function galioMeta(): Map<number, ItemDetail> {
  const ids: [number, boolean][] = [
    [1056, false], [3020, true], [8020, false], [4633, false], [3157, false],
    [3143, false], [3152, false], [3158, true], [3009, true], [3047, true],
    [4645, false], [4646, false], [3068, false], [6664, false],
  ];
  return new Map(ids.map(([id, b]) => [id, fullMeta(id, b)]));
}

function runes(): RunesBlock {
  return {
    primaryTree: { id: 8400, name: "Resolve", icon: "t8400" },
    secondaryTree: { id: 8000, name: "Precision", icon: "t8000" },
    keystone: p(8437, "Grasp", 0),
    primary: [p(8446, "a", 0), p(8429, "b", 0), p(8451, "c", 0)],
    secondary: [p(9111, "d", 0), p(8014, "e", 0)],
    shards: { offense: p(5008, "o", 0), flex: p(5008, "f", 0), defense: p(5002, "d", 0) },
  };
}

function galioBuild(items: ItemsBlock = galioMidItems()): BuildResponse {
  return {
    champion: GALIO,
    role: 2,
    roleLabel: "Mid",
    patch: "16.16",
    tierLabel: "Diamond+",
    runes: runes(),
    spells: [p(4, "Flash", 0), p(14, "Ignite", 0)],
    items,
    generatedAt: new Date().toISOString(),
    sources: { provider: "coachless.gg" },
  };
}

const block = (set: { blocks: { type: string; items: { id: string; count: number }[] }[] }, type: string) =>
  set.blocks.find((b) => b.type === type);
const idsOf = (b: { items: { id: string }[] } | undefined) => (b?.items ?? []).map((i) => Number(i.id));

// ── Situational is now one block PER ITEM, titled with that item's delta ────
// (2026-08-19, "is there a way to show the wpa values in game so i can make
// better decisions on what to buy?"). A block's title is the only writable
// string anywhere near an item, so binding a number to an item means one block
// per item. These helpers read the row back across however many blocks it took.
type TestBlock = { type: string; items: { id: string; count: number }[] };
const isSituational = (b: TestBlock) => b.type === "Situational" || b.type.startsWith("Situational ");
const situationalBlocksOf = (set: { blocks: TestBlock[] }) => set.blocks.filter(isSituational);
const situationalIds = (set: { blocks: TestBlock[] }) =>
  situationalBlocksOf(set).flatMap((b) => b.items.map((i) => Number(i.id)));
const situationalEntries = (set: { blocks: TestBlock[] }) =>
  situationalBlocksOf(set).flatMap((b) => b.items);

// ── A stand-in for the user's real Config\ItemSets.json ─────────────────────
// SHAPE TAKEN FROM THE REAL FILE, VALUES NOT. Read on 2026-08-19 from
// C:\Riot Games\League of Legends\Config\ItemSets.json (59,622 bytes, md5
// 46db31f3…, 61 sets, unmodified since 2026-08-11): top-level keys
// {accountId, itemSets, timestamp}; per-set keys {associatedChampions,
// associatedMaps, blocks, map, mode, preferredItemSlots, sortrank,
// startedFrom, title, type, uid}; per-block keys {hideIfSummonerSpell, items,
// showIfSummonerSpell, type}; per-item keys {count, id}. `startedFrom` and the
// two summoner-spell fields are the client's OWN additions — it rewrote our
// set with them — which is why they are here: a fixture missing them would
// pass a merge that dropped them.
//
// The values are synthetic on purpose. The real file carries the user's
// accountId, and a test fixture is not the place for it. The real file itself
// IS run through this same merge, outside the suite — see
// HANDOFF-core-stale-webview.md for that measurement.
const REAL_SET_KEYS = [
  "associatedChampions", "associatedMaps", "blocks", "map", "mode",
  "preferredItemSlots", "sortrank", "startedFrom", "title", "type", "uid",
] as const;
type RealSet = Record<string, unknown> & { title?: string };
type RealItemSetsFile = { accountId: number; timestamp: number; itemSets: RealSet[] };

/** The set title web 0.112.0 wrote and the user rejected. */
const ORPHAN_TITLE = "CoachBuild Galio Mid Situational";

const UGG_BLOCK_TITLES = [
  "Starting Items", "Core Items", "Fourth Item Options", "Fifth Item Options", "Sixth Item Options",
];

function foreignSet(index: number, title: string): RealSet {
  return {
    associatedChampions: [100 + index],
    associatedMaps: [11],
    blocks: UGG_BLOCK_TITLES.map((type, b) => ({
      hideIfSummonerSpell: "",
      items: [{ count: 1, id: String(3000 + index * 10 + b) }],
      showIfSummonerSpell: "",
      type,
    })),
    map: "any",
    mode: "any",
    preferredItemSlots: [],
    sortrank: 0,
    startedFrom: "blank",
    title,
    type: "custom",
    uid: `foreign-${index}`,
  };
}

/** 61 sets: 59 U.GG + 1 hand-made + the ONE CoachBuild set an existing install
 *  already has (`CoachBuild Urgot Top`, present verbatim in the real file). */
function realItemSetsFile(): RealItemSetsFile {
  const itemSets: RealSet[] = [];
  for (let i = 0; i < 59; i++) itemSets.push(foreignSet(i, i === 7 ? "U.GG - Galio" : `U.GG - Champ${i}`));
  itemSets.push(foreignSet(59, "AP"));
  itemSets.push({ ...foreignSet(60, "CoachBuild Urgot Top"), uid: "coachbuild-urgot-top" });
  return { accountId: 1234567890, timestamp: 1755000000000, itemSets };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the ItemSets.json stand-in matches the real file's shape", () => {
  it("carries every key the real client writes, on every level", () => {
    // Without this the fixture could quietly drift into a simpler shape than
    // the client actually produces, and the merge tests below would be proving
    // something about a document nobody has.
    const file = realItemSetsFile();
    expect(Object.keys(file).sort()).toEqual(["accountId", "itemSets", "timestamp"]);
    expect(file.itemSets).toHaveLength(61);
    for (const s of file.itemSets) {
      expect(Object.keys(s).sort()).toEqual([...REAL_SET_KEYS].sort());
      for (const b of s.blocks as { [k: string]: unknown }[]) {
        expect(Object.keys(b).sort()).toEqual(["hideIfSummonerSpell", "items", "showIfSummonerSpell", "type"]);
        for (const i of b.items as object[]) expect(Object.keys(i).sort()).toEqual(["count", "id"]);
      }
    }
    // Exactly one CoachBuild set to start with — the pre-upgrade state.
    expect(file.itemSets.filter((s) => String(s.title).startsWith("CoachBuild"))).toHaveLength(1);
  });
});

describe("situational — the ids in the screenshot", () => {
  it("every screenshot item resolves to its Summoner's Rift id, not an alt-map twin", () => {
    const sit = situationalBlockPicks(galioMidItems());
    expect(sit.map((x) => x.id)).toEqual(SCREENSHOT_ITEMS.map((x) => x.id));
    expect(sit.map((x) => x.name)).toEqual(SCREENSHOT_ITEMS.map((x) => x.name));
    for (const item of SCREENSHOT_ITEMS) {
      // The ARAM/Arena twin shares the NAME and would be a silently wrong buy.
      expect(sit.map((x) => x.id)).not.toContain(item.aramId);
      expect(item.id).toBeLessThan(10000);
    }
  });

  it("the emitted blocks carry those ids as STRINGS with count 1 (LCU item-set schema)", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    expect(situationalEntries(sets[0])).toEqual(
      SCREENSHOT_ITEMS.map((x) => ({ id: String(x.id), count: 1 }))
    );
    for (const entry of situationalEntries(sets[0])) {
      expect(typeof entry.id).toBe("string");
      expect(entry.count).toBe(1);
    }
  });

  it("each screenshot item gets its OWN block, titled with the delta the panel prints", () => {
    // The whole point of the 2026-08-19 titling change: the shop can now say
    // WHICH item is worth +4.27 and which is worth -0.06. An LCU block item is
    // {id, count} — the block title is the only place a number can live, so
    // one item per block is the only shape that binds them.
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const blocks = situationalBlocksOf(sets[0]);
    expect(blocks).toHaveLength(SCREENSHOT_ITEMS.length);
    expect(blocks.map((b) => b.type)).toEqual([
      "Situational +4.27",
      "Situational +2.79",
      "Situational +1.13",
      "Situational +0.45",
      "Situational +0.39",
      "Situational -0.06",
    ]);
    for (const b of blocks) expect(b.items).toHaveLength(1);
  });

  it("prints the number through the Builds page's OWN formatter, not a second toFixed", () => {
    // Two surfaces formatting the same field with two formatters is how they
    // end up disagreeing at a rounding boundary. SituationalCard renders
    // wpaText(pick.wpa); the block title must contain the same string.
    const picks = situationalBlockPicks(galioMidItems());
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const blocks = situationalBlocksOf(sets[0]);
    picks.forEach((pick, i) => {
      expect(blocks[i].type).toBe(`Situational ${wpaText(pick.wpa)}`);
      expect(blocks[i].items[0].id).toBe(String(pick.id));
    });
  });

  it("keeps every situational title inside the longest title this app already ships", () => {
    // Measured 2026-08-19: Riot's own Recommended sets and the user's real
    // ItemSets.json both top out at 19 chars; THIS app already emits 29
    // ("Pro build (same as WPA build)") and has since 2026-07-29. The
    // situational titles are 16-17. Bounded here so a future "add the item
    // name" idea has to argue with a test.
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    for (const b of situationalBlocksOf(sets[0])) {
      expect(b.type.length).toBeLessThanOrEqual(17);
      expect(b.type).not.toMatch(/Boots|Shadowflame|Aegis/); // never the item NAME
    }
  });
});

describe("situational — block generation and ordering", () => {
  it("orders by win-rate delta, descending, exactly as the panel prints it", () => {
    const sit = situationalBlockPicks(galioMidItems());
    expect(sit.map((x) => Number(x.wpa.toFixed(2)))).toEqual([4.27, 2.79, 1.13, 0.45, 0.39, -0.06]);
    for (let i = 1; i < sit.length; i++) expect(sit[i].wpa).toBeLessThanOrEqual(sit[i - 1].wpa);
  });

  it("caps at SITUATIONAL_DISPLAY_LIMIT, dropping the tail the panel also drops", () => {
    // Galio's real list is SEVEN long — Hollow Radiance (-1.21) is the 7th and
    // is not on screen. The shop must not show an item the page did not.
    const full = flattenSituational(galioMidItems());
    expect(full).toHaveLength(7);
    expect(full[6].id).toBe(6664);
    expect(situationalBlockPicks(galioMidItems())).toHaveLength(SITUATIONAL_DISPLAY_LIMIT);
    expect(situationalBlockPicks(galioMidItems()).map((x) => x.id)).not.toContain(6664);
  });

  it("emits NO situational block at all when the champion has no alternatives", () => {
    const noAlts = { ...galioMidItems(), alts: undefined };
    const sets = buildItemSets(GALIO, "Mid", galioBuild(noAlts), null, galioMeta());
    expect(sets).toHaveLength(1);
    expect(situationalBlocksOf(sets[0])).toEqual([]);
  });

  it("sits LAST in the set, after every build block, and is contiguous", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const types = sets[0].blocks.map((b) => b.type);
    expect(types[0]).toBe("Starting");
    const firstSituational = types.findIndex((t) => t.startsWith("Situational"));
    expect(firstSituational).toBeGreaterThan(0);
    // Everything from there to the end is situational, and nothing before it is.
    for (let i = firstSituational; i < types.length; i++) expect(types[i]).toMatch(/^Situational/);
    for (let i = 0; i < firstSituational; i++) expect(types[i]).not.toMatch(/^Situational/);
  });

  it("degrades to ONE plain block when there are more picks than can be titled", () => {
    // Unreachable in production today: situationalBlockPicks caps at
    // SITUATIONAL_DISPLAY_LIMIT, which equals the titling cap (asserted below).
    // Reachable — and reached — by calling the pure function directly, which is
    // the only honest way to test a guard that exists for a FUTURE raise of the
    // display limit rather than for today's data.
    const many = Array.from({ length: SITUATIONAL_DISPLAY_LIMIT + 1 }, (_, i) =>
      p(1000 + i, `Item ${i}`, 1 - i * 0.1)
    );
    const blocks = situationalBlocks(many);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("Situational");
    expect(blocks[0].items.map((x) => Number(x.id))).toEqual(many.map((x) => x.id));
  });

  it("titles exactly as many picks as the page displays — the two caps are one number", () => {
    // If SITUATIONAL_DISPLAY_LIMIT is ever raised past the titling cap, every
    // real export silently falls into the degrade branch above and the numbers
    // vanish from the shop with the whole suite green. This is the tripwire.
    const atCap = Array.from({ length: SITUATIONAL_DISPLAY_LIMIT }, (_, i) =>
      p(2000 + i, `Item ${i}`, 1 - i * 0.1)
    );
    expect(situationalBlocks(atCap)).toHaveLength(SITUATIONAL_DISPLAY_LIMIT);
    expect(situationalBlocks([])).toEqual([]);
  });

  it("the shop block and the Builds panel read from ONE helper — not two copies", () => {
    // Behavioural: the module the card renders from and the module the shop
    // builds from must agree on the same input.
    expect(situationalBlockPicks(galioMidItems())).toEqual(situationalShortlist(galioMidItems()));
  });

  it("BOTH call sites use SITUATIONAL_DISPLAY_LIMIT, not a hardcoded 6", () => {
    // A shared constant proven at one consumer proves nothing about the other:
    // SituationalCard could still be slicing a literal 6 and this whole file
    // would stay green while the two surfaces silently drifted apart. Asserted
    // on source because the card is JSX and this suite has no render harness.
    const card = fs.readFileSync(
      path.join(process.cwd(), "components/hextech/SituationalCard.tsx"),
      "utf8"
    );
    expect(card).toContain("SITUATIONAL_DISPLAY_LIMIT");
    expect(card).not.toMatch(/\.slice\(0,\s*6\)/);
    const body = fs.readFileSync(
      path.join(process.cwd(), "components/hextech/itemSetBody.ts"),
      "utf8"
    );
    expect(body).not.toMatch(/situationalShortlist[\s\S]{0,40}slice\(0,\s*6\)/);
  });
});

describe("situational — negative deltas", () => {
  it("keeps a negative-delta pick and puts it last (Sunfire Aegis, -0.06)", () => {
    const sit = situationalBlockPicks(galioMidItems());
    expect(sit[sit.length - 1].id).toBe(3068);
    expect(sit[sit.length - 1].wpa).toBeLessThan(0);
  });

  it("puts EVERY negative pick after EVERY non-negative one", () => {
    const items = galioMidItems();
    // Force a mixed list where a negative would sort into the middle if the
    // order were anything other than delta-descending.
    items.alts!.first = [p(4645, "Shadowflame", 0.45), p(9001, "Bad Item", -3.0)];
    const sit = situationalBlockPicks(items);
    const firstNeg = sit.findIndex((x) => x.wpa < 0);
    expect(firstNeg).toBeGreaterThan(-1);
    for (let i = firstNeg; i < sit.length; i++) expect(sit[i].wpa).toBeLessThan(0);
  });

  it("still emits the block when EVERY pick is negative — 62 of 323 live combos", () => {
    // Deliberate, and the number is measured (see situationalBlockPicks' doc).
    // If a floor is ever added this test is the one that must be rewritten,
    // which is the point: the behaviour cannot change silently.
    const items = galioMidItems();
    items.alts = { first: [p(1, "A", -0.5), p(2, "B", -2.0)] };
    const sit = situationalBlockPicks(items);
    expect(sit.map((x) => x.id)).toEqual([1, 2]);
    const sets = buildItemSets(GALIO, "Mid", galioBuild(items), null, galioMeta());
    expect(situationalIds(sets[0])).toEqual([1, 2]);
    // ...and the shop says so out loud, rather than showing a bare icon row
    // the user has to guess at.
    expect(situationalBlocksOf(sets[0]).map((b) => b.type)).toEqual([
      "Situational -0.50",
      "Situational -2.00",
    ]);
  });
});

describe("situational — boots and duplicates", () => {
  it("keeps ALL THREE situational boots even though a different boot is in the main path", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const sit = situationalIds(sets[0]);
    expect(sit).toEqual(expect.arrayContaining([3158, 3009, 3047]));
    // Sorcerer's Shoes (3020) is the main path's boot and is NOT an alternative
    // to itself — it never appears in `alts`, so it must not appear here.
    expect(sit).not.toContain(3020);
    // ...and it is still in the build line, where it belongs.
    expect(idsOf(block(sets[0], "WPA build"))).toContain(3020);
  });

  it("the one-boots-per-line rule still holds on every build block", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const bootsIds = new Set([3020, 3158, 3009, 3047]);
    for (const b of sets[0].blocks) {
      if (b.type === "Starting" || b.type === "Situational") continue;
      expect(idsOf(b).filter((id) => bootsIds.has(id)).length).toBeLessThanOrEqual(1);
    }
  });

  it("drops a pick the WPA build already tells you to buy — but only that one", () => {
    // 6.5% of live slots (8 of 124 over 38 combos). "Buy this" and "consider
    // this instead" in one panel is a contradiction, and the item is still on
    // screen one block up, so nothing is hidden.
    const items = galioMidItems();
    // 8020 (Abyssal Mask) is Galio's FIRST core item. Offer it as an
    // alternative too, at the top of the list.
    items.alts!.third = [p(8020, "Abyssal Mask", 9.0)];
    const sets = buildItemSets(GALIO, "Mid", galioBuild(items), null, galioMeta());
    expect(idsOf(block(sets[0], "WPA build"))).toContain(8020);
    expect(situationalIds(sets[0])).not.toContain(8020);
    // ...and it is dropped, not backfilled from a 7th pick the page never
    // showed. Hollow Radiance (6664) is the 7th and must stay off.
    expect(situationalIds(sets[0])).not.toContain(6664);
  });

  it("KEEPS a pick that only overlaps a Pro/OTP block — that agreement is a finding", () => {
    // 46.8% of live slots. Those blocks answer a different question, which is
    // the same reason dedupeLineBlocks never collapses Pro into WPA.
    const items = galioMidItems();
    const consensus = {
      // 4645 Shadowflame is a situational pick; make the pros build it.
      items: [
        { itemId: 4645, share: 0.9 },
        { itemId: 8020, share: 0.8 },
        { itemId: 4633, share: 0.7 },
        { itemId: 3143, share: 0.6 },
        { itemId: 3152, share: 0.5 },
      ],
      boots: [{ itemId: 3020, share: 0.8 }],
    };
    const sets = buildItemSets(GALIO, "Mid", galioBuild(items), consensus, galioMeta(), null);
    expect(idsOf(block(sets[0], "Pro build"))).toContain(4645);
    expect(idsOf(block(sets[0], "WPA build"))).not.toContain(4645);
    expect(situationalIds(sets[0])).toContain(4645);
  });

  it("the exclusion set is the SAME one the Hidden gem uses", () => {
    // One definition of "already in your build" in this file, not two.
    const body = fs.readFileSync(
      path.join(process.cwd(), "components/hextech/itemSetBody.ts"),
      "utf8"
    );
    expect(body).toMatch(/situationalBlockPicks\(items,\s*wpaBuildIds\)/);
    expect(body).toMatch(/selectHiddenGemPicks\([\s\S]{0,120}wpaBuildIds/);
  });

  it("with an empty exclusion set the block is the panel's list verbatim", () => {
    expect(situationalBlockPicks(galioMidItems(), new Set())).toEqual(
      situationalShortlist(galioMidItems())
    );
  });

  it("never repeats an id WITHIN the block", () => {
    const items = galioMidItems();
    // Same id offered as an alternative in two different slots — the real
    // shape of `alts`, and what flattenSituational's own dedupe is for.
    items.alts!.third = [p(4645, "Shadowflame", 0.45)];
    const ids = situationalBlockPicks(items).map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("situational — ONE set, and the orphan 0.112.0 left behind", () => {
  it("emits exactly ONE set, with the situational picks inside it", () => {
    // web 0.112.0 emitted a second `CoachBuild Galio Mid Situational` set. The
    // user saw both in the shop's set dropdown and said: "you added it as a new
    // set i just wanted it in the same default set from coachbuild."
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    expect(sets).toHaveLength(1);
    expect(sets[0].title).toBe("CoachBuild Galio Mid");
    expect(situationalIds(sets[0])).toEqual(SCREENSHOT_ITEMS.map((x) => x.id));
  });

  it("never emits a set whose title carries the Situational suffix, for ANY champion+lane", () => {
    // The specific string the user rejected. Asserted across several combos and
    // both the with-alternatives and without-alternatives paths, because the
    // second set was CONDITIONAL — a single-champion assertion could pass while
    // the branch that emits it stayed live.
    const combos: [ChampionRef, string, ItemsBlock][] = [
      [GALIO, "Mid", galioMidItems()],
      [GALIO, "Mid", { ...galioMidItems(), alts: undefined }],
      [{ id: 6, key: "Urgot", name: "Urgot", icon: "u.png" }, "Top", galioMidItems()],
    ];
    for (const [champ, role, items] of combos) {
      const sets = buildItemSets(champ, role, { ...galioBuild(items), champion: champ }, null, galioMeta());
      expect(sets).toHaveLength(1);
      for (const s of sets) {
        expect(s.title).not.toMatch(/Situational/);
        expect(s.uid).not.toMatch(/situational/);
      }
    }
  });

  it("the ONE title starts with CoachBuild and falls inside the champ-scoped replace prefix", () => {
    // Both bridges reject the WHOLE payload if any title fails the first rule
    // (ApplyPayloadValidation.IsCoachBuildTitle / Test-ItemSetsPayload), and the
    // second rule is what makes a lane flip clean up the other lane's copies —
    // and what makes 0.112.0's orphan cleanable, since it was named to sit
    // inside the same prefix.
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const prefix = champScopedReplacePrefix(GALIO);
    expect(prefix).toBe("CoachBuild Galio ");
    for (const s of sets) {
      expect(s.title.startsWith("CoachBuild")).toBe(true);
      expect(s.title.startsWith(prefix)).toBe(true);
    }
    expect(sets[0].title).toBe("CoachBuild Galio Mid");
    // The orphan's own title, which is what the cleanup below has to match.
    expect(ORPHAN_TITLE.startsWith("CoachBuild")).toBe(true);
    expect(ORPHAN_TITLE.startsWith(prefix)).toBe(true);
  });

  it("leaves the MAIN set's uid and title byte-identical (the upgrade path)", () => {
    // A real install on this machine carries `CoachBuild Urgot Top` /
    // `coachbuild-urgot-top`. If either string moved, the bridge's prune would
    // still remove the old set (it matches on the "CoachBuild" prefix), but the
    // in-place identity would be gone. Pinned so a future suffix change cannot
    // drag the main set with it.
    const urgot: ChampionRef = { id: 6, key: "Urgot", name: "Urgot", icon: "u.png" };
    const sets = buildItemSets(urgot, "Top", { ...galioBuild(), champion: urgot }, null, galioMeta());
    expect(sets[0].uid).toBe("coachbuild-urgot-top");
    expect(sets[0].title).toBe("CoachBuild Urgot Top");
  });

  it("carries the full LCU set envelope, sortrank back to a single 0", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const s = sets[0];
    expect(s.uid).toBe("coachbuild-galio-mid");
    expect(s.sortrank).toBe(0);
    expect(s.type).toBe("custom");
    expect(s.map).toBe("any");
    expect(s.mode).toBe("any");
    expect(s.associatedMaps).toEqual([]);
    expect(s.associatedChampions).toEqual([GALIO.id]);
    expect(s.preferredItemSlots).toEqual([]);
  });

  it("stays inside the 1-3 sets BOTH bridges enforce", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    expect(sets.length).toBeGreaterThanOrEqual(1);
    expect(sets.length).toBeLessThanOrEqual(3);
  });

  // ── The orphan cleanup, against the user's REAL 61-set file ───────────────
  // 0.112.0 was live for 32 minutes and the user played at least one game on
  // it, so `CoachBuild Galio Mid Situational` is on a real disk somewhere. It
  // must not sit in their shop forever. It does not, and the mechanism is the
  // prune both bridges already run — no new cleanup path, no migration.
  //
  // These run the SAME merge the desktop bridge runs, reimplemented here only
  // because the bridge is C#; the C# source is asserted separately below so the
  // reimplementation cannot drift from it silently.
  const mergeLikeTheBridge = (existing: RealItemSetsFile, newSets: { title: string }[]) => ({
    ...existing,
    itemSets: [
      ...existing.itemSets.filter((s) => !(typeof s.title === "string" && s.title.startsWith("CoachBuild"))),
      ...newSets,
    ],
  });

  it("prunes the orphaned '… Situational' set on the next ordinary export", () => {
    const file = realItemSetsFile();
    const before = file.itemSets.length;
    // Seed the orphan exactly as 0.112.0 wrote it.
    file.itemSets.push({ title: ORPHAN_TITLE, uid: "coachbuild-galio-mid-situational", sortrank: 1 } as RealSet);
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const merged = mergeLikeTheBridge(file, sets);
    const titles = merged.itemSets.map((s) => s.title);
    expect(titles).not.toContain(ORPHAN_TITLE);
    expect(titles.filter((t) => typeof t === "string" && t.startsWith("CoachBuild"))).toEqual([
      "CoachBuild Galio Mid",
    ]);
    // The file had ONE CoachBuild set before (Urgot Top); after the seed and
    // the export it has one again, not three.
    expect(merged.itemSets).toHaveLength(before + 1 - 1 - 1 + 1);
  });

  it("leaves all 60 of the user's own sets byte-identical, and in the same order", () => {
    const original = realItemSetsFile();
    const foreignBefore = original.itemSets.filter((s) => !String(s.title ?? "").startsWith("CoachBuild"));
    const seeded = realItemSetsFile();
    seeded.itemSets.push({ title: ORPHAN_TITLE, uid: "coachbuild-galio-mid-situational", sortrank: 1 } as RealSet);
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const merged = mergeLikeTheBridge(seeded, sets);
    const foreignAfter = merged.itemSets.filter((s) => !String(s.title ?? "").startsWith("CoachBuild"));
    expect(foreignAfter).toHaveLength(60);
    expect(foreignBefore).toHaveLength(60);
    // Byte-identical AND in the same order — a set-equality check would pass on
    // a reordered file, and the client renders them in file order.
    expect(JSON.stringify(foreignAfter)).toBe(JSON.stringify(foreignBefore));
    // The third-party sets the user named are among them, untouched.
    const titles = foreignAfter.map((s) => s.title);
    expect(titles).toContain("U.GG - Galio");
    // Top-level document fields survive (accountId/timestamp are what the
    // client uses to decide the file is theirs).
    expect(Object.keys(merged).sort()).toEqual(Object.keys(original).sort());
  });

  it("the seeded orphan is a real difference — the same merge WITHOUT it is not the same file", () => {
    // Positive control for the two tests above: if the prune were a no-op, or
    // the fixture had no orphan in it, they would pass over nothing.
    const withOrphan = realItemSetsFile();
    withOrphan.itemSets.push({ title: ORPHAN_TITLE, uid: "coachbuild-galio-mid-situational", sortrank: 1 } as RealSet);
    expect(withOrphan.itemSets.map((s) => s.title)).toContain(ORPHAN_TITLE);
    expect(realItemSetsFile().itemSets.map((s) => s.title)).not.toContain(ORPHAN_TITLE);
  });
});

describe("situational — the bridges that have to accept two sets", () => {
  // These read the OTHER side of the wire contract off disk. They are source
  // assertions because neither adapter is reachable from this suite (one is C#,
  // one is PowerShell), and the assumption they encode — "1-3 sets, already
  // shipped, no release needed" — is the entire reason this change carries no
  // desktop version bump. If someone tightens either bound to 1, the feature
  // breaks in the field with a validation error and these fail here first.
  it("the desktop app (shipped 1.0.14) validates a set count of 1-3", () => {
    const cs = fs.readFileSync(
      path.join(process.cwd(), "desktop/src/CoachBuild.Core/ApplyPayloadValidation.cs"),
      "utf8"
    );
    expect(cs).toContain("request.Sets.Count is < 1 or > 3");
  });

  it("the desktop merge takes a LIST of new sets, so both land in one PUT", () => {
    const cs = fs.readFileSync(
      path.join(process.cwd(), "desktop/src/CoachBuild.Core/ItemSetMergeService.cs"),
      "utf8"
    );
    expect(cs).toContain("IReadOnlyList<JsonElement> newSets");
    expect(cs).toMatch(/foreach \(var set in newSets\)/);
  });

  it("the desktop apply still REFUSES to write on an unclean read", () => {
    // Untouched by this change and must stay that way: an unreadable or
    // wrong-shaped existing document means nothing is written at all, so a
    // failed read can never blank the user's 60 hand-made sets.
    const cs = fs.readFileSync(
      path.join(process.cwd(), "desktop/src/CoachBuild.Core/ItemSetApplyService.cs"),
      "utf8"
    );
    expect(cs).toMatch(/if \(!existing\.Ok \|\| existing\.Content is not \{ \} existingContent \|\| existingContent\.ValueKind != JsonValueKind\.Object\)/);
    expect(cs).toContain("couldn't read your existing item sets -- nothing was changed");
    // ...and the PUT happens only after a successful merge.
    expect(cs.indexOf("read-failed")).toBeLessThan(cs.indexOf("HttpMethod.Put, path, merged"));
  });

  it("the desktop merge never touches a set that is not ours (HARD RULE 5)", () => {
    const cs = fs.readFileSync(
      path.join(process.cwd(), "desktop/src/CoachBuild.Core/ItemSetMergeService.cs"),
      "utf8"
    );
    expect(cs).toContain('title.StartsWith("CoachBuild", StringComparison.Ordinal)');
  });

  it("the PowerShell companion also accepts 1-3 sets", () => {
    const ps = fs.readFileSync(path.join(process.cwd(), "public/companion.ps1"), "utf8");
    expect(ps).toContain("1-3 sets");
  });
});
