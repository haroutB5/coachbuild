/**
 * itemSetBody — RC-5, the POSITIONAL PRIOR cascade.
 *
 * `itemSetBodyOrder.test.ts` owns the claim that a block which measured its own
 * purchase order ships in it. This file owns what happens when it did not.
 *
 * RC-2 made that case honest: no order claim, and a "most built" title so the
 * block stopped presenting a frequency ranking as a sequence. It was still a
 * frequency ranking, in a League shop panel, rendered as a left-to-right row —
 * and in the committed patch-16.16 artifact that is 236 of 442 pro entries and
 * ALL 297 OTP entries.
 *
 * The user's verdict on the live export, 2026-08-28:
 *
 *   Viktor Mid, "OTP most built"
 *     Blackfire -> Spellslinger's -> Liandry's -> Zhonya's -> ROCKETBELT -> Rabadon's
 *     "Rocketbelt is always bought in the first two items, never later."
 *   Urgot Top, "Pro most built"
 *     STERAK'S -> Steelcaps -> Black Cleaver -> Jak'Sho -> Kaenic -> Hullbreaker
 *     "Black Cleaver is always first."
 *
 * Directive: frequency order is not an acceptable fallback anywhere a block
 * reads as a build. The cascade, in strength order:
 *
 *   1. the source's OWN median purchase positions      (RC-2, `ordered`)
 *   2. the OTHER source's, for the same champion-role  (cross-source)
 *   3. the WPA model's per-slot occurrence pools       (wpa-slot)
 *   4. frequency — and then the title must not say "build"
 *
 * Every case below is shaped on a real live disagreement; the ids are Camille's
 * synthetic catalog so the suite stays independent of the item CDN.
 */
import { describe, it, expect } from "vitest";
import { buildItemSets as buildItemSetExport } from "../hextech/itemSetBody";
import type { BuildResponse, ChampionRef, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";

const buildItemSets = (...args: Parameters<typeof buildItemSetExport>) => buildItemSetExport(...args).sets;

const TRINITY_FORCE = 3078;
const RAVENOUS_HYDRA = 3074;
const DEATHS_DANCE = 6333;
const STERAKS = 3053;
const MAW = 3156;
const GUARDIAN_ANGEL = 3026;
const MERCURYS = 3111;
const PLATED = 3047;
const DORANS_BLADE = 1055;

const CAMILLE: ChampionRef = { id: 164, key: "Camille", name: "Camille", icon: "camille.png" };

function pick(id: number, occurrence = 5000, wpa = 0.02): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: 52, occurrence };
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

/** A model whose per-slot pools rank the four legendaries used below. */
function slotItems(): ItemsBlock {
  return {
    starter: pick(DORANS_BLADE),
    boots: pick(MERCURYS, 17398),
    first: pick(TRINITY_FORCE, 30942),
    second: pick(RAVENOUS_HYDRA, 7505),
    third: pick(STERAKS, 3276),
    fourthPlus: [pick(DEATHS_DANCE, 2862)],
  };
}

/** A model whose per-slot pools name ids NOTHING in the consensus blocks uses —
 *  the residual case, and the only shape in which a block may still be
 *  frequency-ordered. Live example: pro entry `54|1`, whose one consensus item
 *  appears in no slot pool of that champion-role's model. */
function unrelatedSlotItems(): ItemsBlock {
  return {
    starter: pick(DORANS_BLADE),
    boots: pick(MERCURYS, 17398),
    first: pick(7001, 9000),
    second: pick(7002, 8000),
    third: pick(7003, 7000),
    fourthPlus: [pick(7004, 6000)],
  };
}

function typesOf(sets: ReturnType<typeof buildItemSets>): string[] {
  return sets[0].blocks.map((b) => b.type);
}

function idsOf(sets: ReturnType<typeof buildItemSets>, prefix: string): number[] {
  const block = sets[0].blocks.find((b) => b.type.startsWith(prefix))!;
  return block.items.map((i) => Number(i.id)).filter((id) => id !== PLATED && id !== MERCURYS);
}

// ── 2. cross-source ─────────────────────────────────────────────────────────

