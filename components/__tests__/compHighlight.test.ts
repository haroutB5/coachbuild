import { describe, it, expect } from "vitest";
import { selectCompAwareHighlights } from "../live/compHighlight";
import type { Pick } from "@/lib/types";

function pick(id: number, matchupConditioned?: boolean): Pick {
  return {
    id,
    name: `Item ${id}`,
    icon: `icon-${id}`,
    wpa: 0.01,
    winrate: null,
    occurrence: 1000,
    matchupConditioned,
  };
}

describe("selectCompAwareHighlights", () => {
  it("returns [] when no enemy comp is known", () => {
    const situational = [pick(1, true), pick(2, true)];
    expect(selectCompAwareHighlights(situational, [])).toEqual([]);
  });

  it("returns [] when nothing in the list is matchup-conditioned (today's honest default — matchup unsupported)", () => {
    const situational = [pick(1), pick(2), pick(3, false)];
    expect(selectCompAwareHighlights(situational, [103])).toEqual([]);
  });

  it("returns only the ids that are actually matchupConditioned: true", () => {
    const situational = [pick(1, false), pick(2, true), pick(3), pick(4, true)];
    expect(selectCompAwareHighlights(situational, [103])).toEqual([2, 4]);
  });

  it("never returns an id that wasn't in the input list (compliance: never invents)", () => {
    const situational = [pick(1, true), pick(2, true)];
    const result = selectCompAwareHighlights(situational, [103, 104]);
    const inputIds = new Set(situational.map((p) => p.id));
    for (const id of result) {
      expect(inputIds.has(id)).toBe(true);
    }
  });

  it("preserves the relative order of the source list (a reorder, not a re-rank)", () => {
    const situational = [pick(10, true), pick(11, false), pick(12, true), pick(13, true)];
    expect(selectCompAwareHighlights(situational, [1])).toEqual([10, 12, 13]);
  });
});
