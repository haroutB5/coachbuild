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
    expect(() => writeStoredRankBracketId("challenger")).not.toThrow();
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
    writeStoredRankBracketId("challenger");
    expect(readStoredRankBracketId()).toBe("challenger");
    expect(window.localStorage.getItem(RANK_BRACKET_STORAGE_KEY)).toBe("challenger");
  });

  it("falls back to the default when the stored id no longer names a real bracket", () => {
    const shim = makeLocalStorageShim();
    shim.setItem(RANK_BRACKET_STORAGE_KEY, "totally-unknown-bracket");
    stubWindow(shim);
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
    expect(() => writeStoredRankBracketId("master")).not.toThrow();
  });

  it("every RANK_BRACKETS id round-trips", () => {
    stubWindow(makeLocalStorageShim());
    for (const b of RANK_BRACKETS) {
      writeStoredRankBracketId(b.id);
      expect(readStoredRankBracketId()).toBe(b.id);
    }
  });
});
