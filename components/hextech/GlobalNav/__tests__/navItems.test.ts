import { describe, it, expect } from "vitest";
import { NAV_ITEMS, MOBILE_NAV_ITEMS } from "../navItems";

describe("NAV_ITEMS", () => {
  it("has exactly 6 items", () => {
    expect(NAV_ITEMS).toHaveLength(6);
  });

  it("groups partition into 3 play + 3 data", () => {
    expect(NAV_ITEMS.filter((i) => i.group === "play")).toHaveLength(3);
    expect(NAV_ITEMS.filter((i) => i.group === "data")).toHaveLength(3);
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
    const known = ["/", "/draft", "/live-setup", "/history", "/movers", "/mystats"];
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(known).toContain(item.href);
    }
  });

  it("mockup order — Builds, Draft, Companion, Pro Players, Patch Movers, My Stats", () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(["/", "/draft", "/live-setup", "/history", "/movers", "/mystats"]);
  });
});

describe("MOBILE_NAV_ITEMS", () => {
  it("is exactly [Builds, Pro Players, Patch Movers, My Stats] in that order", () => {
    expect(MOBILE_NAV_ITEMS.map((i) => i.href)).toEqual(["/", "/history", "/movers", "/mystats"]);
  });

  it("has exactly 4 items", () => {
    expect(MOBILE_NAV_ITEMS).toHaveLength(4);
  });

  it("excludes /draft and /live-setup (Draft + Companion, per user directive)", () => {
    const hrefs = MOBILE_NAV_ITEMS.map((i) => i.href);
    expect(hrefs).not.toContain("/draft");
    expect(hrefs).not.toContain("/live-setup");
  });

  it("is a strict subset of NAV_ITEMS, derived from the mobile flag", () => {
    for (const item of MOBILE_NAV_ITEMS) {
      expect(item.mobile).toBe(true);
      expect(NAV_ITEMS).toContainEqual(item);
    }
  });
});
