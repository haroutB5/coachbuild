import { describe, expect, it } from "vitest";
import { openSearchFromPointer } from "../searchOpenState";

describe("openSearchFromPointer", () => {
  it("reopens a closed search after a tap without relying on focus", () => {
    expect(openSearchFromPointer({ open: false, activeIndex: 4 })).toEqual({
      open: true,
      activeIndex: 0,
    });
  });

  it("is idempotent when focus and click fire for the same interaction", () => {
    expect(openSearchFromPointer({ open: true, activeIndex: 3 })).toEqual({
      open: true,
      activeIndex: 3,
    });
  });
});
