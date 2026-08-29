/**
 * forThisGameItemSet — the `For this game` block reaching the in-game shop
 * (0.120.0, user directive 2026-08-29).
 *
 * EVERY FIXTURE IS REAL DATA. The builds are verbatim `GET /api/build`
 * captures in fixtures/enemycomp/ and the item metadata is built from the
 * captured 16.17.1 catalogue rather than hand-written, so a test cannot agree
 * with the code about a shape neither of them got from the wire.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildItemSets } from "../hextech/itemSetBody";
import {
  forThisGameCaption,
  capDiagnostics,
  DIAGNOSTICS_MAX_LINES,
} from "../hextech/itemSetsApply";
import {
  resolveForThisGamePlan,
  FOR_THIS_GAME_BLOCK_TITLE,
  type ForThisGamePlan,
  type ForThisGameSwap,
} from "@/lib/enemyComp/forThisGame";
import { MERCURYS_TREADS } from "@/lib/enemyComp/counterItems";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";
import type { LaneId } from "../hextech/heroContracts";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const CATALOGUE = JSON.parse(read("fixtures/enemycomp/catalogue-items-16.17.1.json")).data as Record<
  string,
  { name: string; tags?: string[]; into?: string[]; gold?: { purchasable?: boolean }; description?: string }
>;

/** The real 16.17.1 catalogue, reshaped into the ItemDetail map
 *  `buildItemSets` takes.
 *
 *  `from` IS RECONSTRUCTED, NOT STUBBED, and that is the whole reason this
 *  helper is longer than one map(). The capture carries `into` but not `from`,
 *  and both obvious stand-ins produce a silently WRONG export:
 *
 *    from: [1001]  -- `isBootsItem`'s ancestry clause walks `from` and finds
 *                     Boots (1001), so EVERY item in the game classifies as
 *                     boots and `buildLine`'s one-boots rule keeps exactly one
 *                     item per line.
 *    from: []      -- `isFinalBootsItem` requires `from.length > 0` (it is what
 *                     excludes tier-1 Boots from a completed loadout), so NO
 *                     boot is ever a full item, `fullItemsOnly` drops all of
 *                     them, and every WPA build line comes out with six
 *                     legendaries and no footwear. That is what this fixture
 *                     did on the first run, and the only thing that caught it
 *                     was asserting EXACTLY one pair of boots rather than at
 *                     most one.
 *
 *  So `from` is the inverse of `into`, derived from the same capture: if X's
 *  `into` names Y, then Y is built from X. `goldTotal` stays 3000 for every
 *  entry, which is above LANE_STARTER_MAX_GOLD and therefore keeps
 *  `isFullItem`'s structural starter clause from firing on a Lane-tagged
 *  legendary. */
function catalogueMeta(): Map<number, ItemDetail> {
  const from = new Map<number, string[]>();
  for (const [rawId, e] of Object.entries(CATALOGUE)) {
    for (const child of e.into ?? []) {
      const list = from.get(Number(child)) ?? [];
      list.push(rawId);
      from.set(Number(child), list);
    }
  }
  const out = new Map<number, ItemDetail>();
  for (const [rawId, e] of Object.entries(CATALOGUE)) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id >= 10000) continue;
    out.set(id, {
      id,
      name: e.name,
      goldTotal: 3000,
      descriptionText: e.description ?? "",
      into: (e.into ?? []).map(String),
      from: from.get(id) ?? [],
      tags: e.tags ?? [],
      purchasable: e.gold?.purchasable !== false,
    } as ItemDetail);
  }
  return out;
}
const META = catalogueMeta();

const buildOf = (name: string): BuildResponse =>
  JSON.parse(read(`fixtures/enemycomp/${name}.json`));

const champOf = (b: BuildResponse): ChampionRef => b.champion;

const COMPS = {
  twoHealers: [16, 266, 99, 112, 51],
  heavyAp: [99, 112, 103, 54, 202],
  twoTanksOneAssassin: [54, 516, 238, 119, 202],
  heavyCc: [412, 89, 22, 127, 236],
} as const;

function planFor(fixture: string, lane: LaneId, enemies: readonly number[]): ForThisGamePlan | null {
  const b = buildOf(fixture);
  return resolveForThisGamePlan({
    enemyChampionIds: enemies,
    championId: b.champion.id,
    lane,
    items: b.items,
  });
}

function exportWith(fixture: string, roleLabel: string, plan: ForThisGamePlan | null) {
  const b = buildOf(fixture);
  return buildItemSets(champOf(b), roleLabel, b, null, META, null, plan);
}

