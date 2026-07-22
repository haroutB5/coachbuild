import { describe, it, expect } from "vitest";
import {
  deriveMainView,
  modeAfterLaneChange,
  modeAfterChampionSelect,
  modeAfterPlayerSelect,
  isProsSearchEmpty,
  canFavoritePlayerSubject,
  defaultSourceForKind,
  defaultSourceForPlayer,
  applyWireMainView,
  wireViewForChampion,
  wireViewForPlayer,
  trackedSubjectFromPlayerRef,
  subjectFromPendingPlayerSelect,
  type TrackedPlayerSubject,
  type LinkPlayerSubject,
} from "../hextech/homeSearch";
import type { ChampionRef } from "@/lib/types";
import type { PlayerRef } from "@/components/proHistory.types";
import type { PendingPlayerSelect } from "@/components/playerSelectHandoff";

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

const BWIPO: PlayerRef = {
  id: "pro-bwipo",
  name: "Bwipo",
  slug: "bwipo",
  team: "FNC",
  role: 0,
  country: "BE",
  gameCount: 20,
};

// v0.26.0 — the sidebar PROS search flow's fully-resolved player, wrapped as
// a tracked subject (see trackedSubjectFromPlayerRef).
const BWIPO_TRACKED: TrackedPlayerSubject = { kind: "tracked", id: "pro-bwipo", name: "Bwipo", team: "FNC", gameCount: 20 };

// A Teams-box tap on an untracked prostage player — no `pros` row, so no
// proId/team/gameCount, only a raw Leaguepedia player_link.
const DHOKLA_LINK: LinkPlayerSubject = { kind: "link", playerLink: "Dhokla", name: "Dhokla" };

describe("deriveMainView", () => {
  it("renders the champion view in CHAMPIONS mode regardless of any prior player selection", () => {
    const view = deriveMainView("champions", VIKTOR, "mid", BWIPO_TRACKED);
    expect(view).toEqual({ kind: "champion", champ: VIKTOR, lane: "mid" });
  });

  it("renders the champion view in PROS mode when no player has been selected yet (toggle alone shows nothing new)", () => {
    const view = deriveMainView("pros", VIKTOR, "mid", null);
    expect(view).toEqual({ kind: "champion", champ: VIKTOR, lane: "mid" });
  });

  it("renders the player view once PROS mode has a selected player — this is what feeds the games rows", () => {
    const view = deriveMainView("pros", VIKTOR, "mid", BWIPO_TRACKED);
    expect(view).toEqual({ kind: "player", subject: BWIPO_TRACKED });
  });

  it("renders the player view for a link-only (untracked) subject the exact same way as a tracked one", () => {
    const view = deriveMainView("pros", VIKTOR, "mid", DHOKLA_LINK);
    expect(view).toEqual({ kind: "player", subject: DHOKLA_LINK });
  });

  it("switching back to CHAMPIONS after a player was picked restores the last champion+lane untouched", () => {
    const beforeToggle = deriveMainView("champions", DARIUS, "top", null);
    const afterPlayerPick = deriveMainView("pros", DARIUS, "top", BWIPO_TRACKED);
    const afterToggleBack = deriveMainView("champions", DARIUS, "top", BWIPO_TRACKED);
    expect(beforeToggle).toEqual({ kind: "champion", champ: DARIUS, lane: "top" });
    expect(afterPlayerPick).toEqual({ kind: "player", subject: BWIPO_TRACKED });
    expect(afterToggleBack).toEqual({ kind: "champion", champ: DARIUS, lane: "top" });
  });
});

