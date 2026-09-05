/**
 * itemSetBody — BUY ORDER.
 *
 * A shop-panel block is rendered as a left-to-right row and read as "buy these
 * in this order". Everything in this file is about whether that reading is
 * true. It is a separate suite from itemSetBody.test.ts because that file's
 * subject is the four-category CONTRACT — which blocks exist, what they may
 * contain — and this one's is the SEQUENCE inside them.
 *
 * ── The three claims ───────────────────────────────────────────────────────
 *
 * 1. The WPA line is the model's own SLOT sequence (first -> second -> third ->
 *    fourthPlus), with boots reinserted at BOOTS_LINE_INDEX, and NOTHING
 *    downstream re-ranks it by wpa. Verified live 2026-08-27 on six real
 *    champion-roles; the load-bearing case is Ahri Mid, whose model returns
 *    second = Lich Bane (wpa 0.90) ahead of third = Rabadon's (wpa 0.98) — a
 *    wpa re-sort would visibly swap them and does not.
 *
 * 2. A consensus source that declares `ordered` is passed through UNSORTED.
 *    This is RC-2. Live, Jinx Bot: Infinity Edge is the most-built item (70%)
 *    and the third-bought one, so the share sort put "buy this first" on an
 *    item those same pros buy behind two others.
 *
 * 3. A source that CANNOT declare an order does not get a title that claims
 *    one. `/api/otp` sets `purchaseOrder: []` unconditionally, so the OTP block
 *    can never be a buy order and must not be titled like one.
 */
import { describe, it, expect } from "vitest";
import { buildItemSets as buildItemSetExport } from "../hextech/itemSetBody";
import type { BuildResponse, ChampionRef, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";

const buildItemSets = (...args: Parameters<typeof buildItemSetExport>) => buildItemSetExport(...args).sets;

// Real 16.16.1 ids. Trinity Force is the case the user named: it is the FIRST
// item on the champions that build it (measured median purchase position #1 on
// Jax Top n=38, Camille Top n=69, Ezreal Bot n=99), so every block that lists
// it must list it first.
const TRINITY_FORCE = 3078;
const RAVENOUS_HYDRA = 3074;
const DEATHS_DANCE = 6333;
const STERAKS = 3053;
const MAW = 3156;
const GUARDIAN_ANGEL = 3026;
const MERCURYS = 3111; // tier-2 boot
const PLATED = 3047; // tier-2 boot
const DORANS_BLADE = 1055;

const CAMILLE: ChampionRef = { id: 164, key: "Camille", name: "Camille", icon: "camille.png" };

function pick(id: number, wpa = 0.02): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: 52, occurrence: 5000 };
}

function meta(id: number, overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id,
    name: `Item ${id}`,
    goldTotal: 3000,
    descriptionText: "",
    into: [],
    from: ["1000"],
    tags: [],
    purchasable: true,
    ...overrides,
  };
}

function boots(id: number): ItemDetail {
  return meta(id, { tags: ["Boots"], from: ["1001"], into: ["900000"] });
}

const CATALOG = new Map<number, ItemDetail>(
  [
    meta(DORANS_BLADE),
    meta(TRINITY_FORCE),
    meta(RAVENOUS_HYDRA),
    meta(DEATHS_DANCE),
    meta(STERAKS),
    meta(MAW),
    meta(GUARDIAN_ANGEL),
    meta(7001),
    meta(7002),
    meta(7003),
    meta(7004),
    boots(MERCURYS),
    boots(PLATED),
  ].map((m) => [m.id, m])
);

function runes(): RunesBlock {
  return {
    primaryTree: { id: 8000, name: "Precision", icon: "t8000" },
    secondaryTree: { id: 8100, name: "Domination", icon: "t8100" },
    keystone: pick(8005),
    primary: [pick(9111), pick(9104), pick(8014)],
    secondary: [pick(8143), pick(8135)],
    shards: { offense: pick(5005), flex: pick(5008), defense: pick(5002) },
  };
}

function build(items: ItemsBlock): BuildResponse {
  return {
    champion: CAMILLE,
    role: 0,
    roleLabel: "Top",
    patch: "16.16",
    tierLabel: "Diamond+",
    runes: runes(),
    spells: [pick(4), pick(12)],
    items,
    generatedAt: new Date().toISOString(),
    sources: { provider: "coachless.gg" },
  };
}

