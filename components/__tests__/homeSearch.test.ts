import { describe, it, expect } from "vitest";
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
  defaultSourceForKind,
  applyWireMainView,
  wireViewForChampion,
  wireViewForPlayer,
} from "../hextech/homeSearch";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";

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

const BWIPO: PlayerRef = {
  id: "pro-bwipo",
  name: "Bwipo",
  slug: "bwipo",
  team: "FNC",
  role: 0,
  country: "BE",
  gameCount: 20,
};

describe("deriveMainView", () => {
  it("renders the champion view in CHAMPIONS mode regardless of any prior player selection", () => {
    const view = deriveMainView("champions", VIKTOR, "mid", BWIPO);
    expect(view).toEqual({ kind: "champion", champ: VIKTOR, lane: "mid" });
  });

  it("renders the champion view in PROS mode when no player has been selected yet (toggle alone shows nothing new)", () => {
    const view = deriveMainView("pros", VIKTOR, "mid", null);
    expect(view).toEqual({ kind: "champion", champ: VIKTOR, lane: "mid" });
  });

  it("renders the player view once PROS mode has a selected player — this is what feeds the games rows", () => {
    const view = deriveMainView("pros", VIKTOR, "mid", BWIPO);
    expect(view).toEqual({ kind: "player", player: BWIPO });
  });

  it("switching back to CHAMPIONS after a player was picked restores the last champion+lane untouched", () => {
    // Simulates: pick Darius on Top, toggle to PROS + pick Bwipo, toggle
    // back to CHAMPIONS — champ/lane were never mutated by the PROS
    // excursion (they live in separate page-level state), so this call with
    // the SAME champ/lane args must reproduce exactly what was showing
    // before the toggle.
    const beforeToggle = deriveMainView("champions", DARIUS, "top", null);
    const afterPlayerPick = deriveMainView("pros", DARIUS, "top", BWIPO);
    const afterToggleBack = deriveMainView("champions", DARIUS, "top", BWIPO);
    expect(beforeToggle).toEqual({ kind: "champion", champ: DARIUS, lane: "top" });
    expect(afterPlayerPick).toEqual({ kind: "player", player: BWIPO });
    expect(afterToggleBack).toEqual({ kind: "champion", champ: DARIUS, lane: "top" });
  });
});

describe("modeAfterLaneChange", () => {
  it("always exits to CHAMPIONS mode — a lane tap is champion-oriented even mid PROS-mode browsing", () => {
    expect(modeAfterLaneChange()).toBe("champions");
  });
});

describe("modeAfterChampionSelect", () => {
  it("always lands in CHAMPIONS mode", () => {
    expect(modeAfterChampionSelect()).toBe("champions");
  });
});

describe("modeAfterPlayerSelect", () => {
  it("always lands in PROS mode", () => {
    expect(modeAfterPlayerSelect()).toBe("pros");
  });
});

// v0.24.0: All/Solo Queue/Pro Play games-list filter default per view kind
// (see homeSearch.ts's header comment above this function for the "why").
describe("defaultSourceForKind", () => {
  it("defaults the champion view (ProBuildsTab) to Pro Play, matching the Hextech spec mockup", () => {
    expect(defaultSourceForKind("champion")).toBe("prostage");
  });

  it("defaults the player view (PlayerGamesSection) to All", () => {
    expect(defaultSourceForKind("player")).toBe("all");
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

describe("wireViewForPlayer", () => {
  it("wraps a player pick with the given tab and source", () => {
    expect(wireViewForPlayer(BWIPO, "proBuilds", "all")).toEqual({
      view: { kind: "player", player: BWIPO },
      tab: "proBuilds",
      source: "all",
    });
  });
});

describe("applyWireMainView", () => {
  it("maps a champion-kind wire to CHAMPIONS mode + activeLane/champ/gamesSource, omitting selectedPlayer entirely", () => {
    const applied = applyWireMainView(wireViewForChampion(DARIUS, "top", "proBuilds", "soloq"));
    expect(applied).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "soloq",
      activeLane: "top",
      champ: DARIUS,
    });
    expect(applied.selectedPlayer).toBeUndefined();
    expect("selectedPlayer" in applied).toBe(false);
  });

  it("maps a player-kind wire to PROS mode + selectedPlayer/gamesSource, omitting activeLane/champ entirely", () => {
    const applied = applyWireMainView(wireViewForPlayer(BWIPO, "build", "all"));
    expect(applied).toEqual({ searchMode: "pros", tab: "build", gamesSource: "all", selectedPlayer: BWIPO });
    expect(applied.activeLane).toBeUndefined();
    expect(applied.champ).toBeUndefined();
  });

  it("round-trips the full user-reported trail: Viktor(mid) -> pick Bwipo -> back restores Viktor(mid) untouched, including its filter", () => {
    // Seeded entry at mount (app/page.tsx's seedInitialSelection) — champion
    // view's default filter.
    const seeded = wireViewForChampion(VIKTOR, "mid", "build", "prostage");
    // Pushed when the player search fires (handlePlayerSelect) — resets to
    // the player view's own default filter.
    const pushed = wireViewForPlayer(BWIPO, "build", "all");
    // A back-press pops back to the seeded entry -- applyWireMainView(seeded)
    // must reproduce the exact original champion/lane/filter, not something
    // derived from the player entry in between.
    expect(applyWireMainView(pushed)).toEqual({
      searchMode: "pros",
      tab: "build",
      gamesSource: "all",
      selectedPlayer: BWIPO,
    });
    expect(applyWireMainView(seeded)).toEqual({
      searchMode: "champions",
      tab: "build",
      gamesSource: "prostage",
      activeLane: "mid",
      champ: VIKTOR,
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