const blockTypes = (out: ReturnType<typeof exportWith>) => out.sets[0].blocks.map((x) => x.type);
const ftgBlock = (out: ReturnType<typeof exportWith>) =>
  out.sets[0].blocks.find((x) => x.type === FOR_THIS_GAME_BLOCK_TITLE);

describe("the block exists exactly when the comp is complete", () => {
  it("a FULL comp produces the block", () => {
    const plan = planFor("viktor-mid", "mid", COMPS.twoHealers);
    expect(plan).not.toBeNull();
    const out = exportWith("viktor-mid", "Mid", plan);
    expect(blockTypes(out)).toContain(FOR_THIS_GAME_BLOCK_TITLE);
  });

  it("a PARTIAL comp produces no block, and a byte-identical export", () => {
    // The fixture the directive names. This is the strongest form of the
    // claim: not just "no block" but "nothing anywhere in the payload moved".
    const partial = planFor("viktor-mid", "mid", COMPS.twoHealers.slice(0, 4));
    expect(partial).toBeNull();
    const withPartial = exportWith("viktor-mid", "Mid", partial);
    const without = exportWith("viktor-mid", "Mid", null);
    expect(JSON.stringify(withPartial)).toBe(JSON.stringify(without));
    expect(blockTypes(withPartial)).not.toContain(FOR_THIS_GAME_BLOCK_TITLE);
  });

  it("omits the swaps key entirely rather than sending an empty array", () => {
    const without = exportWith("viktor-mid", "Mid", null);
    expect("forThisGame" in without).toBe(false);
    expect(JSON.stringify(without)).not.toContain("forThisGame");
  });

  it("no plan means the export is what it was before this feature existed", () => {
    for (const [fixture, role] of [
      ["viktor-mid", "Mid"],
      ["urgot-top", "Top"],
      ["lux-sup", "Support"],
      ["malphite-top", "Top"],
      ["yasuo-mid", "Mid"],
      ["thresh-sup", "Support"],
    ] as const) {
      const out = exportWith(fixture, role, null);
      expect(blockTypes(out)).not.toContain(FOR_THIS_GAME_BLOCK_TITLE);
    }
  });
});

describe("the block touches nothing else in the set", () => {
  const cases = [
    ["viktor-mid", "Mid", "mid", COMPS.twoHealers],
    ["urgot-top", "Top", "top", COMPS.heavyAp],
    ["yasuo-mid", "Mid", "mid", COMPS.twoTanksOneAssassin],
    ["malphite-top", "Top", "top", COMPS.twoTanksOneAssassin],
    ["thresh-sup", "Support", "support", COMPS.twoHealers],
    ["lux-sup", "Support", "support", COMPS.heavyCc],
  ] as const;

  it.each(cases)("%s: every OTHER block is byte-identical", (fixture, role, lane, comp) => {
    const plan = planFor(fixture, lane, comp);
    const withPlan = exportWith(fixture, role, plan);
    const without = exportWith(fixture, role, null);
    const strip = (o: ReturnType<typeof exportWith>) =>
      o.sets[0].blocks.filter((b) => b.type !== FOR_THIS_GAME_BLOCK_TITLE);
    expect(JSON.stringify(strip(withPlan))).toBe(JSON.stringify(strip(without)));
  });

  it.each(cases)("%s: the set envelope and the situational wire do not move", (fixture, role, lane, comp) => {
    const plan = planFor(fixture, lane, comp);
    const withPlan = exportWith(fixture, role, plan);
    const without = exportWith(fixture, role, null);
    const { blocks: _a, ...envA } = withPlan.sets[0];
    const { blocks: _b, ...envB } = without.sets[0];
    expect(envA).toEqual(envB);
    expect(withPlan.situational).toEqual(without.situational);
  });

  it("the Situational row carries NO comp suffix any more", () => {
    // 0.118.0 titled it `Situational vs CC`. That is gone: one comp-driven
    // opinion per set. See situational.ts's own note for the three reasons.
    const plan = planFor("lux-sup", "support", COMPS.heavyCc);
    expect(plan!.scenarios).toContain("heavy-cc");
    const out = exportWith("lux-sup", "Support", plan);
    for (const type of blockTypes(out)) {
      expect(type).not.toMatch(/^Situational vs /);
    }
    expect(blockTypes(out).filter((t) => t.startsWith("Situational"))).toEqual(["Situational"]);
  });
});

