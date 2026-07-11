/**
 * Tests for the one-shot cross-page player-select handoff
 * (playerSelectHandoff.ts). vitest runs in node env, so `window` is
 * undefined by default — exercised directly by the SSR block below. The
 * "browser env" block stubs a minimal in-memory sessionStorage shim on
 * `globalThis.window` per test and tears it down afterward, same pattern as
 * lib/__tests__/favorites.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stashPendingPlayerSelect, consumePendingPlayerSelect } from "../playerSelectHandoff";

const STORAGE_KEY = "coachbuild:pendingPlayerSelect:v1";

function makeSessionStorageShim() {
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

describe("playerSelectHandoff — SSR (no window)", () => {
  it("stashPendingPlayerSelect no-ops without throwing", () => {
    expect(() => stashPendingPlayerSelect({ id: "p1", name: "Faker", team: "T1" })).not.toThrow();
  });

  it("consumePendingPlayerSelect returns null", () => {
    expect(consumePendingPlayerSelect()).toBeNull();
  });
});

describe("playerSelectHandoff — browser env", () => {
  let sessionStorage: ReturnType<typeof makeSessionStorageShim>;

  beforeEach(() => {
    sessionStorage = makeSessionStorageShim();
    (globalThis as any).window = { sessionStorage };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("round-trips a stashed player", () => {
    stashPendingPlayerSelect({ id: "p1", name: "Gumayusi", team: null });
    expect(consumePendingPlayerSelect()).toEqual({ id: "p1", name: "Gumayusi", team: null });
  });

  it("clears the entry once consumed — a second consume returns null", () => {
    stashPendingPlayerSelect({ id: "p1", name: "Gumayusi", team: null });
    consumePendingPlayerSelect();
    expect(consumePendingPlayerSelect()).toBeNull();
  });

  it("returns null when nothing is stashed", () => {
    expect(consumePendingPlayerSelect()).toBeNull();
  });

  it("treats malformed JSON as nothing pending, without throwing", () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");
    expect(() => consumePendingPlayerSelect()).not.toThrow();
    expect(consumePendingPlayerSelect()).toBeNull();
  });

  it("treats a shape-invalid parsed value as nothing pending", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: 123, name: "Bad" }));
    expect(consumePendingPlayerSelect()).toBeNull();
  });

  it("accepts team: null as a valid shape", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "p2", name: "Chovy", team: null }));
    expect(consumePendingPlayerSelect()).toEqual({ id: "p2", name: "Chovy", team: null });
  });
});