describe("cross-source prior — the OTHER source's measured order", () => {
  /** Viktor Mid's shape. The pro entry measured a real median purchase order;
   *  the OTP entry has no timelines at all (`/api/otp` sets `purchaseOrder: []`
   *  unconditionally — re-measured 2026-08-28: 111 Viktor OTP games, 0 with a
   *  timeline) and its frequency ranking disagrees with that order on exactly
   *  the item the user named. */
  const proOrder = [TRINITY_FORCE, RAVENOUS_HYDRA, DEATHS_DANCE, STERAKS, MAW];
  const orderedPro = {
    items: proOrder.map((itemId, i) => ({ itemId, share: 0.9 - i * 0.1 })),
    boots: [{ itemId: PLATED, share: 0.51 }],
    ordered: true,
    orderedIds: proOrder,
  };
  /** Frequency puts DEATHS_DANCE first and RAVENOUS_HYDRA last — the Rocketbelt
   *  shape: mid purchase position, high final-inventory share. */
  const unorderedOtp = {
    items: [
      { itemId: DEATHS_DANCE, share: 0.71 },
      { itemId: TRINITY_FORCE, share: 0.62 },
      { itemId: STERAKS, share: 0.4 },
      { itemId: RAVENOUS_HYDRA, share: 0.22 },
    ],
    boots: [{ itemId: PLATED, share: 0.44 }],
  };

  it("orders the OTP block by the pro corpus's measured positions", () => {
    const sets = buildItemSets(CAMILLE, "Top", build(slotItems()), orderedPro, CATALOG, unorderedOtp);
    expect(idsOf(sets, "OTP")).toEqual([TRINITY_FORCE, RAVENOUS_HYDRA, DEATHS_DANCE, STERAKS]);
  });

  it("titles it a build — a transferred timeline order IS a purchase order", () => {
    const types = typesOf(buildItemSets(CAMILLE, "Top", build(slotItems()), orderedPro, CATALOG, unorderedOtp));
    expect(types.some((t) => t.startsWith("OTP build"))).toBe(true);
    expect(types.some((t) => t.startsWith("OTP most built"))).toBe(false);
  });

  it("does not fire when the other source has no measured order either", () => {
    const { ordered: _o, orderedIds: _p, ...unorderedPro } = orderedPro;
    const types = typesOf(
      buildItemSets(CAMILLE, "Top", build(unrelatedSlotItems()), unorderedPro, CATALOG, unorderedOtp)
    );
    expect(types).toContain("Pro most built");
    expect(types.some((t) => t.startsWith("OTP most built"))).toBe(true);
  });

  it("does not fire when the other source is absent entirely", () => {
    const types = typesOf(
      buildItemSets(CAMILLE, "Top", build(unrelatedSlotItems()), null, CATALOG, unorderedOtp)
    );
    expect(types.some((t) => t.startsWith("OTP most built"))).toBe(true);
  });

  it("leaves an item the other source never positioned behind every one it did", () => {
    // Rod of Ages, live: a genuine Viktor first item the pro sample never
    // positioned. Filling it in from a weaker prior would seat a 13%-share item
    // at the head of the block and push a measured item out of the six slots.
    const withExtra = {
      ...unorderedOtp,
      items: [{ itemId: GUARDIAN_ANGEL, share: 0.99 }, ...unorderedOtp.items],
    };
    const ids = idsOf(buildItemSets(CAMILLE, "Top", build(slotItems()), orderedPro, CATALOG, withExtra), "OTP");
    expect(ids.indexOf(GUARDIAN_ANGEL)).toBeGreaterThan(ids.indexOf(STERAKS));
  });

  it("runs in BOTH directions — an ordered OTP source rescues a thin PRO block", () => {
    // Today this direction never fires in production, for one measured reason:
    // `/api/otp` ships no timelines, so an OTP source can never be `ordered`.
    // It is written and tested anyway because the asymmetry is a property of
    // the DATA, not of the rule — the day that ingest starts fetching
    // timelines, a 1-game pro block like Urgot Top's starts being ordered by
    // 200 one-trick games with no code change, and a one-directional
    // implementation would silently not do that.
    const otpOrder = [STERAKS, TRINITY_FORCE, RAVENOUS_HYDRA];
    const orderedOtp = {
      items: otpOrder.map((itemId, i) => ({ itemId, share: 0.9 - i * 0.1 })),
      boots: [{ itemId: PLATED, share: 0.44 }],
      ordered: true,
      orderedIds: otpOrder,
    };
    const thinPro = {
      items: [
        { itemId: TRINITY_FORCE, share: 1 },
        { itemId: RAVENOUS_HYDRA, share: 1 },
        { itemId: STERAKS, share: 1 },
      ],
      boots: [{ itemId: PLATED, share: 1 }],
    };
    const sets = buildItemSets(
      CAMILLE,
      "Top",
      build(unrelatedSlotItems()),
      thinPro,
      CATALOG,
      orderedOtp
    );
    expect(typesOf(sets)).toContain("Pro build");
    expect(idsOf(sets, "Pro build").slice(0, 3)).toEqual(otpOrder);
  });

  it("does not let a BOOT in the transferred order be the evidence", () => {
    // A boot is pinned to the head of the pool and `buildLine` reinserts it at
    // BOOTS_LINE_INDEX regardless, so it carries no information about the
    // legendary sequence. If it counted, a block with ONE positioned legendary
    // would clear the two-item floor and start calling itself a build.
    const otpOrder = [PLATED, TRINITY_FORCE];
    const orderedOtp = {
      items: [{ itemId: TRINITY_FORCE, share: 0.8 }],
      boots: [{ itemId: PLATED, share: 0.44 }],
      ordered: true,
      orderedIds: otpOrder,
    };
    const thinPro = {
      items: [
        { itemId: TRINITY_FORCE, share: 0.9 },
        { itemId: MAW, share: 0.4 },
      ],
      boots: [{ itemId: PLATED, share: 0.5 }],
    };
    const types = typesOf(
      buildItemSets(CAMILLE, "Top", build(unrelatedSlotItems()), thinPro, CATALOG, orderedOtp)
    );
    expect(types).toContain("Pro most built");
  });

  it("transfers only the POSITIONED prefix, never the whole item list", () => {
    // `orderedIds` is the source's `p` — the ids its timelines actually
    // positioned. `items` additionally carries every unpositioned id behind
    // them. Ranking by `items` instead would hand the next block an order the
    // sample never measured.
    const partiallyOrderedPro = {
      items: [
        { itemId: TRINITY_FORCE, share: 0.9 },
        { itemId: RAVENOUS_HYDRA, share: 0.8 },
        { itemId: DEATHS_DANCE, share: 0.7 },
        { itemId: STERAKS, share: 0.6 },
      ],
      boots: [{ itemId: PLATED, share: 0.51 }],
      ordered: true,
      orderedIds: [TRINITY_FORCE, RAVENOUS_HYDRA],
    };
    const otp = {
      items: [
        { itemId: STERAKS, share: 0.8 },
        { itemId: DEATHS_DANCE, share: 0.7 },
        { itemId: RAVENOUS_HYDRA, share: 0.3 },
        { itemId: TRINITY_FORCE, share: 0.2 },
      ],
      boots: [{ itemId: PLATED, share: 0.44 }],
    };
    const ids = idsOf(
      buildItemSets(CAMILLE, "Top", build(unrelatedSlotItems()), partiallyOrderedPro, CATALOG, otp),
      "OTP"
    );
    // `.slice(0, 4)`: buildLine pads a short line from the champion's own
    // pools, and that padding is not this test's subject.
    expect(ids.slice(0, 4)).toEqual([TRINITY_FORCE, RAVENOUS_HYDRA, STERAKS, DEATHS_DANCE]);
  });
});

