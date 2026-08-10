import { describe, it, expect } from "vitest";
import { NAV_ITEMS, MOBILE_NAV_ITEMS, MOBILE_OVERFLOW_NAV_ITEMS } from "../navItems";

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

  it("excludes Draft, Post-Game, and Companion from the BAR itself", () => {
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

// 2026-08-10 — the regression these lock is "a destination exists in NAV_ITEMS
// and has no entrance on a phone". At 390px the bar was the only navigation in
// the DOM, so /draft, /mystats?intent=game-detail and /live-setup were
// unreachable by any on-screen control. The partition test below is the one
// that actually prevents a recurrence: a future nav item cannot land in neither
// list.
describe("MOBILE_OVERFLOW_NAV_ITEMS", () => {
  it("carries exactly the three destinations that are not in the bar", () => {
    expect(MOBILE_OVERFLOW_NAV_ITEMS.map((i) => i.href)).toEqual([
      "/draft",
      "/mystats?intent=game-detail",
      "/live-setup",
    ]);
  });

  it("includes the companion pairing page, whose only other entrance is the desktop rail", () => {
    expect(MOBILE_OVERFLOW_NAV_ITEMS.map((i) => i.href)).toContain("/live-setup");
  });

  it("partitions NAV_ITEMS with MOBILE_NAV_ITEMS — every destination is reachable on mobile", () => {
    const bar = MOBILE_NAV_ITEMS.map((i) => i.id);
    const sheet = MOBILE_OVERFLOW_NAV_ITEMS.map((i) => i.id);
    expect([...bar, ...sheet].sort()).toEqual(NAV_ITEMS.map((i) => i.id).sort());
    expect(bar.filter((id) => sheet.includes(id))).toEqual([]);
    expect(bar.length + sheet.length).toBe(NAV_ITEMS.length);
  });

  it("every shortLabel is a strict substring of its full label", () => {
    // WCAG 3.2.4: the bar and the desktop rail are the same destination, so
    // the short form must be a shortening, never a second name for it.
    for (const item of NAV_ITEMS) {
      if (!item.shortLabel) continue;
      expect(item.shortLabel.length).toBeLessThan(item.label.length);
      expect(item.label).toContain(item.shortLabel);
    }
  });

  it("only the two measured-overflowing bar items carry a shortLabel", () => {
    expect(NAV_ITEMS.filter((i) => i.shortLabel).map((i) => [i.id, i.shortLabel])).toEqual([
      ["pro-players", "Players"],
      ["patch-movers", "Movers"],
    ]);
  });

  it("every overflow item carries an icon key the bar sheet can render", () => {
    for (const item of MOBILE_OVERFLOW_NAV_ITEMS) {
      expect(item.mobile).toBe(false);
      expect(item.iconKey.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
