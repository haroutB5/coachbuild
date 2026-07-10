/**
 * Tests for the favorite-players data layer (lib/favorites.ts).
 * vitest runs in node env, so `window` is undefined by default — that's
 * exercised directly by the SSR describe block below. The "browser env"
 * block stubs a minimal in-memory localStorage shim on `globalThis.window`
 * per test and tears it down afterward so the two blocks stay isolated.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getFavorites,
  isFavorite,
  toggleFavorite,
  MAX_FAVORITES,
  type FavoritePlayer,
} from "../favorites";

const STORAGE_KEY = "coachbuild:favPlayers:v1";

function makeLocalStorageShim() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
}

const faker: FavoritePlayer = { id: "p1", name: "Faker", team: "T1" };
const chovy: FavoritePlayer = { id: "p2", name: "Chovy", team: "GEN" };
const caps: FavoritePlayer = { id: "p3", name: "Caps", team: null };

describe("favorites — browser env", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: makeLocalStorageShim(),
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("round-trips add then remove via toggleFavorite", () => {
    expect(getFavorites()).toEqual([]);

    const afterAdd = toggleFavorite(faker);
    expect(afterAdd).toEqual([faker]);
    expect(getFavorites()).toEqual([faker]);

    const afterRemove = toggleFavorite(faker);
    expect(afterRemove).toEqual([]);
    expect(getFavorites()).toEqual([]);
  });

  it("adds newest-first — most recently starred appears at index 0", () => {
    toggleFavorite(faker);
    const list = toggleFavorite(chovy);
    expect(list).toEqual([chovy, faker]);
  });

  it("isFavorite reflects current membership", () => {
    expect(isFavorite("p1")).toBe(false);
    toggleFavorite(faker);
    expect(isFavorite("p1")).toBe(true);
    toggleFavorite(faker);
    expect(isFavorite("p1")).toBe(false);
  });

  it("dedupes by id — a second toggle removes rather than duplicating", () => {
    toggleFavorite(faker);
    toggleFavorite({ ...faker, name: "Faker (renamed)" });
    expect(getFavorites()).toEqual([]);
  });

  it("removing an existing favorite does not reorder the rest", () => {
    toggleFavorite(faker); // [faker]
    toggleFavorite(chovy); // [chovy, faker]
    toggleFavorite(caps); // [caps, chovy, faker]

    const list = toggleFavorite(chovy); // remove middle -> [caps, faker]
    expect(list).toEqual([caps, faker]);
  });

  it("caps at MAX_FAVORITES — silently no-ops the add and returns the unchanged list", () => {
    for (let i = 0; i < MAX_FAVORITES; i++) {
      toggleFavorite({ id: `p${i}`, name: `Player ${i}`, team: null });
    }
    const before = getFavorites();
    expect(before.length).toBe(MAX_FAVORITES);

    const after = toggleFavorite({ id: "overflow", name: "Overflow", team: null });
    expect(after).toEqual(before);
    expect(getFavorites().length).toBe(MAX_FAVORITES);
    expect(isFavorite("overflow")).toBe(false);
  });

  it("still allows removal even while at MAX_FAVORITES", () => {
    for (let i = 0; i < MAX_FAVORITES; i++) {
      toggleFavorite({ id: `p${i}`, name: `Player ${i}`, team: null });
    }
    const list = toggleFavorite({ id: "p0", name: "Player 0", team: null });
    expect(list.length).toBe(MAX_FAVORITES - 1);
    expect(isFavorite("p0")).toBe(false);
  });

  it("recovers from corrupted JSON in storage — treats as empty, never throws", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(() => getFavorites()).not.toThrow();
    expect(getFavorites()).toEqual([]);
  });

  it("recovers from a non-array stored value — treats as empty", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ id: "p1", name: "Faker" })
    );
    expect(getFavorites()).toEqual([]);
  });

  it("filters out malformed entries while keeping well-shaped ones", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: "p1", name: "Faker", team: "T1" },
        { id: "p2" }, // missing name -> dropped
        { name: "No Id" }, // missing id -> dropped
        "not an object",
        null,
        42,
      ])
    );
    expect(getFavorites()).toEqual([{ id: "p1", name: "Faker", team: "T1" }]);
  });

  it("coerces a missing or non-string team to null", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: "p1", name: "Faker" }, // team missing
        { id: "p2", name: "Chovy", team: 123 }, // team wrong type
      ])
    );
    expect(getFavorites()).toEqual([
      { id: "p1", name: "Faker", team: null },
      { id: "p2", name: "Chovy", team: null },
    ]);
  });

  it("is resilient to setItem throwing (Safari private-mode quota) — still returns the computed list", () => {
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("QuotaExceededError");
        },
        removeItem: () => {},
        clear: () => {},
      },
    };

    expect(() => toggleFavorite(faker)).not.toThrow();
    const list = toggleFavorite(faker);
    expect(list).toEqual([faker]);
  });
});

describe("favorites — SSR / no window", () => {
  it("has no window in this node test env (sanity check for the block below)", () => {
    expect(typeof window).toBe("undefined");
  });

  it("getFavorites returns [] without crashing when window is undefined", () => {
    expect(() => getFavorites()).not.toThrow();
    expect(getFavorites()).toEqual([]);
  });

  it("isFavorite returns false without crashing when window is undefined", () => {
    expect(() => isFavorite("p1")).not.toThrow();
    expect(isFavorite("p1")).toBe(false);
  });

  it("toggleFavorite no-ops without crashing when window is undefined", () => {
    expect(() => toggleFavorite(faker)).not.toThrow();
    expect(toggleFavorite(faker)).toEqual([]);
  });
});
