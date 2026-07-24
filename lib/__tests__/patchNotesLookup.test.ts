import { describe, it, expect } from "vitest";
import { getPatchNote } from "@/lib/patchNotes/lookup";

describe("getPatchNote", () => {
  it("returns the curated entry for a known (patch, championId) pair", () => {
    expect(getPatchNote("16.13", 7)).toBe("Buffed this patch"); // LeBlanc
    expect(getPatchNote("16.13", 235)).toBe("Nerfed this patch"); // Senna
  });

  it("null for a champion with no curated entry on a known patch (never guessed)", () => {
    expect(getPatchNote("16.13", 1)).toBeNull(); // Annie -- not in the 6 verified 16.13 entries
  });

  it("null for a patch with no curated entries at all", () => {
    expect(getPatchNote("16.14", 7)).toBeNull();
  });

  it("null for a nonsense patch label, no throw", () => {
    expect(getPatchNote("not-a-patch", 7)).toBeNull();
  });
});
