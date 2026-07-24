import { describe, it, expect } from "vitest";
import {
  modeAfterLaneChange,
  modeAfterChampionSelect,
  defaultSourceForKind,
  applyWireMainView,
  wireViewForChampion,
} from "../hextech/homeSearch";
import type { ChampionRef } from "@/lib/types";

const VIKTOR: ChampionRef = {
  id: 112,
  key: "Viktor",
  name: "Viktor",
  icon: "https://cdn.coachless.gg/.../Viktor.webp",
};

const DARIUS: ChampionRef = {
  id: 122,
  key: "Darius",
  name: "Darius",
  icon: "https://cdn.coachless.gg/.../Darius.webp",
};

const AHRI: ChampionRef = {
  id: 103,
  key: "Ahri",
  name: "Ahri",
  icon: "https://cdn.coachless.gg/.../Ahri.webp",
};

// v0.26.0 (issue 2): lanes are LANE SELECTORS for the champion being viewed,
// not independent per-lane champion slots — a lane change must never imply a
// different champion. app/page.tsx's own `champ` state (a single ChampionRef,
// not a Record<LaneId, ChampionRef>) is what actually enforces "stays the
// same champion" imperatively; this pins the CONTRACT that makes that
// possible — wireViewForChampion/applyWireMainView never derive or invert a
// champion from a lane, only carry whatever champion they're given straight
// through.
describe("lane changes keep the champion (issue 2)", () => {
  it("wireViewForChampion + applyWireMainView round-trip a lane change with the champion untouched", () => {
    const midEntry = wireViewForChampion(AHRI, "mid", "build", "prostage");
    const topEntry = wireViewForChampion(AHRI, "top", "build", "prostage");
    expect(applyWireMainView(midEntry).champ).toEqual(AHRI);
    expect(applyWireMainView(topEntry).champ).toEqual(AHRI);
    // Only the lane differs — same champion object both times.
    expect(applyWireMainView(midEntry).champ).toEqual(applyWireMainView(topEntry).champ);
    expect(applyWireMainView(midEntry).activeLane).toBe("mid");
    expect(applyWireMainView(topEntry).activeLane).toBe("top");
  });
});

describe("modeAfterLaneChange", () => {
  it("always returns the champion mode — a lane tap is champion-oriented", () => {
    expect(modeAfterLaneChange()).toBe("champions");
  });
});

describe("modeAfterChampionSelect", () => {
  it("always returns the champion mode", () => {
    expect(modeAfterChampionSelect()).toBe("champions");
  });
});

// v0.24.0: All/Solo Queue/Pro Play games-list filter default per view kind
// (see homeSearch.ts's header comment above this function for the "why").
describe("defaultSourceForKind", () => {
  it("defaults the champion view to Pro Play, matching the Hextech spec mockup", () => {
    expect(defaultSourceForKind("champion")).toBe("prostage");
  });
});

// v0.23.0: back-gesture history integration (the wire<->state mapping
// app/page.tsx's useSheetBackNav<WireMainView> instance uses to push/replace
// entries and restore from them). v0.24.0 added the `source` games-list
// filter field to the same wire shape.
describe("wireViewForChampion", () => {
  it("wraps a champion+lane pick with the given tab and source", () => {
    expect(wireViewForChampion(VIKTOR, "mid", "build", "prostage")).toEqual({
      view: { kind: "champion", champ: VIKTOR, lane: "mid" },
      tab: "build",
      source: "prostage",
    });
  });
});

describe("applyWireMainView", () => {
  it("maps a champion-kind wire to activeLane/champ/gamesSource", () => {
    const applied = applyWireMainView(wireViewForChampion(DARIUS, "top", "proBuilds", "soloq"));
    expect(applied).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "soloq",
      activeLane: "top",
      champ: DARIUS,
    });
  });

  it("a filter change (replaceSelection) on the champion view keeps champ/lane/tab untouched, only source differs", () => {
    const beforeFilterChange = wireViewForChampion(VIKTOR, "mid", "proBuilds", "prostage");
    const afterFilterChange = wireViewForChampion(VIKTOR, "mid", "proBuilds", "soloq");
    expect(applyWireMainView(beforeFilterChange)).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "prostage",
      activeLane: "mid",
      champ: VIKTOR,
    });
    expect(applyWireMainView(afterFilterChange)).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "soloq",
      activeLane: "mid",
      champ: VIKTOR,
    });
  });
});
