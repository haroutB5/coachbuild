/**
 * The eight real champion-roles, driven end to end through `buildItemSets`
 * against CAPTURED LIVE DATA — the committed patch-16.16 consensus artifact and
 * the exact `/api/build` item blocks production served on 2026-08-28.
 *
 * Everything else in this directory tests the ordering RULES against fixtures
 * shaped to exercise them. This file tests the ANSWER: what a player would have
 * seen in their shop. It exists because the two previous passes were both
 * verified by unit tests that stayed green while the exported blocks were still
 * wrong for a reason no synthetic fixture contained — RC-2 could not see that
 * every OTP block in production is timeline-less (`/api/otp` returns
 * `purchaseOrder: []` unconditionally), because the fixtures supplied one.
 *
 * ── The two claims the user made, and where they are pinned ────────────────
 *
 *   "Rocketbelt is always bought in the first two items, never later."
 *     -> VIKTOR MID, OTP block. Shipped 5th of 5 legendaries; asserted <= 2nd.
 *   "Black Cleaver is always first."
 *     -> URGOT TOP, Pro block. Shipped 3rd (behind Sterak's Gage, off a
 *        ONE-game pro sample); asserted 1st.
 *
 * ── Why the whole expected row is pinned, not just those two ───────────────
 *
 * `fixtures/consensus-block-order.json` is a dated capture, so this table is a
 * regression oracle for the export as a whole: any change to the prior
 * cascade, the boots rule, block padding or `buildLine` shows up here as a
 * named item moving, in a diff a human can read. It is a CAPTURE, not a
 * derivation — if the real answer for one of these changes, the fixture is
 * re-captured deliberately and the diff is the review.
 */
import { describe, it, expect } from "vitest";
import fixture from "@/fixtures/consensus-block-order.json";
import {
  CONSENSUS_ARTIFACT_SCHEMA,
  consensusSourceToInput,
  currentConsensusQuery,
  parseConsensusArtifact,
} from "../hextech/consensusArtifact";
import { buildItemSets } from "../hextech/itemSetBody";
import type { ItemDetail } from "@/components/itemDetail";
import type { BuildResponse, ChampionRef, ItemsBlock } from "@/lib/types";

const CATALOG = new Map<number, ItemDetail>(
  Object.values(fixture.catalog as Record<string, Omit<ItemDetail, "descriptionText">>).map((c) => [
    c.id,
    { ...c, descriptionText: "" } as ItemDetail,
  ])
);

const name = (id: number): string => CATALOG.get(id)?.name ?? `#${id}`;

/** The captured entries, read back through the PRODUCTION parser.
 *
 *  Not a typing convenience — `parseConsensusArtifact` fails closed on any
 *  shape it does not fully understand, so routing the fixture through it makes
 *  "this capture is still something the shipped reader accepts" an assertion
 *  rather than an assumption. It also keeps the file free of the `as never`
 *  casts that let three runtime breakages through tsc in this directory on
 *  2026-08-27. */
const ENTRIES = parseConsensusArtifact({
  schema: CONSENSUS_ARTIFACT_SCHEMA,
  patch: fixture.patch,
  generatedAt: fixture.artifactGeneratedAt,
  query: currentConsensusQuery(),
  coverage: { combos: fixture.combos.length, pro: 0, otp: 0 },
  entries: Object.fromEntries(fixture.combos.map((c) => [c.key, c.consensus])),
})?.entries;

type Combo = (typeof fixture.combos)[number];

function exportFor(combo: Combo) {
  const champ: ChampionRef = {
    id: combo.championId,
    key: combo.championKey,
    name: combo.championName,
    icon: `${combo.championKey}.png`,
  };
  const build = {
    champion: champ,
    role: combo.role,
    roleLabel: combo.roleLabel,
    patch: combo.patch,
    tierLabel: "Diamond+",
    runes: {} as BuildResponse["runes"],
    spells: [],
    items: combo.items as unknown as ItemsBlock,
    generatedAt: fixture.capturedAt,
    sources: { provider: "coachless.gg" as const },
  } as unknown as BuildResponse;
  return buildItemSets(
    champ,
    combo.roleLabel,
    build,
    consensusSourceToInput(ENTRIES?.[combo.key]?.pro ?? null),
    CATALOG,
    consensusSourceToInput(ENTRIES?.[combo.key]?.otp ?? null)
  );
}