// ── 3. WPA per-slot ─────────────────────────────────────────────────────────

describe("WPA per-slot prior — when neither source measured anything", () => {
  /** Urgot Top's real shape: a ONE-game pro sample (measured 2026-08-28:
   *  `/api/pros?championId=6&role=0` returns `games: 1`, zero timelines) whose
   *  frequency ranking leads with Sterak's Gage, beside a 200-game OTP sample
   *  with no timelines. The champion's own model knows Black Cleaver is a first
   *  item — 8,532 occurrences in the slot-1 pool and nothing anywhere else. */
  const items = [
    { itemId: STERAKS, share: 0.56 },
    { itemId: TRINITY_FORCE, share: 0.93 },
    { itemId: DEATHS_DANCE, share: 0.18 },
  ];
  const bootsIn = [{ itemId: PLATED, share: 0.47 }];

  it("orders by the model's own per-slot occurrence pools", () => {
    // slotItems(): first = TRINITY_FORCE, second = RAVENOUS_HYDRA,
    // third = STERAKS, fourthPlus = DEATHS_DANCE. The consensus source supplies
    // three of those four; RAVENOUS_HYDRA arrives as buildLine PADDING, and
    // since RC-5b the prior orders the padding too - it is in the row the
    // player reads, so a block that claims to be a build cannot leave its tail
    // in fallback-priority order.
    const sets = buildItemSets(CAMILLE, "Top", build(slotItems()), { items, boots: bootsIn }, CATALOG);
    expect(idsOf(sets, "Pro").slice(0, 4)).toEqual([
      TRINITY_FORCE,
      RAVENOUS_HYDRA,
      STERAKS,
      DEATHS_DANCE,
    ]);
  });

  it("orders the PADDING as well as the consensus items", () => {
    // The same claim, isolated: MAW is not in the consensus source at all, it
    // is padded in from the champion's own pools, and the model puts it at
    // slot 2. Before RC-5b it sat wherever buildLine's fallback cascade left
    // it, inside a block titled "build".
    const padded: ItemsBlock = {
      ...slotItems(),
      second: pick(MAW, 7505),
      alts: { second: [pick(RAVENOUS_HYDRA, 900)] },
    };
    const ids = idsOf(
      buildItemSets(
        CAMILLE,
        "Top",
        build(padded),
        { items: [{ itemId: TRINITY_FORCE, share: 0.9 }, { itemId: DEATHS_DANCE, share: 0.5 }], boots: bootsIn },
        CATALOG
      ),
      "Pro"
    );
    expect(ids.indexOf(MAW)).toBeGreaterThan(ids.indexOf(TRINITY_FORCE));
    expect(ids.indexOf(MAW)).toBeLessThan(ids.indexOf(DEATHS_DANCE));
  });

  it("PERMUTES the block and never re-selects it", () => {
    // RC-5b, the content-freezing rule, at unit scale. STERAKS has the top
    // share and the model puts it at slot 3; TRINITY_FORCE is bottom share and
    // slot 1. Ordering the POOL would let the prior decide which items survive
    // buildLine's six-slot cut. It does not get to: the item SET is whatever
    // share order selected, and only the sequence moves.
    const wide = {
      items: [
        { itemId: STERAKS, share: 0.9 },
        { itemId: DEATHS_DANCE, share: 0.8 },
        { itemId: GUARDIAN_ANGEL, share: 0.7 },
        { itemId: 7004, share: 0.6 }, // independent item: avoid a Lifeline conflict with Sterak's
        { itemId: RAVENOUS_HYDRA, share: 0.5 },
        { itemId: TRINITY_FORCE, share: 0.4 },
      ],
      boots: bootsIn,
    };
    const withPrior = idsOf(buildItemSets(CAMILLE, "Top", build(slotItems()), wide, CATALOG), "Pro");
    const withoutPrior = idsOf(
      buildItemSets(CAMILLE, "Top", build(unrelatedSlotItems()), wide, CATALOG),
      "Pro"
    );
    expect([...withPrior].sort()).toEqual([...withoutPrior].sort());
    expect(withPrior).not.toEqual(withoutPrior);
    // TRINITY_FORCE has the LOWEST share, so share order cuts it from the six
    // slots - and the model ranks it slot 1. Pulling it in would be the exact
    // re-selection this rule forbids, so it must stay out, and the block must
    // open on the earliest-slot item that WAS selected.
    expect(withPrior).not.toContain(TRINITY_FORCE);
    expect(withPrior[0]).toBe(RAVENOUS_HYDRA);
  });

  it("titles it a build", () => {
    expect(
      typesOf(buildItemSets(CAMILLE, "Top", build(slotItems()), { items, boots: bootsIn }, CATALOG))
    ).toContain("Pro build");
  });

  it("yields to a source that measured its OWN order", () => {
    const ownOrder = [STERAKS, TRINITY_FORCE, DEATHS_DANCE];
    const sets = buildItemSets(
      CAMILLE,
      "Top",
      build(slotItems()),
      { items, boots: bootsIn, ordered: true, orderedIds: ownOrder },
      CATALOG
    );
    expect(idsOf(sets, "Pro").slice(0, 2)).toEqual([STERAKS, TRINITY_FORCE]);
  });

  it("yields to the cross-source prior", () => {
    const proOrder = [DEATHS_DANCE, STERAKS, TRINITY_FORCE];
    const sets = buildItemSets(
      CAMILLE,
      "Top",
      build(slotItems()),
      { items, boots: bootsIn, ordered: true, orderedIds: proOrder },
      CATALOG,
      { items, boots: bootsIn }
    );
    expect(idsOf(sets, "OTP").slice(0, 3)).toEqual(proOrder);
  });

  it("never lets BOOTS be the reason a block claims an order", () => {
    // Exactly one legendary is rankable. The boot IS in the model's boots pool
    // and must not count toward the two-item evidence floor.
    const types = typesOf(
      buildItemSets(
        CAMILLE,
        "Top",
        build({ ...unrelatedSlotItems(), first: pick(TRINITY_FORCE, 9000) }),
        { items: [{ itemId: TRINITY_FORCE, share: 0.9 }, { itemId: MAW, share: 0.3 }], boots: bootsIn },
        CATALOG
      )
    );
    expect(types).toContain("Pro most built");
  });

  it("does not read the model's BOOTS pool as a legendary slot", () => {
    // Ranking Mercury's at "slot 1" would be a claim about a position
    // `buildLine` then overrides with BOOTS_LINE_INDEX — a dead signal that
    // reads as live.
    const sets = buildItemSets(
      CAMILLE,
      "Top",
      build({ ...unrelatedSlotItems(), boots: pick(MERCURYS, 99999) }),
      {
        items: [
          { itemId: MAW, share: 0.9 },
          { itemId: GUARDIAN_ANGEL, share: 0.8 },
        ],
        boots: [{ itemId: MERCURYS, share: 0.7 }],
      },
      CATALOG
    );
    expect(typesOf(sets)).toContain("Pro most built");
  });
});