/** Camille Top's real 16.16 model sequence, with the wpa values it really
 *  returns — DELIBERATELY ASCENDING across the first three slots (0.101 ->
 *  0.038 -> 0.934). Any re-rank by wpa anywhere downstream would reorder this
 *  and the assertion below would catch it. */
function camilleItems(): ItemsBlock {
  return {
    starter: pick(DORANS_BLADE),
    boots: pick(MERCURYS, 0.502),
    first: pick(TRINITY_FORCE, 0.101),
    second: pick(RAVENOUS_HYDRA, 0.038),
    third: pick(STERAKS, 0.934),
    fourthPlus: [pick(DEATHS_DANCE, -0.968)],
  };
}

/** A model whose per-slot pools name ids NOTHING in the consensus blocks below
 *  uses. This is the RESIDUAL shape, and since RC-5 it is the ONLY shape in
 *  which a consensus block may still be frequency-ordered: `camilleItems()`
 *  ranks Trinity/Ravenous/Sterak's/Death's Dance by slot, so a block built from
 *  those ids is now ordered by the WPA slot prior and titled a build. Measured
 *  on the committed patch-16.16 artifact, the residual is 17 pro and 3 OTP
 *  blocks of the 551 the export can render. */
function noSlotSignalItems(): ItemsBlock {
  return {
    starter: pick(DORANS_BLADE),
    boots: pick(MERCURYS, 0.502),
    first: pick(7001),
    second: pick(7002),
    third: pick(7003),
    fourthPlus: [pick(7004)],
  };
}

function typesOf(sets: ReturnType<typeof buildItemSets>): string[] {
  return sets[0].blocks.map((b) => b.type);
}

function idsOf(sets: ReturnType<typeof buildItemSets>, type: string): number[] {
  return sets[0].blocks.find((b) => b.type === type)!.items.map((i) => Number(i.id));
}

describe("the WPA line is the model's SLOT order, never a wpa re-rank", () => {
  it("keeps first -> second -> third -> fourthPlus even when their wpa ascends", () => {
    const sets = buildItemSets(CAMILLE, "Top", build(camilleItems()), null, CATALOG);
    const ids = idsOf(sets, "WPA build");
    // Boots at index 1 (BOOTS_LINE_INDEX, measured over 978 games); everything
    // else in the model's own slot sequence.
    expect(ids[1]).toBe(MERCURYS);
    expect(ids.filter((id) => id !== MERCURYS)).toEqual([
      TRINITY_FORCE,
      RAVENOUS_HYDRA,
      STERAKS,
      DEATHS_DANCE,
    ]);
  });

  it("puts Trinity Force at legendary position 1 when the model's slot 1 is Trinity Force", () => {
    const ids = idsOf(buildItemSets(CAMILLE, "Top", build(camilleItems()), null, CATALOG), "WPA build");
    expect(ids[0]).toBe(TRINITY_FORCE);
  });

  it("a consensus pool feeding the line as PADDING cannot reorder what the model gave", () => {
    // The pro pool pads the WPA line's tail. It arrives share-desc with an
    // order of its own; the model's own picks must keep their positions.
    const pro = {
      items: [
        { itemId: GUARDIAN_ANGEL, share: 0.99 },
        { itemId: MAW, share: 0.98 },
      ],
      boots: [{ itemId: PLATED, share: 0.9 }],
    };
    const short: ItemsBlock = { ...camilleItems(), fourthPlus: [] };
    const ids = idsOf(buildItemSets(CAMILLE, "Top", build(short), pro, CATALOG), "WPA build");
    expect(ids.slice(0, 4)).toEqual([TRINITY_FORCE, MERCURYS, RAVENOUS_HYDRA, STERAKS]);
  });
});

