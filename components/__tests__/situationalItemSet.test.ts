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
import { buildItemSets, situationalBlockPicks, champScopedReplacePrefix } from "../hextech/itemSetBody";
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

// ─────────────────────────────────────────────────────────────────────────────

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

  it("the emitted block carries those ids as STRINGS with count 1 (LCU item-set schema)", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const sit = block(sets[0], "Situational")!;
    expect(sit.items).toEqual(SCREENSHOT_ITEMS.map((x) => ({ id: String(x.id), count: 1 })));
    for (const entry of sit.items) {
      expect(typeof entry.id).toBe("string");
      expect(entry.count).toBe(1);
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

  it("emits NO block and NO second set when the champion has no alternatives", () => {
    const noAlts = { ...galioMidItems(), alts: undefined };
    const sets = buildItemSets(GALIO, "Mid", galioBuild(noAlts), null, galioMeta());
    expect(sets).toHaveLength(1);
    expect(block(sets[0], "Situational")).toBeUndefined();
  });

  it("sits LAST in the main set, after every build block", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const types = sets[0].blocks.map((b) => b.type);
    expect(types[0]).toBe("Starting");
    expect(types[types.length - 1]).toBe("Situational");
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
    expect(idsOf(block(sets[0], "Situational"))).toEqual([1, 2]);
  });
});

describe("situational — boots and duplicates", () => {
  it("keeps ALL THREE situational boots even though a different boot is in the main path", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const sit = idsOf(block(sets[0], "Situational"));
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
    expect(idsOf(block(sets[0], "Situational"))).not.toContain(8020);
    // ...and it is dropped, not backfilled from a 7th pick the page never
    // showed. Hollow Radiance (6664) is the 7th and must stay off.
    expect(idsOf(block(sets[0], "Situational"))).not.toContain(6664);
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
    expect(idsOf(block(sets[0], "Situational"))).toContain(4645);
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

describe("situational — the standalone second set", () => {
  it("emits exactly two sets, the second carrying only the Situational block", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    expect(sets).toHaveLength(2);
    expect(sets[1].blocks).toHaveLength(1);
    expect(sets[1].blocks[0].type).toBe("Situational");
    expect(sets[1].blocks[0].items).toEqual(block(sets[0], "Situational")!.items);
  });

  it("both titles start with CoachBuild and both fall inside the champ-scoped replace prefix", () => {
    // Both bridges reject the WHOLE payload if any title fails the first rule
    // (ApplyPayloadValidation.IsCoachBuildTitle / Test-ItemSetsPayload), and the
    // second rule is what makes a lane flip clean up the other lane's copies.
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const prefix = champScopedReplacePrefix(GALIO);
    expect(prefix).toBe("CoachBuild Galio ");
    for (const s of sets) {
      expect(s.title.startsWith("CoachBuild")).toBe(true);
      expect(s.title.startsWith(prefix)).toBe(true);
    }
    expect(sets[0].title).toBe("CoachBuild Galio Mid");
    expect(sets[1].title).toBe("CoachBuild Galio Mid Situational");
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

  it("gives the two sets distinct uids and sorts the situational one after the main one", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    expect(sets[0].uid).toBe("coachbuild-galio-mid");
    expect(sets[1].uid).toBe("coachbuild-galio-mid-situational");
    expect(sets[0].uid).not.toBe(sets[1].uid);
    expect(sets[0].sortrank).toBe(0);
    expect(sets[1].sortrank).toBe(1);
  });

  it("carries the full LCU set envelope on the second set too", () => {
    const sets = buildItemSets(GALIO, "Mid", galioBuild(), null, galioMeta());
    const s = sets[1];
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
