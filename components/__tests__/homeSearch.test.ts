import { describe, it, expect } from "vitest";
import {
  modeAfterLaneChange,
  modeAfterChampionSelect,
  defaultSourceForKind,
  applyWireMainView,
  wireViewForChampion,
  wireViewForPrompt,
  champChosenAfterRestore,
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
  it("maps a champion-kind wire to activeLane/champ/gamesSource, tagged kind: champion", () => {
    const applied = applyWireMainView(wireViewForChampion(DARIUS, "top", "proBuilds", "soloq"));
    expect(applied).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "soloq",
      kind: "champion",
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
      kind: "champion",
      activeLane: "mid",
      champ: VIKTOR,
    });
    expect(applyWireMainView(afterFilterChange)).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "soloq",
      kind: "champion",
      activeLane: "mid",
      champ: VIKTOR,
    });
  });

  // v0.69.1 regression: the hub / pick-prompt is now a real MainView kind, and
  // the base "/" history entry always seeds as one (wireViewForPrompt) so
  // there is somewhere real for back() to land instead of bottoming out on
  // whatever champion happened to be in state at mount (the reported bug —
  // "Build page goes back to viktor instead of what you built").
  it("maps a prompt-kind wire with no activeLane/champ keys at all", () => {
    const applied = applyWireMainView(wireViewForPrompt("build", "all"));
    expect(applied).toEqual({
      searchMode: "champions",
      tab: "build",
      gamesSource: "all",
      kind: "prompt",
    });
    expect(applied).not.toHaveProperty("activeLane");
    expect(applied).not.toHaveProperty("champ");
  });
});

describe("wireViewForPrompt", () => {
  it("wraps the hub view with the given tab and source", () => {
    expect(wireViewForPrompt("build", "prostage")).toEqual({
      view: { kind: "prompt" },
      tab: "build",
      source: "prostage",
    });
  });
});

// v0.69.1 regression pin: "back from a champion lands on the prompt view."
// app/page.tsx's restoreMainView has no JSX rendering harness to exercise
// directly (see CLAUDE.md's Test conventions), so champChosenAfterRestore is
// the extracted pure decision it delegates to — this test pins the exact
// contract restoreMainView relies on: landing on a champion entry means a
// real selection (show the build), landing on the seeded hub entry means no
// selection (show the pick prompt).
describe("champChosenAfterRestore", () => {
  it("is true for a champion-kind entry", () => {
    expect(champChosenAfterRestore("champion")).toBe(true);
  });

  it("is false for the prompt/hub entry — this is what makes back() from a champion land on the hub, not a champion", () => {
    expect(champChosenAfterRestore("prompt")).toBe(false);
  });
});