describe("the block is a real build line", () => {
  const cases = [
    ["viktor-mid", "Mid", "mid", COMPS.twoHealers],
    ["urgot-top", "Top", "top", COMPS.heavyAp],
    ["yasuo-mid", "Mid", "mid", COMPS.twoTanksOneAssassin],
    ["malphite-top", "Top", "top", COMPS.twoTanksOneAssassin],
    ["thresh-sup", "Support", "support", COMPS.twoHealers],
  ] as const;

  it.each(cases)("%s: six items, exactly one boots, no duplicates", (fixture, role, lane, comp) => {
    const plan = planFor(fixture, lane, comp);
    const out = exportWith(fixture, role, plan);
    const block = ftgBlock(out);
    expect(block, `${fixture} produced no block`).toBeDefined();
    const ids = block!.items.map((i) => Number(i.id));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    const boots = ids.filter((id) => (META.get(id)?.tags ?? []).includes("Boots"));
    expect(boots).toHaveLength(1);
  });

  it.each(cases)("%s: never contains the starter (HARD RULE 2)", (fixture, role, lane, comp) => {
    const plan = planFor(fixture, lane, comp);
    const out = exportWith(fixture, role, plan);
    const ids = ftgBlock(out)!.items.map((i) => Number(i.id));
    expect(ids).not.toContain(buildOf(fixture).items.starter.id);
  });

  it("every entry carries count 1, like every other block", () => {
    const out = exportWith("viktor-mid", "Mid", planFor("viktor-mid", "mid", COMPS.twoHealers));
    for (const item of ftgBlock(out)!.items) expect(item.count).toBe(1);
  });

  it("sits directly after `WPA build` and before the consensus lines", () => {
    // A JUDGMENT line never leads a MEASURED one, and reading the spine next to
    // its adjustment is what makes the adjustment legible.
    const out = exportWith("viktor-mid", "Mid", planFor("viktor-mid", "mid", COMPS.twoHealers));
    const types = blockTypes(out);
    expect(types[0]).toBe("Starting");
    expect(types[1]).toBe("WPA build");
    expect(types[2]).toBe(FOR_THIS_GAME_BLOCK_TITLE);
  });

  it("differs from the WPA build it was derived from", () => {
    // The block is emitted ONLY when something changed; a `For this game` line
    // identical to the one above it claims an adjustment that did not happen.
    for (const [fixture, role, lane, comp] of cases) {
      const out = exportWith(fixture, role, planFor(fixture, lane, comp));
      const wpa = out.sets[0].blocks.find((b) => b.type === "WPA build")!;
      const ftg = ftgBlock(out)!;
      expect(JSON.stringify(ftg.items), fixture).not.toBe(JSON.stringify(wpa.items));
    }
  });
});

describe("the named scenario fixtures, end to end", () => {
  it("Viktor mid vs 2 healers buys Morellonomicon", () => {
    const out = exportWith("viktor-mid", "Mid", planFor("viktor-mid", "mid", COMPS.twoHealers));
    const ids = ftgBlock(out)!.items.map((i) => Number(i.id));
    expect(ids).toContain(3165);
    // 2nd or 3rd purchase, per SCENARIO_TARGET_POSITION -- never 5th, which is
    // where an anti-heal item stops mattering.
    expect(ids.indexOf(3165)).toBeGreaterThanOrEqual(1);
    expect(ids.indexOf(3165)).toBeLessThanOrEqual(2);
  });

  it("Urgot top vs heavy AP swaps the boot AND takes an MR item", () => {
    const out = exportWith("urgot-top", "Top", planFor("urgot-top", "top", COMPS.heavyAp));
    const ids = ftgBlock(out)!.items.map((i) => Number(i.id));
    expect(ids).toContain(MERCURYS_TREADS);
    expect(out.forThisGame!.map((s) => s.channel)).toContain("boots");
    expect(out.forThisGame!.map((s) => s.channel)).toContain("item");
    expect(out.forThisGame).toHaveLength(2);
  });

  it("Lux support vs heavy CC swaps only the boot", () => {
    const out = exportWith("lux-sup", "Support", planFor("lux-sup", "support", COMPS.heavyCc));
    const ids = ftgBlock(out)!.items.map((i) => Number(i.id));
    expect(ids).toContain(MERCURYS_TREADS);
    expect(out.forThisGame).toHaveLength(1);
    expect(out.forThisGame![0].channel).toBe("boots");
    expect(out.forThisGame![0].reason).toMatch(/^heavy CC/);
  });

  it("a marksman vs 2 tanks takes penetration first", () => {
    const out = exportWith("yasuo-mid", "Mid", planFor("yasuo-mid", "mid", COMPS.twoTanksOneAssassin));
    expect(out.forThisGame![0].reason).toBe("2 tanks");
    expect(out.forThisGame![0].itemId).toBe(3036);
  });
});

