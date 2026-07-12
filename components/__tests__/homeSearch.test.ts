import { describe, it, expect } from "vitest";
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
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
