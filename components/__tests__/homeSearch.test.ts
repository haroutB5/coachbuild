import { describe, it, expect } from "vitest";
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
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

// v0.23.0: back-gesture history integration (the wire<->state mapping
// app/page.tsx's useSheetBackNav<WireMainView> instance uses to push/replace
// entries and restore from them).
describe("wireViewForChampion", () => {
  it("wraps a champion+lane pick with the given tab", () => {
    expect(wireViewForChampion(VIKTOR, "mid", "build")).toEqual({
      view: { kind: "champion", champ: VIKTOR, lane: "mid" },
      tab: "build",
    });
  });
});

describe("wireViewForPlayer", () => {
  it("wraps a player pick with the given tab", () => {
    expect(wireViewForPlayer(BWIPO, "proBuilds")).toEqual({
      view: { kind: "player", player: BWIPO },
      tab: "proBuilds",
    });
  });
});

describe("applyWireMainView", () => {
  it("maps a champion-kind wire to CHAMPIONS mode + activeLane/champ, omitting selectedPlayer entirely", () => {
    const applied = applyWireMainView(wireViewForChampion(DARIUS, "top", "proBuilds"));
    expect(applied).toEqual({ searchMode: "champions", tab: "proBuilds", activeLane: "top", champ: DARIUS });
    expect(applied.selectedPlayer).toBeUndefined();
    expect("selectedPlayer" in applied).toBe(false);
  });

  it("maps a player-kind wire to PROS mode + selectedPlayer, omitting activeLane/champ entirely", () => {
    const applied = applyWireMainView(wireViewForPlayer(BWIPO, "build"));
    expect(applied).toEqual({ searchMode: "pros", tab: "build", selectedPlayer: BWIPO });
    expect(applied.activeLane).toBeUndefined();
    expect(applied.champ).toBeUndefined();
  });

  it("round-trips the full user-reported trail: Viktor(mid) -> pick Bwipo -> back restores Viktor(mid) untouched", () => {
    // Seeded entry at mount (app/page.tsx's seedInitialSelection).
    const seeded = wireViewForChampion(VIKTOR, "mid", "build");
    // Pushed when the player search fires (handlePlayerSelect).
    const pushed = wireViewForPlayer(BWIPO, "build");
    // A back-press pops back to the seeded entry -- applyWireMainView(seeded)
    // must reproduce the exact original champion/lane, not something derived
    // from the player entry in between.
    expect(applyWireMainView(pushed)).toEqual({ searchMode: "pros", tab: "build", selectedPlayer: BWIPO });
    expect(applyWireMainView(seeded)).toEqual({
      searchMode: "champions",
      tab: "build",
      activeLane: "mid",
      champ: VIKTOR,
    });
  });
});
