import { describe, it, expect } from "vitest";
import { NAV_ITEMS, MOBILE_NAV_ITEMS } from "../navItems";

describe("NAV_ITEMS", () => {
  it("has exactly 7 items", () => {
    expect(NAV_ITEMS).toHaveLength(7);
  });

  it("groups partition into 3 play + 3 data + 1 setup", () => {
    expect(NAV_ITEMS.filter((i) => i.group === "play")).toHaveLength(3);
    expect(NAV_ITEMS.filter((i) => i.group === "data")).toHaveLength(3);
    expect(NAV_ITEMS.filter((i) => i.group === "setup")).toHaveLength(1);
  });

  it("has no duplicate hrefs", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("has no duplicate ids", () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every href is a real, absolute in-app route", () => {
    const known = ["/", "/draft", "/live-setup", "/history", "/movers", "/mystats", "/mystats?intent=game-detail"];
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(known).toContain(item.href);
    }
  });

  it("Nocturne order — Draft, Builds, Post-Game, data, then Companion", () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      "/draft",
      "/",
      "/mystats?intent=game-detail",
      "/history",
      "/movers",
      "/mystats",
      "/live-setup",
    ]);
  });
});

describe("MOBILE_NAV_ITEMS", () => {
  it("is exactly [Builds, Pro Players, Patch Movers, My Stats] in that order", () => {
    expect(MOBILE_NAV_ITEMS.map((i) => i.href)).toEqual(["/", "/history", "/movers", "/mystats"]);
  });

  it("has exactly 4 items", () => {
    expect(MOBILE_NAV_ITEMS).toHaveLength(4);
  });

  it("excludes Draft, Post-Game, and Companion on mobile", () => {
    const hrefs = MOBILE_NAV_ITEMS.map((i) => i.href);
    expect(hrefs).not.toContain("/draft");
    expect(hrefs).not.toContain("/mystats?intent=game-detail");
    expect(hrefs).not.toContain("/live-setup");
  });

  it("is a strict subset of NAV_ITEMS, derived from the mobile flag", () => {
    for (const item of MOBILE_NAV_ITEMS) {
      expect(item.mobile).toBe(true);
      expect(NAV_ITEMS).toContainEqual(item);
    }
  });
});