describe("a consensus block that DECLARES an order is not re-sorted by share", () => {
  /** The real Jinx-shaped disagreement, on Camille's catalog: the most-built
   *  item is the last-bought one. */
  const orderedPro = {
    items: [
      // purchase order
      { itemId: TRINITY_FORCE, share: 0.99 },
      { itemId: RAVENOUS_HYDRA, share: 0.8 },
      { itemId: DEATHS_DANCE, share: 0.39 },
      { itemId: STERAKS, share: 0.19 },
      { itemId: MAW, share: 0.05 },
      { itemId: GUARDIAN_ANGEL, share: 0.06 },
    ],
    boots: [{ itemId: PLATED, share: 0.51 }],
    ordered: true,
  };

  it("preserves purchase order while replacing an incompatible Lifeline item", () => {
    const sets = buildItemSets(CAMILLE, "Top", build(camilleItems()), orderedPro, CATALOG);
    const ids = idsOf(sets, "Pro build");
    expect(ids[1]).toBe(PLATED); // boots still land at BOOTS_LINE_INDEX
    expect(ids.filter((id) => id !== PLATED)).toEqual([
      TRINITY_FORCE,
      RAVENOUS_HYDRA,
      DEATHS_DANCE,
      STERAKS,
      GUARDIAN_ANGEL,
    ]);
    expect(ids).not.toContain(MAW);
  });

  it("still re-sorts by share when the source could not measure an order", () => {
    // RC-5: and when no positional prior can be measured for it either — hence
    // `noSlotSignalItems()`. Share order is the residual, not the default.
    const { ordered: _drop, ...unorderedPro } = orderedPro;
    const ids = idsOf(
      buildItemSets(CAMILLE, "Top", build(noSlotSignalItems()), unorderedPro, CATALOG),
      "Pro most built"
    );
    expect(ids.filter((id) => id !== PLATED).slice(0, 5)).toEqual([
      TRINITY_FORCE,
      RAVENOUS_HYDRA,
      DEATHS_DANCE,
      STERAKS,
      GUARDIAN_ANGEL,
    ]);
  });

  it("takes the boots the source handed it, even when the champion's own core boot differs", () => {
    // RC-4: `bp` carries the boot pros BOUGHT. Camille's model boot is
    // Mercury's Treads; her pros buy Plated Steelcaps 35 of 54 games.
    const ids = idsOf(buildItemSets(CAMILLE, "Top", build(camilleItems()), orderedPro, CATALOG), "Pro build");
    expect(ids).toContain(PLATED);
    expect(ids).not.toContain(MERCURYS);
  });
});

describe("a block only claims to be a build when its source could measure one", () => {
  const items = [
    { itemId: TRINITY_FORCE, share: 0.99 },
    { itemId: RAVENOUS_HYDRA, share: 0.8 },
    { itemId: DEATHS_DANCE, share: 0.39 },
  ];
  const boots = [{ itemId: PLATED, share: 0.51 }];

  it("titles an ORDERED source `<source> build`", () => {
    const sets = buildItemSets(
      CAMILLE,
      "Top",
      build(camilleItems()),
      { items, boots, ordered: true },
      CATALOG,
      { items, boots, ordered: true }
    );
    const types = typesOf(sets);
    expect(types).toContain("Pro build");
    expect(types.some((t) => t.startsWith("OTP build"))).toBe(true);
  });

  it("titles a FREQUENCY-only source `<source> most built`", () => {
    // This is the permanent state of OTP: /api/otp sets purchaseOrder: []
    // unconditionally, so there is no order to claim and the title must not
    // imply one. Ahri's live OTP block shipped Malignance ... Blackfire Torch
    // at positions 1 and 6 — a pair lib/buildSlots.ts measured at LIFT 0,
    // never built together — as if it were a sequence.
    const sets = buildItemSets(CAMILLE, "Top", build(noSlotSignalItems()), { items, boots }, CATALOG, {
      items,
      boots,
    });
    const types = typesOf(sets);
    expect(types).toContain("Pro most built");
    expect(types.some((t) => t.startsWith("OTP most built"))).toBe(true);
    expect(types).not.toContain("Pro build");
  });

  it("mixes: an ordered Pro block beside a frequency-only OTP block", () => {
    // RC-5: the Pro block declares `ordered` but publishes no `orderedIds`, so
    // there is nothing for the OTP block to inherit — the mixed state an
    // artifact baked BEFORE RC-5 produces, read by this code. With no slot
    // signal either, the OTP block is a genuine residual.
    const sets = buildItemSets(
      CAMILLE,
      "Top",
      build(noSlotSignalItems()),
      { items, boots, ordered: true },
      CATALOG,
      { items: [...items, { itemId: MAW, share: 0.1 }], boots }
    );
    const types = typesOf(sets);
    expect(types).toContain("Pro build");
    expect(types.some((t) => t.startsWith("OTP most built"))).toBe(true);
  });
});
