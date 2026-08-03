import { describe, it, expect } from "vitest";
import { isWireSelection, restoreSelectionState, type WireSelection } from "@/components/historyRestore";

describe("/history restore validation", () => {
  it("rejects a Builds wire payload instead of turning it into an undefined champion request", () => {
    const foreignHomeView: unknown = {
      view: { kind: "prompt" },
      tab: "build",
      source: "prostage",
    };

    expect(isWireSelection(foreignHomeView)).toBe(false);
    expect(restoreSelectionState(foreignHomeView)).toBeNull();
  });

  it("accepts a complete champion selection and preserves its request fields", () => {
    const selection: WireSelection = {
      mode: "champion",
      championId: 112,
      championKey: "Viktor",
      championName: "Viktor",
      championIcon: "x",
      lane: 2,
    };

    expect(restoreSelectionState(selection)).toEqual(selection);
  });
});
