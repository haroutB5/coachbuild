/**
 * Tests for components/hextech/rankBracketStorage.ts.
 * vitest runs in node env, so `window` is undefined by default — exercised
 * directly by the SSR block. The "browser env" block stubs a minimal
 * in-memory localStorage shim on `globalThis.window` per test and tears it
 * down afterward, same pattern as lib/__tests__/favorites.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  readStoredRankBracketId,
  writeStoredRankBracketId,
  RANK_BRACKET_STORAGE_KEY,
} from "../hextech/rankBracketStorage";
import { RANK_BRACKETS, DEFAULT_RANK_BRACKET } from "@/lib/rankBrackets";

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

/** Single cast point for stubbing `globalThis.window` — the module under
 *  test only ever touches `window.localStorage.{getItem,setItem}`, so the
 *  stub deliberately doesn't implement the full `Storage`/`Window`
 *  interfaces. Isolating the `as unknown as ...` cast here (rather than a
 *  `@ts-expect-error` per call site) avoids TS2578 "unused directive"
 *  false-positives when the incompatible-type error actually surfaces on a
 *  different line than the directive (multi-line object literals). */
function stubWindow(localStorage: {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  /** Optional so the existing throwing-storage stubs stay valid literals.
   *  The module calls it only on the stale-id purge path (2026-08-11). */
  removeItem?: (k: string) => void;
  clear?: () => void;
}): void {
  (globalThis as unknown as { window: { localStorage: typeof localStorage } }).window = { localStorage };
}

function unstubWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe("rankBracketStorage — SSR (no window)", () => {
  it("readStoredRankBracketId returns the default when window is undefined", () => {
    expect(typeof window).toBe("undefined");
    expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
  });

  it("writeStoredRankBracketId is a no-op (never throws) when window is undefined", () => {
    expect(() => writeStoredRankBracketId(DEFAULT_RANK_BRACKET.id)).not.toThrow();
  });
});

describe("rankBracketStorage — browser env (stubbed localStorage)", () => {
  afterEach(() => {
    unstubWindow();
  });

  it("returns the default when nothing is stored", () => {
    stubWindow(makeLocalStorageShim());
    expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
  });

  it("round-trips a valid stored bracket id", () => {
    stubWindow(makeLocalStorageShim());
    writeStoredRankBracketId(DEFAULT_RANK_BRACKET.id);
    expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
    expect(window.localStorage.getItem(RANK_BRACKET_STORAGE_KEY)).toBe(DEFAULT_RANK_BRACKET.id);
  });

  it("falls back to the default when the stored id no longer names a real bracket", () => {
    const shim = makeLocalStorageShim();
    shim.setItem(RANK_BRACKET_STORAGE_KEY, "totally-unknown-bracket");
    stubWindow(shim);
    expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
  });

  // ── 2026-08-11 single-bracket migration ────────────────────────────────────
  // The app collapsed to one Diamond+ bracket, so EVERY id a returning user can
  // be holding is now retired. This is the whole migration: no mapping table,
  // just validate-or-default, plus a purge so the dead value does not linger.
  // A stale id must never produce an error, a blank read, or a query for the
  // tiers the app no longer offers.
  const RETIRED_IDS = ["all", "challenger", "grandmaster", "master", "diamond", "emerald", "platinum"];

  it("every RETIRED bracket id migrates to the single Diamond+ bracket", () => {
    for (const old of RETIRED_IDS) {
      const shim = makeLocalStorageShim();
      shim.setItem(RANK_BRACKET_STORAGE_KEY, old);
      stubWindow(shim);
      expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
      unstubWindow();
    }
  });

  it("PURGES a stale stored id as it reads it, so it is not re-migrated forever", () => {
    const shim = makeLocalStorageShim();
    shim.setItem(RANK_BRACKET_STORAGE_KEY, "emerald");
    stubWindow(shim);
    readStoredRankBracketId();
    expect(shim.getItem(RANK_BRACKET_STORAGE_KEY)).toBeNull();
  });

  it("does NOT purge a valid stored id", () => {
    const shim = makeLocalStorageShim();
    shim.setItem(RANK_BRACKET_STORAGE_KEY, DEFAULT_RANK_BRACKET.id);
    stubWindow(shim);
    readStoredRankBracketId();
    expect(shim.getItem(RANK_BRACKET_STORAGE_KEY)).toBe(DEFAULT_RANK_BRACKET.id);
  });

  it("still returns the default when the purge write itself throws (read-only storage)", () => {
    stubWindow({
      getItem: () => "emerald",
      setItem: () => {},
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    });
    expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
  });

  it("degrades to the default when localStorage.getItem throws (private-mode quota)", () => {
    stubWindow({
      getItem: () => {
        throw new Error("quota exceeded");
      },
      setItem: () => {},
    });
    expect(readStoredRankBracketId()).toBe(DEFAULT_RANK_BRACKET.id);
  });

  it("write degrades silently (never throws) when localStorage.setItem throws", () => {
    stubWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    expect(() => writeStoredRankBracketId(DEFAULT_RANK_BRACKET.id)).not.toThrow();
  });

  it("every RANK_BRACKETS id round-trips", () => {
    stubWindow(makeLocalStorageShim());
    for (const b of RANK_BRACKETS) {
      writeStoredRankBracketId(b.id);
      expect(readStoredRankBracketId()).toBe(b.id);
    }
  });
});