// v0.26.0 (issue 2): lanes are LANE SELECTORS for the champion being viewed,
// not independent per-lane champion slots — a lane change must never imply a
// different champion. app/page.tsx's own `champ` state (a single ChampionRef,
// not a Record<LaneId, ChampionRef>) is what actually enforces "stays the
// same champion" imperatively; these pure functions pin the CONTRACT that
// makes that possible — deriveMainView takes one `champ` for every lane, and
// wireViewForChampion/applyWireMainView never derive or invert a champion
// from a lane, only carry whatever champion they're given straight through.
describe("lane changes keep the champion (issue 2)", () => {
  it("deriveMainView renders the SAME champion across every lane — there is no per-lane champion source", () => {
    for (const lane of ["top", "jungle", "mid", "bot", "support"] as const) {
      expect(deriveMainView("champions", AHRI, lane, null)).toEqual({ kind: "champion", champ: AHRI, lane });
    }
  });

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

// v0.44.3: the render-layer gate for the "search for a pro player" prompt —
// separate from deriveMainView (which intentionally keeps returning the
// champion view's STATE in this situation, see its own doc comment/test
// above). isProsSearchEmpty is what app/page.tsx checks BEFORE mainView.kind
// at the composition site so the champion page's UI (hero/tabs/rank
// bracket/runes/cards) no longer bleeds through underneath an empty PROS
// search.
describe("isProsSearchEmpty", () => {
  it("is true in PROS mode with no player selected — exactly the state that used to leak the champion page", () => {
    expect(isProsSearchEmpty("pros", null)).toBe(true);
  });

  it("is false in PROS mode once a tracked player is selected", () => {
    expect(isProsSearchEmpty("pros", BWIPO_TRACKED)).toBe(false);
  });

  it("is false in PROS mode once a link-only player is selected", () => {
    expect(isProsSearchEmpty("pros", DHOKLA_LINK)).toBe(false);
  });

  it("is always false in CHAMPIONS mode, regardless of any lingering selectedPlayer", () => {
    expect(isProsSearchEmpty("champions", null)).toBe(false);
    expect(isProsSearchEmpty("champions", BWIPO_TRACKED)).toBe(false);
  });
});

// v0.45.2: PlayerHero's favorite-star eligibility gate — TRACKED subjects
// only, mirroring the v0.26.0 link-only-player policy app/history/page.tsx
// already enforces for its own player summary line's star.
describe("canFavoritePlayerSubject", () => {
  it("is true for a tracked subject (has a real pros/id-addressable identity)", () => {
    expect(canFavoritePlayerSubject(BWIPO_TRACKED)).toBe(true);
  });

  it("is false for a link-only (untracked) subject — nothing to key lib/favorites.ts off of", () => {
    expect(canFavoritePlayerSubject(DHOKLA_LINK)).toBe(false);
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

// v0.26.0: the real per-subject default, used everywhere a subject is
// actually in hand (defaultSourceForKind("player") stays a generic fallback,
// unaware of link-vs-tracked).
describe("defaultSourceForPlayer", () => {
  it("defaults a tracked subject to All, same as defaultSourceForKind", () => {
    expect(defaultSourceForPlayer(BWIPO_TRACKED)).toBe("all");
  });

  it("locks a link-only (untracked) subject to Pro Play — its only real source", () => {
    expect(defaultSourceForPlayer(DHOKLA_LINK)).toBe("prostage");
  });
});

// v0.26.0: player-subject conversion helpers (issue 1 — the "escapes the
// Hextech shell" fix). Mirror app/history/page.tsx's own toPlayerSubject/
// toWirePlayerSubject split.
describe("trackedSubjectFromPlayerRef", () => {
  it("wraps a fully-resolved sidebar-search PlayerRef with nothing left to resolve", () => {
    expect(trackedSubjectFromPlayerRef(BWIPO)).toEqual(BWIPO_TRACKED);
  });
});

describe("subjectFromPendingPlayerSelect", () => {
  it("converts a tracked Teams-box tap (has `id`) with gameCount left null — not known synchronously", () => {
    const pending: PendingPlayerSelect = { id: "pro-zeus", name: "Zeus", team: "T1" };
    expect(subjectFromPendingPlayerSelect(pending)).toEqual({
      kind: "tracked",
      id: "pro-zeus",
      name: "Zeus",
      team: "T1",
      gameCount: null,
    });
  });

  it("converts an untracked Teams-box tap (has `playerLink`, no `id`) into a link subject", () => {
    const pending: PendingPlayerSelect = { playerLink: "Dhokla", name: "Dhokla" };
    expect(subjectFromPendingPlayerSelect(pending)).toEqual(DHOKLA_LINK);
  });
});

// v0.23.0: back-gesture history integration (the wire<->state mapping
// app/page.tsx's useSheetBackNav<WireMainView> instance uses to push/replace
// entries and restore from them). v0.24.0 added the `source` games-list
// filter field to the same wire shape. v0.26.0 changed the player arm to
// carry a PlayerSubject instead of a bare PlayerRef.
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
  it("wraps a tracked player subject with the given tab and source", () => {
    expect(wireViewForPlayer(BWIPO_TRACKED, "proBuilds", "all")).toEqual({
      view: { kind: "player", subject: BWIPO_TRACKED },
      tab: "proBuilds",
      source: "all",
    });
  });

  it("wraps a link-only player subject (player-link selection from a sheet tap)", () => {
    expect(wireViewForPlayer(DHOKLA_LINK, "proBuilds", "prostage")).toEqual({
      view: { kind: "player", subject: DHOKLA_LINK },
      tab: "proBuilds",
      source: "prostage",
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

  it("maps a tracked player-kind wire to PROS mode + selectedPlayer/gamesSource, omitting activeLane/champ entirely", () => {
    const applied = applyWireMainView(wireViewForPlayer(BWIPO_TRACKED, "build", "all"));
    expect(applied).toEqual({ searchMode: "pros", tab: "build", gamesSource: "all", selectedPlayer: BWIPO_TRACKED });
    expect(applied.activeLane).toBeUndefined();
    expect(applied.champ).toBeUndefined();
  });

  // v0.26.0 (issue 1's "link-only player wire state"): a link-only subject's
  // source is ALWAYS forced back to Pro Play on restore, even if the wire's
  // own `source` field somehow says otherwise (a stale entry from before
  // this lock existed, or a hand-edited one) — defensive-in-depth alongside
  // the server's own player= lookup already being prostage-only regardless
  // of the requested source (app/api/pros/route.ts).
  it("clamps a link-only player-kind wire's gamesSource to Pro Play regardless of the wire's own source field", () => {
    const corruptedWire = wireViewForPlayer(DHOKLA_LINK, "build", "all"); // "all" should never survive restore for a link subject
    const applied = applyWireMainView(corruptedWire);
    expect(applied).toEqual({ searchMode: "pros", tab: "build", gamesSource: "prostage", selectedPlayer: DHOKLA_LINK });
  });

  it("a correctly-locked link-only wire (source already prostage) restores unchanged", () => {
    const wire = wireViewForPlayer(DHOKLA_LINK, "proBuilds", "prostage");
    expect(applyWireMainView(wire)).toEqual({
      searchMode: "pros",
      tab: "proBuilds",
      gamesSource: "prostage",
      selectedPlayer: DHOKLA_LINK,
    });
  });

  it("round-trips the full user-reported trail: Viktor(mid) -> pick Bwipo -> back restores Viktor(mid) untouched, including its filter", () => {
    // Seeded entry at mount (app/page.tsx's seedInitialSelection) — champion
    // view's default filter.
    const seeded = wireViewForChampion(VIKTOR, "mid", "build", "prostage");
    // Pushed when the player search fires (handlePlayerSelect) — resets to
    // the player view's own default filter.
    const pushed = wireViewForPlayer(BWIPO_TRACKED, "build", "all");
    // A back-press pops back to the seeded entry -- applyWireMainView(seeded)
    // must reproduce the exact original champion/lane/filter, not something
    // derived from the player entry in between.
    expect(applyWireMainView(pushed)).toEqual({
      searchMode: "pros",
      tab: "build",
      gamesSource: "all",
      selectedPlayer: BWIPO_TRACKED,
    });
    expect(applyWireMainView(seeded)).toEqual({
      searchMode: "champions",
      tab: "build",
      gamesSource: "prostage",
      activeLane: "mid",
      champ: VIKTOR,
    });
  });

  // v0.26.0 ("player-link selection from sheet"): a Teams-box tap on an
  // untracked player, from inside a game sheet, followed by a back-press,
  // must land cleanly back on the champion/player view the sheet was opened
  // from — this is the same round-trip shape as the Bwipo trail above, just
  // starting from a champion view and landing on a LINK subject instead of a
  // tracked one.
  it("round-trips a champion-view -> link-only-player-from-sheet trail", () => {
    const seeded = wireViewForChampion(AHRI, "jungle", "proBuilds", "prostage");
    const pushed = wireViewForPlayer(DHOKLA_LINK, "proBuilds", "prostage");
    expect(applyWireMainView(pushed)).toEqual({
      searchMode: "pros",
      tab: "proBuilds",
      gamesSource: "prostage",
      selectedPlayer: DHOKLA_LINK,
    });
    expect(applyWireMainView(seeded)).toEqual({
      searchMode: "champions",
      tab: "proBuilds",
      gamesSource: "prostage",
      activeLane: "jungle",
      champ: AHRI,
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