/** Every consensus block of one combo, `{ title: [itemId, ...] }`. */
function consensusBlocks(combo: Combo): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const block of exportFor(combo).sets[0].blocks) {
    if (!/^(Pro|OTP)/.test(block.type)) continue;
    out[block.type] = block.items.map((i) => Number(i.id));
  }
  return out;
}

/** A block's items with boots removed, so "legendary position N" means what it
 *  says. `buildLine` reinserts boots at BOOTS_LINE_INDEX independently of every
 *  ordering rule under test here. */
function legendaries(ids: number[]): number[] {
  return ids.filter((id) => !(CATALOG.get(id)?.tags ?? []).includes("Boots"));
}

const comboBy = (key: string): Combo => fixture.combos.find((c) => c.key === key)!;

// ── ids, named ──────────────────────────────────────────────────────────────
const HEXTECH_ROCKETBELT = 3152;
const BLACK_CLEAVER = 3071;
const TRINITY_FORCE = 3078;
const INFINITY_EDGE = 3031;
const HEXOPTICS = 2523;

describe("the capture itself", () => {
  it("is the patch the committed artifact was baked for", () => {
    // A fixture captured against a different patch would test the rules
    // against numbers no deployment ever served.
    expect(fixture.patch).toBe("16.16");
    expect(fixture.combos).toHaveLength(8);
    expect(Object.keys(fixture.catalog).length).toBeGreaterThan(100);
    // The production reader accepted every captured entry. A `null` here means
    // the capture drifted out of the schema the shipped code reads.
    expect(Object.keys(ENTRIES ?? {})).toHaveLength(fixture.combos.length);
  });
});

describe("the user's two verdicts, 2026-08-28", () => {
  it("Viktor Mid OTP: Hextech Rocketbelt is within the first TWO legendaries", () => {
    // Shipped: Blackfire -> Spellslinger's -> Liandry's -> Zhonya's ->
    // ROCKETBELT -> Rabadon's, i.e. legendary 4 of 5, because 23% of those
    // one-tricks ended the game holding Zhonya's against Rocketbelt's 17%.
    // The pro corpus for the same champion-role measured Rocketbelt at median
    // purchase position 2 and Zhonya's at 5, over 101 timelines.
    const ids = legendaries(consensusBlocks(comboBy("112|2"))["OTP build"]);
    expect(ids.map(name).slice(0, 2)).toContain("Hextech Rocketbelt");
    expect(ids.indexOf(HEXTECH_ROCKETBELT)).toBe(1);
  });

  it("Urgot Top Pro: Black Cleaver is the FIRST legendary", () => {
    // Shipped: STERAK'S -> Steelcaps -> Black Cleaver -> ... off a pro sample
    // of ONE game (measured 2026-08-28: /api/pros?championId=6&role=0 returns
    // games: 1, none with a timeline), where "most built" is a three-way tie
    // broken by item id. The champion's own model puts Black Cleaver in the
    // slot-1 pool with 8,532 occurrences and in no other pool at all.
    const ids = legendaries(consensusBlocks(comboBy("6|0"))["Pro build"]);
    expect(ids[0]).toBe(BLACK_CLEAVER);
  });

  it("Urgot Top OTP: Black Cleaver is the first legendary there too", () => {
    expect(legendaries(consensusBlocks(comboBy("6|0"))["OTP build"])[0]).toBe(BLACK_CLEAVER);
  });
});

