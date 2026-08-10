/**
 * runeLabelColumns — the labelled rune row's column count.
 *
 * Background (user-reported P1, 2026-08-10): every rune modal renders
 * `RuneOptionRow` with `compact`, which used to hand each option a fixed 38px
 * box inside a `flex … items-center` column. `align-items: center` sizes a
 * flex child to its CONTENT, so the label's own `overflow` never fired and a
 * name wider than the box painted over its neighbours (measured on Viktor:
 * "Transcendence" 66.0px in a 38px column, overlapping "Celerity" by 7.5px).
 * The row is a CSS grid of equal `1fr` tracks now, and this function decides
 * how many tracks.
 *
 * The 4 -> 2 case is the load-bearing one: Precision and Sorcery have four
 * keystones, and four tracks inside the modal's ~166px tree column leave ~38px
 * each — too narrow for "Stormraider's Surge" at any clamp. 2x2 gives ~80px.
 *
 * Layout itself is not asserted here: the harness is vitest in `node` with no
 * DOM, so the pixel behaviour was verified in a real browser instead (see the
 * v0.105.x CHANGELOG entry) and only the pure decision is unit-tested.
 */
import { describe, it, expect } from "vitest";
import { runeLabelColumns } from "@/components/hextech/builds/BuildVisuals";

describe("runeLabelColumns", () => {
  it("keeps a minor/shard row (3 options) on one line", () => {
    expect(runeLabelColumns(3)).toBe(3);
  });

  it("wraps a 4-keystone row into 2x2 so the widest keystone name still fits", () => {
    expect(runeLabelColumns(4)).toBe(2);
  });

  it("never returns 0 tracks, even for an empty row rendering only the no-data slot", () => {
    expect(runeLabelColumns(0)).toBe(1);
    expect(runeLabelColumns(1)).toBe(1);
  });

  it("caps at 3 tracks if a source ever appends extra options to a row", () => {
    expect(runeLabelColumns(5)).toBe(3);
    expect(runeLabelColumns(7)).toBe(3);
  });
});