describe("the caption channel", () => {
  it("names every swap, with its reason, on ONE line", () => {
    const out = exportWith("urgot-top", "Top", planFor("urgot-top", "top", COMPS.heavyAp));
    const caption = forThisGameCaption(out.forThisGame!, META)!;
    expect(caption.startsWith("For this game: ")).toBe(true);
    expect(caption).toContain("boots Mercury's Treads (4 AP)");
    expect(caption.split("\n")).toHaveLength(1);
    for (const swap of out.forThisGame!) {
      expect(caption).toContain(META.get(swap.itemId)!.name);
      expect(caption).toContain(swap.reason);
    }
  });

  it("marks a curated fallback as judgment IN THE LOG, not just on the page", () => {
    // Viktor's own data never offers Morellonomicon, so the log has to say the
    // recommendation came from the table rather than from his numbers.
    const out = exportWith("viktor-mid", "Mid", planFor("viktor-mid", "mid", COMPS.twoHealers));
    expect(out.forThisGame![0].measured).toBe(false);
    const caption = forThisGameCaption(out.forThisGame!, META)!;
    expect(caption).toBe("For this game: Morellonomicon (2 healers, judgment)");
  });

  it("degrades to the id when the catalogue never resolved", () => {
    // An id in a log is still actionable. A fabricated name is not.
    const swaps: ForThisGameSwap[] = [
      {
        itemId: 999999,
        scenario: "healers",
        reason: "2 healers",
        measured: true,
        channel: "item",
        replacedId: null,
        position: 3,
      },
    ];
    expect(forThisGameCaption(swaps, new Map())).toBe("For this game: item 999999 (2 healers)");
  });

  it("returns null for no swaps rather than an empty caption", () => {
    expect(forThisGameCaption([], META)).toBeNull();
  });

  it("is capped at the DESKTOP's own MaxLines, in the web, before sending", () => {
    // The desktop truncates too, but then WHICH line survives is decided by
    // emission order rather than importance. Failures are what a reader is
    // debugging with; the caption is nice to have. So the slice happens here.
    const cs = read("desktop/src/CoachBuild.Core/ApplyDiagnostics.cs");
    expect(cs).toContain(`public const int MaxLines = ${DIAGNOSTICS_MAX_LINES};`);
    expect(capDiagnostics(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
    expect(capDiagnostics(["a"])).toEqual(["a"]);
  });

  it("appends the caption LAST, so a real outage line is never the one cut", () => {
    const apply = read("components/hextech/itemSetsApply.ts");
    expect(apply).toMatch(
      /capDiagnostics\(\[\.\.\.diagnostics,\s*\.\.\.\(caption \? \[caption\] : \[\]\)\]\)/
    );
  });

  it("is built from the swaps the BLOCK made, never a second derivation", () => {
    // Line assembly is where a swap turns out to be a MOVE rather than a
    // replacement, so an independently derived caption would name a displaced
    // item the block did not displace.
    const apply = read("components/hextech/itemSetsApply.ts");
    expect(apply).toMatch(/const \{ sets, situational, forThisGame: swaps \} = buildItemSets\(/);
    expect(apply).toMatch(/swaps \? forThisGameCaption\(swaps, itemMeta\) : null/);
    // A CALL, not the word -- the reason this rule exists is written out in
    // a comment in that file, and matching prose would make the assertion
    // fail for saying so.
    expect(apply).not.toMatch(/applyForThisGameLine\(/);
  });
});

describe("ToS and the honesty posture", () => {
  it("the block title is a noun phrase and names no action", () => {
    expect(FOR_THIS_GAME_BLOCK_TITLE).toBe("For this game");
    const out = exportWith("viktor-mid", "Mid", planFor("viktor-mid", "mid", COMPS.twoHealers));
    for (const type of blockTypes(out)) {
      expect(type).not.toMatch(/\b(rush|buy|sell|now|next)\b/i);
    }
  });

  it("nothing in the enemy-comp path reads an enemy's items", () => {
    // Structural: the only enemy input anywhere in this feature is a list of
    // champion ids, which is on screen in champ select before the game starts.
    for (const rel of [
      "lib/enemyComp/forThisGame.ts",
      "lib/enemyComp/scenarios.ts",
      "lib/enemyComp/scenarioItems.ts",
      "lib/enemyComp/kitAxes.ts",
      "lib/enemyComp/championClass.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/enemyItems|opponentItems|theirItems|purchaseOrder/);
    }
  });

  it("the block's own module never imports React, fetch or a clock", () => {
    const src = read("lib/enemyComp/forThisGame.ts");
    expect(src).not.toMatch(/from "react"/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/Date\.now\(\)/);
  });
});
