import { describe, it, expect } from "vitest";
import { champSelectChipModel } from "../champSelectChipModel";

describe("champSelectChipModel", () => {
  it("not connected -> hidden, regardless of phase/champSelect", () => {
    const model = champSelectChipModel({
      phase: "ChampSelect",
      champSelect: { championName: "Swain", role: "Top" },
      clientConnected: false,
    });
    expect(model.show).toBe(false);
  });

  it("connected but not in ChampSelect -> hidden", () => {
    const model = champSelectChipModel({ phase: "InProgress", champSelect: null, clientConnected: true });
    expect(model.show).toBe(false);
  });

  it("connected, no phase at all -> hidden", () => {
    const model = champSelectChipModel({ phase: null, champSelect: null, clientConnected: true });
    expect(model.show).toBe(false);
  });

  it("ChampSelect with no champSelect snapshot -> hidden (nothing to report yet)", () => {
    const model = champSelectChipModel({ phase: "ChampSelect", champSelect: null, clientConnected: true });
    expect(model.show).toBe(false);
  });

  it("ChampSelect, snapshot present but no champion resolved yet -> PICKING, live", () => {
    const model = champSelectChipModel({
      phase: "ChampSelect",
      champSelect: { championName: null, role: null },
      clientConnected: true,
    });
    expect(model).toEqual({ show: true, label: "CHAMP SELECT — PICKING", tone: "live" });
  });

  it("ChampSelect with champion + role resolved -> uppercased 'NAME · ROLE'", () => {
    const model = champSelectChipModel({
      phase: "ChampSelect",
      champSelect: { championName: "Swain", role: "Top" },
      clientConnected: true,
    });
    expect(model).toEqual({ show: true, label: "CHAMP SELECT — SWAIN · TOP", tone: "live" });
  });

  it("stale status hides a cached ChampSelect chip", () => {
    const model = champSelectChipModel({
      phase: "ChampSelect",
      champSelect: { championName: "Swain", role: "Top" },
      clientConnected: true,
      statusFresh: false,
    });
    expect(model.show).toBe(false);
  });

  it("ChampSelect with champion resolved but no role -> omits the role segment entirely", () => {
    const model = champSelectChipModel({
      phase: "ChampSelect",
      champSelect: { championName: "Swain", role: null },
      clientConnected: true,
    });
    expect(model).toEqual({ show: true, label: "CHAMP SELECT — SWAIN", tone: "live" });
  });

  it("champion name is uppercased even if the caller passes mixed case", () => {
    const model = champSelectChipModel({
      phase: "ChampSelect",
      champSelect: { championName: "Miss Fortune", role: "Bot" },
      clientConnected: true,
    });
    expect(model.label).toBe("CHAMP SELECT — MISS FORTUNE · BOT");
  });
});
