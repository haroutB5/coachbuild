// ─────────────────────────────────────────────────────────────────────────────
// The two-visit regression test.
//
// WHY THIS FILE EXISTS. On 2026-07-26 the Builds page shipped to production
// persisting the Viktor SEED to localStorage with no user action, so the pick
// prompt appeared exactly once per device and every later visit opened on
// VIKTOR MID — the behaviour user directive 2026-07-25 removed. It survived
// 1,632 passing tests because the defect is INVISIBLE on the visit that causes
// it: visit 1 looked perfect. Nothing in the suite ever loaded the page twice.
//
// So these tests do not assert on a boolean helper — that would restate the
// implementation and catch nothing. They replay the component's actual wiring
// across SEPARATE visits, through the REAL readLastChampion/writeLastChampion
// (backed by a fake localStorage), and assert on the only thing that matters:
// WHAT A RETURNING USER SEES.
//
// Guard when editing: `firstVisitMustNotPersist` below FAILS if the `chosen`
// half of the persist rule is removed. Verified by neutering
// shouldPersistLastChampion to `state.hydrated` — see the ship notes.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readLastChampion, writeLastChampion } from "@/lib/lastChampion";
import { resolveVisitSession, shouldPersistLastChampion } from "@/lib/lastChampionSession";
import { STATIC_FALLBACK_LANE_CHAMPIONS } from "@/components/hextech/heroContracts";
import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";

const INITIAL_LANE: LaneId = "mid";
/** The REAL seed the page renders on first paint — imported rather than
 *  hand-rolled so this test keeps guarding if that seed is ever changed. */
const SEED = STATIC_FALLBACK_LANE_CHAMPIONS[INITIAL_LANE];

const AHRI: ChampionRef = {
  id: 103,
  key: "Ahri",
  name: "Ahri",
  icon: "https://example.invalid/Ahri.webp",
} as ChampionRef;

// ── Fake device storage ──────────────────────────────────────────────────────
// lib/lastChampion.ts guards on `typeof window === "undefined"` and then uses
// window.localStorage, so stubbing the global exercises its real JSON
// serialization and shape validation rather than mocking them away.
let store: Record<string, string>;
const KEY = "coachbuild:lastChampion:v1";

beforeEach(() => {
  store = {};
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** What the user sees after one page load, plus what that load left behind.
 *  `showsPickPrompt` is the real user-facing consequence: the page renders the
 *  prompt instead of a build whenever it has no genuine selection. */
interface VisitOutcome {
  showsPickPrompt: boolean;
  heroChampion: string;
  lane: LaneId;
  persisted: string | null;
}

/** Replays app/page.tsx's mount + persist lifecycle for ONE page load.
 *
 *  Mirrors the component exactly: resolve the landing session from storage,
 *  optionally apply a user action, then persist only if the rule allows it.
 *  Each call is an independent visit — component state does not carry over,
 *  which is the whole point. */
function simulateVisit(userAction?: { pick?: ChampionRef; lane?: LaneId }): VisitOutcome {
  const session = resolveVisitSession(SEED, INITIAL_LANE, readLastChampion());

  let champ = session.champ;
  let lane = session.lane;
  let chosen = session.chosen;

  if (userAction?.pick) {
    champ = userAction.pick;
    chosen = true; // a search/deep-link/champ-select pick is a real selection
  }
  if (userAction?.lane) lane = userAction.lane;

  // Hydration has completed by this point on every real mount.
  if (shouldPersistLastChampion({ hydrated: true, chosen })) {
    writeLastChampion(champ, lane);
  }

  return {
    showsPickPrompt: !chosen,
    heroChampion: champ.name,
    lane,
    persisted: store[KEY] ?? null,
  };
}

describe("last-champion session — across separate page visits", () => {
  it("firstVisitMustNotPersist: a first visit with no user action writes nothing", () => {
    const visit1 = simulateVisit();

    expect(visit1.showsPickPrompt).toBe(true);
    // THE REGRESSION. The seed reaching storage is what made the prompt a
    // once-per-device event.
    expect(visit1.persisted).toBeNull();
  });

  it("the pick prompt survives a second visit (the shipped P0)", () => {
    simulateVisit(); // visit 1 — user does nothing
    const visit2 = simulateVisit(); // visit 2 — a returning user

    // The seed is still what RENDERS underneath (the non-null contract), so the
    // assertion that matters is that the page still owes the user a pick and
    // visit 1 left nothing behind to restore.
    expect(visit2.showsPickPrompt).toBe(true);
    expect(visit2.persisted).toBeNull();
  });

  it("never opens on the seed champion, however many times you return", () => {
    const visits = [simulateVisit(), simulateVisit(), simulateVisit()];

    for (const v of visits) {
      expect(v.showsPickPrompt).toBe(true);
      expect(v.heroChampion).toBe(SEED.name); // the seed still RENDERS...
    }
    // ...but is never recorded as a choice, which is what the next visit reads.
    expect(store[KEY]).toBeUndefined();
  });

  it("a real selection IS remembered on the next visit, lane included", () => {
    const visit1 = simulateVisit({ pick: AHRI, lane: "mid" });
    expect(visit1.showsPickPrompt).toBe(false);
    expect(visit1.persisted).not.toBeNull();

    const visit2 = simulateVisit();
    expect(visit2.showsPickPrompt).toBe(false);
    expect(visit2.heroChampion).toBe("Ahri");
    expect(visit2.lane).toBe("mid");
  });

  it("a lane change on a restored session persists, but a lane change alone never does", () => {
    simulateVisit({ pick: AHRI, lane: "mid" });
    simulateVisit({ lane: "bot" }); // restored session + lane change
    expect(readLastChampion()?.lane).toBe("bot");

    // Fresh device: touching the lane selector is not choosing a champion, so
    // it must not launder the seed into storage.
    store = {};
    const laneOnly = simulateVisit({ lane: "top" });
    expect(laneOnly.showsPickPrompt).toBe(true);
    expect(laneOnly.persisted).toBeNull();
  });

  it("a corrupt stored value degrades to the prompt, not to the seed as a choice", () => {
    store[KEY] = "{ not json";
    const visit = simulateVisit();

    expect(visit.showsPickPrompt).toBe(true);
    expect(visit.persisted).toBe("{ not json"); // untouched, never overwritten with the seed
  });
});

describe("shouldPersistLastChampion — both conditions are load-bearing", () => {
  it("requires hydration AND a real selection", () => {
    expect(shouldPersistLastChampion({ hydrated: true, chosen: true })).toBe(true);
    // Pre-hydration: would clobber the stored value with the seed on first paint.
    expect(shouldPersistLastChampion({ hydrated: false, chosen: true })).toBe(false);
    // Hydrated but nothing chosen: THE P0. Hydration completing does not mean
    // the user has a selection.
    expect(shouldPersistLastChampion({ hydrated: true, chosen: false })).toBe(false);
    expect(shouldPersistLastChampion({ hydrated: false, chosen: false })).toBe(false);
  });
});

describe("resolveVisitSession", () => {
  it("flags the seed as NOT chosen when storage is empty", () => {
    const s = resolveVisitSession(SEED, INITIAL_LANE, null);
    expect(s.chosen).toBe(false);
    expect(s.champ).toEqual(SEED); // still renderable — non-null contract preserved
  });

  it("treats a stored value as a real choice", () => {
    const s = resolveVisitSession(SEED, INITIAL_LANE, { champ: AHRI, lane: "bot" });
    expect(s.chosen).toBe(true);
    expect(s.champ.name).toBe("Ahri");
    expect(s.lane).toBe("bot");
  });
});