describe("the standing claims, re-checked against the same capture", () => {
  it("no consensus block on these eight is still frequency-ordered", () => {
    // "most built" is reserved for the residual — blocks with no positional
    // evidence of any kind. Measured on the committed artifact that is 17 pro
    // and 3 OTP blocks of the 551 the export can render, and none of them is
    // one of these eight.
    for (const combo of fixture.combos) {
      for (const title of Object.keys(consensusBlocks(combo))) {
        expect(`${combo.label} ${title}`).not.toContain("most built");
      }
    }
  });

  it("Trinity Force is first in every consensus block that lists it", () => {
    // The predecessor's named test case. Median purchase position #1 on Jax
    // Top (n=38), Camille Top (n=69) and Ezreal Bot (n=99).
    for (const combo of fixture.combos) {
      for (const [title, ids] of Object.entries(consensusBlocks(combo))) {
        const legendary = legendaries(ids);
        if (!legendary.includes(TRINITY_FORCE)) continue;
        expect(`${combo.label} ${title}: ${legendary.map(name).join(" -> ")}`).toBe(
          `${combo.label} ${title}: ${[TRINITY_FORCE, ...legendary.filter((id) => id !== TRINITY_FORCE)]
            .map(name)
            .join(" -> ")}`
        );
      }
    }
  });

  it("Jinx Bot no longer opens on Infinity Edge in EITHER consensus block", () => {
    // RC-2's headline case, now also true of the OTP block: Infinity Edge is
    // the most-built item (70% of pros end holding it) and the third-bought
    // one. The OTP block had no timelines of its own and shipped it first.
    for (const [title, ids] of Object.entries(consensusBlocks(comboBy("222|3")))) {
      const legendary = legendaries(ids);
      expect(`${title} ${name(legendary[0])}`).toBe(`${title} ${name(HEXOPTICS)}`);
      expect(legendary.indexOf(INFINITY_EDGE)).toBeGreaterThan(2);
    }
  });

  it("puts boots at index 1 in every consensus block", () => {
    // RC-1, measured over 978 pro timelines: slot 4 was correct in 4.4% of
    // them. A prior that reordered the pool must not disturb this.
    for (const combo of fixture.combos) {
      for (const [title, ids] of Object.entries(consensusBlocks(combo))) {
        const bootsIndex = ids.findIndex((id) => (CATALOG.get(id)?.tags ?? []).includes("Boots"));
        expect(`${combo.label} ${title} boots@${bootsIndex}`).toBe(`${combo.label} ${title} boots@1`);
      }
    }
  });
});

describe("the exported rows, captured 2026-08-28", () => {
  /** Verified by value against the live prod artifact + `/api/build` before it
   *  was written down. Re-capture deliberately if the real answer moves. */
  const EXPECTED: Record<string, Record<string, number[]>> = {
    "112|2": {
      "Pro build": [2503, 3020, 3152, 6653, 3089, 3157],
      "OTP build": [2503, 3175, 3152, 6653, 3089, 3157],
    },
    "6|0": {
      "Pro build": [3071, 3047, 3053, 6665, 2504, 3181],
      "OTP build": [3071, 3047, 3053, 3742, 2504, 3143],
    },
    "103|2": {
      "Pro build": [3118, 3158, 2503, 3100, 3152, 3089],
      "OTP build": [3118, 3175, 2503, 3100, 3089, 3157],
    },
    "222|3": {
      "Pro build": [2523, 3006, 3032, 3085, 3046, 3031],
      "OTP build": [2523, 3008, 3032, 3085, 3046, 3031],
    },
    "412|4": {
      "Pro build": [3190, 3009, 3876, 3109, 3222, 2524],
      "OTP build (same as Pro build)": [3190, 3009, 3876, 3109, 3222, 2524],
    },
    "81|3": {
      "Pro build": [3078, 3158, 2517, 3161, 6694, 3036],
      "OTP build": [3078, 3047, 2517, 3161, 6694, 3026],
    },
    "24|0": {
      "Pro build": [3078, 3047, 6610, 6631, 3157, 3053],
      "OTP build": [3078, 3111, 3157, 2510, 3146, 3153],
    },
    "164|0": {
      "Pro build": [3078, 3047, 3074, 6333, 3053, 3156],
      "OTP build": [3078, 3047, 3074, 6333, 3053, 3026],
    },
  };

  it.each(fixture.combos.map((c) => [c.label, c.key] as const))("%s", (_label, key) => {
    const actual = consensusBlocks(comboBy(key));
    // Names, not ids: a failure has to be readable as "Zhonya's moved ahead of
    // Rocketbelt", not as a row of four-digit numbers.
    const asNames = (o: Record<string, number[]>) =>
      Object.fromEntries(Object.entries(o).map(([t, ids]) => [t, ids.map(name)]));
    expect(asNames(actual)).toEqual(asNames(EXPECTED[key]));
  });
});
