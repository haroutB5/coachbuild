import { describe, it, expect } from "vitest";
import { roleFromCargoRole } from "../prostage/roleMap";

describe("roleFromCargoRole", () => {
  it("maps Leaguepedia's prose role names case-insensitively", () => {
    expect(roleFromCargoRole("Top")).toBe(0);
    expect(roleFromCargoRole("jungle")).toBe(1);
    expect(roleFromCargoRole("MID")).toBe(2);
    expect(roleFromCargoRole("Bot")).toBe(3);
    expect(roleFromCargoRole("ADC")).toBe(3);
    expect(roleFromCargoRole("Support")).toBe(4);
  });

  it("returns null (not skipped) for empty/unrecognized values", () => {
    expect(roleFromCargoRole("")).toBeNull();
    expect(roleFromCargoRole(undefined)).toBeNull();
    expect(roleFromCargoRole(null)).toBeNull();
    expect(roleFromCargoRole("Coach")).toBeNull();
  });

  it("maps 'AD Carry' / 'ad carry' / 'adcarry' (space-stripped alias) to BOT, same as ADC", () => {
    expect(roleFromCargoRole("AD Carry")).toBe(3);
    expect(roleFromCargoRole("ad carry")).toBe(3);
    expect(roleFromCargoRole("adcarry")).toBe(3);
    expect(roleFromCargoRole("AdCarry")).toBe(3);
  });

  it("space-stripping normalization also tolerates stray internal whitespace on known roles", () => {
    expect(roleFromCargoRole("  Top  ")).toBe(0);
  });
});
