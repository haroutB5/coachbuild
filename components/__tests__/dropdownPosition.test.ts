import { describe, expect, it } from "vitest";
import { computeDropdownPosition } from "../dropdownPosition";

const VIEWPORT = { width: 1280, height: 800 };

describe("computeDropdownPosition", () => {
  it("positions below the anchor when there is plenty of room", () => {
    const anchor = { top: 100, bottom: 140, left: 50 };
    const coords = computeDropdownPosition(anchor, VIEWPORT);
    expect(coords.top).toBe(146); // bottom + 6px gap
    expect(coords.bottom).toBeUndefined();
    expect(coords.left).toBe(50);
    expect(coords.width).toBe(280); // capped at MAX_WIDTH, well under 90vw
  });

  it("flips above when there's not enough room below but more room above", () => {
    // Anchor near the bottom of a tall viewport: only 60px below, 700px above.
    const anchor = { top: 700, bottom: 740, left: 50 };
    const coords = computeDropdownPosition(anchor, VIEWPORT);
    expect(coords.bottom).toBe(106); // (800 - 700) + 6px gap
    expect(coords.top).toBeUndefined();
  });

  it("stays below when space is tight on both sides but below has more room", () => {
    // Short viewport (mobile-ish): 300px below, 100px above — below still wins.
    const anchor = { top: 100, bottom: 200, left: 20 };
    const coords = computeDropdownPosition(anchor, { width: 400, height: 500 });
    expect(coords.top).toBe(206);
    expect(coords.bottom).toBeUndefined();
  });

  it("stays below (never flips) when both sides are short of room but below is not smaller than above", () => {
    const anchor = { top: 50, bottom: 60, left: 20 };
    // spaceBelow = 500-60=440 (plenty) — sanity: no flip when below has room.
    const coords = computeDropdownPosition(anchor, { width: 400, height: 500 });
    expect(coords.top).toBe(66);
  });

  it("clamps left so a fixed-width dropdown never renders past the right edge", () => {
    const anchor = { top: 10, bottom: 40, left: 1250 }; // near the right edge of a 1280-wide viewport
    const coords = computeDropdownPosition(anchor, VIEWPORT);
    // width capped at 280; left must satisfy left + width <= viewport.width - 8
    expect(coords.left + coords.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it("clamps left so it never renders past the left edge", () => {
    const anchor = { top: 10, bottom: 40, left: -30 };
    const coords = computeDropdownPosition(anchor, VIEWPORT);
    expect(coords.left).toBe(8);
  });

  it("shrinks width to 90vw on narrow viewports", () => {
    const anchor = { top: 10, bottom: 40, left: 5 };
    const coords = computeDropdownPosition(anchor, { width: 250, height: 600 });
    expect(coords.width).toBeCloseTo(225); // 250 * 0.9, under the 280 cap
  });
});