// ── 4. residual ─────────────────────────────────────────────────────────────

describe("residual — the ONLY case that may still be frequency-ordered", () => {
  const items = [
    { itemId: TRINITY_FORCE, share: 0.4 },
    { itemId: RAVENOUS_HYDRA, share: 0.9 },
    { itemId: DEATHS_DANCE, share: 0.6 },
  ];
  const bootsIn = [{ itemId: PLATED, share: 0.51 }];

  it("keeps share order and says so in the title", () => {
    const sets = buildItemSets(CAMILLE, "Top", build(unrelatedSlotItems()), { items, boots: bootsIn }, CATALOG, {
      items,
      boots: bootsIn,
    });
    expect(typesOf(sets)).toContain("Pro most built");
    expect(typesOf(sets).some((t) => t.startsWith("OTP most built"))).toBe(true);
    expect(idsOf(sets, "Pro most built").slice(0, 3)).toEqual([
      RAVENOUS_HYDRA,
      DEATHS_DANCE,
      TRINITY_FORCE,
    ]);
  });

  it("a single-item block is residual — one item is not an order", () => {
    const types = typesOf(
      buildItemSets(
        CAMILLE,
        "Top",
        build(slotItems()),
        { items: [{ itemId: TRINITY_FORCE, share: 0.9 }], boots: bootsIn },
        CATALOG
      )
    );
    expect(types).toContain("Pro most built");
  });
});
