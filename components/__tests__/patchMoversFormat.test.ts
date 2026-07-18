import { describe, it, expect } from "vitest";
import {
  deltaDirection,
  deltaClass,
  deltaArrow,
  deltaText,
  wpaSwingText,
  patchHeaderText,
  moverKindLabel,
} from "../hextech/patchMoversFormat";

describe("deltaDirection", () => {
  it("positive delta -> up", () => {
    expect(deltaDirection(0.64)).toBe("up");
  });
  it("negative delta -> down", () => {
    expect(deltaDirection(-0.34)).toBe("down");
  });
  it("zero delta -> flat", () => {
    expect(deltaDirection(0)).toBe("flat");
  });
});

describe("deltaClass", () => {
  it("up is teal (the app's one accent)", () => {
    expect(deltaClass(1)).toBe("text-teal");
  });
  it("down is a muted red, distinct from StatBadge's sharper text-bad", () => {
    expect(deltaClass(-1)).toBe("text-bad/75");
  });
  it("flat is muted gray", () => {
    expect(deltaClass(0)).toBe("text-mut");
  });
});

describe("deltaArrow", () => {
  it("renders the direction glyphs", () => {
    expect(deltaArrow(1)).toBe("↑");
    expect(deltaArrow(-1)).toBe("↓");
    expect(deltaArrow(0)).toBe("→");
  });
});

describe("deltaText", () => {
  it("prefixes a positive delta with +, two decimals", () => {
    expect(deltaText(0.6423)).toBe("+0.64");
  });
  it("keeps the sign on a negative delta", () => {
    expect(deltaText(-1.339)).toBe("-1.34");
  });
  it("zero has no sign prefix", () => {
    expect(deltaText(0)).toBe("0.00");
  });
});

describe("wpaSwingText", () => {
  it("formats prev -> curr with two decimals each", () => {
    expect(wpaSwingText(-1.34, -0.7)).toBe("-1.34 → -0.70");
  });
});

describe("patchHeaderText", () => {
  it('formats "<patch> vs <prevPatch>"', () => {
    expect(patchHeaderText("16.13", "16.12")).toBe("16.13 vs 16.12");
  });
});

describe("moverKindLabel", () => {
  it("keystone -> Keystone", () => {
    expect(moverKindLabel("keystone")).toBe("Keystone");
  });
  it("item -> Item", () => {
    expect(moverKindLabel("item")).toBe("Item");
  });
});
