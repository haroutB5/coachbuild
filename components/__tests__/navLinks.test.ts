import { describe, it, expect } from "vitest";
import { NAV_LINKS } from "../hextech/navLinks";

describe("NAV_LINKS", () => {
  it("has exactly 5 links", () => {
    expect(NAV_LINKS).toHaveLength(5);
  });

  it("matches the exact {href,label} pairs in order", () => {
    expect(NAV_LINKS).toEqual([
      { href: "/history", label: "Pro players" },
      { href: "/movers", label: "Patch movers" },
      { href: "/live-setup", label: "Companion" },
      { href: "/draft", label: "Draft" },
      { href: "/mystats", label: "My Stats" },
    ]);
  });

  it("has no duplicate hrefs", () => {
    const hrefs = NAV_LINKS.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("has no duplicate labels", () => {
    const labels = NAV_LINKS.map((l) => l.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every href is an absolute in-app route", () => {
    for (const link of NAV_LINKS) {
      expect(link.href.startsWith("/")).toBe(true);
    }
  });
});
