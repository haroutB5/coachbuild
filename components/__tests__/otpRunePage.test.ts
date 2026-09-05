// The OTP rune grid's contract: the fraction drawn under a rune is that rune's
// own count, and no other number ever reaches the screen. These tests run the
// REAL aggregation (lib/otp/featured.ts) into the REAL grid adapter, so a drift
// between the two is a failure here rather than a wrong number on the card.

import { describe, expect, it } from "vitest";
import { buildFeaturedModel, type FeaturedMatchRow, type OtpRunePageSamples } from "../../lib/otp/featured";
import { otpRunePage, slotGridSample } from "../hextech/otpRunePage";

import { SHARD_ROWS } from "../hextech/perkSlots";

const runeOf = (id: number) => ({ name: `R${id}`, icon: "" });

function runes(over: {
  primaryTree?: number;
  keystone?: number | null;
  primary?: (number | null)[];
  secondaryTree?: number | null;
  secondary?: number[];
  shards?: (number | null)[];
} = {}) {
  const strip = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
  return {
    primaryTree: over.primaryTree ?? 8200,
    keystone: over.keystone === undefined ? 8214 : over.keystone,
    primary: strip(over.primary ?? [8226, 8234, 8237]),
    secondaryTree: over.secondaryTree === undefined ? 8000 : over.secondaryTree,
    secondary: over.secondary ?? [9105, 8017],
    shards: strip(over.shards ?? [5008, 5008, 5011]),
  };
}

const game = (over: Partial<FeaturedMatchRow> = {}): FeaturedMatchRow => ({
  win: true,
  final_items: [3100],
  runes: runes(),
  spells: [4, 6],
  skill_order: null,
  ...over,
});

/** The same uneven-coverage sample the aggregation tests use: row 1 missing
 *  from one game, row 2 from two, so the three rows cannot share a fraction. */
function unevenModel() {
  return buildFeaturedModel([
    game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
    game({ runes: runes({ primary: [8226, 8234, 8237] }) }),
    game({ runes: runes({ primary: [8226, 8234, 8232] }) }),
    game({ runes: runes({ primary: [8226, 8210, null] }) }),
    game({ runes: runes({ primary: [8275, null, null] }) }),
  ]);
}

describe("otpRunePage", () => {
  it("draws each row the fraction the aggregation computed for that row", () => {
    const model = unevenModel();
    const slots = model.runes!.slots;
    const grid = otpRunePage(model.runes!.page, runeOf, slots, SHARD_ROWS);

    [0, 1, 2].forEach((row) => {
      const source = slots.primaryRows[row]!;
      expect(grid.primaryRows[row].sample).toEqual({ count: source.count, denominator: source.sampleSize });
      expect(grid.primaryRows[row].selectedIds.has(source.runeId)).toBe(true);
    });
    // The rendered fractions, read as the card prints them.
    expect(grid.primaryRows.map((r) => `${r.sample!.count}/${r.sample!.denominator}`)).toEqual(["4/5", "3/4", "2/3"]);
    // And none of them is the exact-page figure, which is what the pre-v0.105.2
    // card repeated under every rune.
    expect(`${model.runes!.games}/${model.games}`).toBe("2/5");
  });

  it("gives the keystone and the shards their own fractions too", () => {
    const model = unevenModel();
    const grid = otpRunePage(model.runes!.page, runeOf, model.runes!.slots, SHARD_ROWS);
    expect(grid.keystone!.sample).toEqual({ count: 5, denominator: 5 });
    expect(grid.shards[0].sample).toEqual({ count: 5, denominator: 5 });
  });

  it("renders a row no game filled as empty with no fraction at all", () => {
    const model = buildFeaturedModel([
      game({ runes: runes({ primary: [8226, 8234, null], shards: [5008, 5008, null] }) }),
      game({ runes: runes({ primary: [8226, 8234, null], shards: [5008, 5008, null] }) }),
    ]);
    const grid = otpRunePage(model.runes!.page, runeOf, model.runes!.slots, SHARD_ROWS);
    expect(grid.primaryRows[2].empty).toBe(true);
    expect(grid.primaryRows[2].sample).toBeNull();
    expect(grid.primaryRows[2].selectedIds.size).toBe(0);
    expect(grid.shards[2].empty).toBe(true);
    expect(grid.shards[2].sample).toBeNull();
    // The static options are still drawn for context — absence is shown, not
    // hidden — but nothing in that row is marked as picked.
    expect(grid.primaryRows[2].options.length).toBeGreaterThan(0);
    expect(grid.primaryRows[2].options.every((o) => o.occurrence === 0)).toBe(true);
  });

  it("places a secondary count under the rune it belongs to, not by array order", () => {
    const model = buildFeaturedModel([
      game({ runes: runes({ secondary: [9105, 8017] }) }),
      game({ runes: runes({ secondary: [8017, 9105] }) }),
    ]);
    const grid = otpRunePage(model.runes!.page, runeOf, model.runes!.slots, SHARD_ROWS);
    expect(grid.secondaryRows[0].empty).toBe(true);
    expect(grid.secondaryRows[1].selectedIds.has(9105)).toBe(true);
    expect(grid.secondaryRows[1].sample).toEqual({ count: 2, denominator: 2 });
    expect(grid.secondaryRows[2].selectedIds.has(8017)).toBe(true);
    expect(grid.secondaryRows[2].sample).toEqual({ count: 2, denominator: 2 });
  });

  it("drops a count that belongs to a different rune rather than mislabelling one", () => {
    // The guard that makes a future drift between aggregation and adapter show
    // up as a MISSING number instead of a wrong one.
    const model = unevenModel();
    const tampered: OtpRunePageSamples = {
      ...model.runes!.slots,
      primaryRows: [{ runeId: 9999, count: 4, sampleSize: 5 }, null, null],
    };
    const grid = otpRunePage(model.runes!.page, runeOf, tampered, SHARD_ROWS);
    expect(grid.primaryRows[0].selectedIds.has(8226)).toBe(true);
    expect(grid.primaryRows[0].sample).toBeNull();
  });

  it("draws no fractions when the response carried no per-slot counts", () => {
    // An offline service-worker body cached before v0.105.2. The runes must
    // still render; the numbers must not fall back to the page-level figure.
    const model = unevenModel();
    const grid = otpRunePage(model.runes!.page, runeOf, undefined, SHARD_ROWS);
    const every = [grid.keystone, ...grid.primaryRows, ...grid.secondaryRows, ...grid.shards];
    for (const row of every) expect(row?.sample ?? null).toBeNull();
    expect(grid.primaryRows[0].selectedIds.has(8226)).toBe(true);
  });

  it("refuses an impossible sample", () => {
    expect(slotGridSample({ runeId: 8226, count: 6, sampleSize: 5 }, 8226)).toBeNull();
    expect(slotGridSample({ runeId: 8226, count: 0, sampleSize: 0 }, 8226)).toBeNull();
    expect(slotGridSample({ runeId: 8226, count: 3, sampleSize: 5 }, 8226)).toEqual({ count: 3, denominator: 5 });
  });
});
