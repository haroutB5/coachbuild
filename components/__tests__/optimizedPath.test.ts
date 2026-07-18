import { describe, it, expect } from "vitest";
import { resolveOptimizedPathView } from "../hextech/optimizedPath";
import type { ItemsBlock, Pick } from "@/lib/types";

function pick(id: number, wpa = 1, occurrence = 500): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa, winrate: null, occurrence };
}

function baseItems(overrides: Partial<ItemsBlock> = {}): ItemsBlock {
  return {
    starter: pick(1),
    boots: pick(2),
    first: pick(3),
    second: pick(4),
    third: pick(5),
    fourthPlus: [],
    ...overrides,
  };
}

describe("resolveOptimizedPathView", () => {
  it("returns kind:none when optimizedPath is absent", () => {
    expect(resolveOptimizedPathView(baseItems())).toEqual({ kind: "none" });
  });

  it("returns kind:none when optimizedPath is an empty array", () => {
    expect(resolveOptimizedPathView(baseItems({ optimizedPath: [] }))).toEqual({ kind: "none" });
  });

  it("returns kind:confirmed when the 3-length path matches first/second/third exactly", () => {
    const items = baseItems({ optimizedPath: [pick(3), pick(4), pick(5)] });
    expect(resolveOptimizedPathView(items)).toEqual({ kind: "confirmed" });
  });

  it("returns kind:confirmed when a shorter (2-length) path matches the same-length prefix", () => {
    const items = baseItems({ optimizedPath: [pick(3), pick(4)] });
    expect(resolveOptimizedPathView(items)).toEqual({ kind: "confirmed" });
  });

  it("returns kind:path when the order differs (2nd/3rd swapped)", () => {
    const optimizedPath = [pick(3), pick(5), pick(4)];
    const items = baseItems({ optimizedPath });
    expect(resolveOptimizedPathView(items)).toEqual({ kind: "path", path: optimizedPath });
  });

  it("returns kind:path when a different item id appears at any depth", () => {
    const optimizedPath = [pick(3), pick(4), pick(999)];
    const items = baseItems({ optimizedPath });
    expect(resolveOptimizedPathView(items)).toEqual({ kind: "path", path: optimizedPath });
  });

  it("compares by id only — differing wpa/occurrence at the same ids still counts as confirmed", () => {
    const items = baseItems({
      optimizedPath: [pick(3, 9.9, 42), pick(4, -1, 7)],
    });
    expect(resolveOptimizedPathView(items)).toEqual({ kind: "confirmed" });
  });
});
