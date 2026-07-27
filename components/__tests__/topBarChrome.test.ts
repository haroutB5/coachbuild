import { describe, expect, it } from "vitest";
import { topBarChromeConfig } from "../hextech/GlobalNav/topBarChrome";

describe("topBarChromeConfig", () => {
  it("hides the global search on mobile for /history (page owns its own pro-player search)", () => {
    expect(topBarChromeConfig("/history")).toEqual({ hideSearchOnMobile: true });
  });

  it("hides the global search on mobile for /draft (page owns two of its own champion inputs)", () => {
    expect(topBarChromeConfig("/draft")).toEqual({ hideSearchOnMobile: true });
  });

  it("keeps the global search on mobile for every other route", () => {
    for (const route of ["/", "/movers", "/mystats", "/compact", "/live-setup"]) {
      expect(topBarChromeConfig(route)).toEqual({ hideSearchOnMobile: false });
    }
  });

  it("defaults to keeping the search visible when pathname is null (usePathname can return null pre-mount)", () => {
    expect(topBarChromeConfig(null)).toEqual({ hideSearchOnMobile: false });
  });

  it("is exact-match, not a prefix match, so nested routes aren't silently swept in", () => {
    expect(topBarChromeConfig("/history/123")).toEqual({ hideSearchOnMobile: false });
    expect(topBarChromeConfig("/draft/foo")).toEqual({ hideSearchOnMobile: false });
  });
});
