import { describe, it, expect } from "vitest";
import { wpaPercentText } from "../hextech/wpaFormat";

describe("wpaPercentText", () => {
  it("formats a positive fraction as a signed percentage, 1 decimal", () => {
    expect(wpaPercentText(0.018)).toBe("+1.8%");
  });

  it("formats a negative fraction with no extra sign (toFixed keeps the minus)", () => {
    expect(wpaPercentText(-0.004)).toBe("-0.4%");
  });

  it("formats zero without a leading +", () => {
    expect(wpaPercentText(0)).toBe("0.0%");
  });
});
