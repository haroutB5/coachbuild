import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { getAccountSecret } = vi.hoisted(() => ({
  getAccountSecret: vi.fn(() => "desktop-pairing-secret-should-not-leak"),
}));

vi.mock("@/components/live/mystatsAccount", () => ({ getAccountSecret }));

import PairDesktopControl, {
  PairDesktopControlView,
  copyPairDesktopSecret,
  pairDesktopStateAfterReveal,
  type PairDesktopState,
} from "@/components/hextech/mystats/PairDesktopControl";

const SECRET = "desktop-pairing-secret-should-not-leak";

function renderState(state: PairDesktopState): string {
  return renderToStaticMarkup(
    createElement(PairDesktopControlView, {
      state,
      copyState: "idle",
      onReveal: () => undefined,
      onHide: () => undefined,
      onCopy: () => undefined,
    })
  );
}

describe("PairDesktopControl", () => {
  it("keeps the credential absent from the initial paint", () => {
    getAccountSecret.mockClear();
    const html = renderToStaticMarkup(createElement(PairDesktopControl));

    expect(html).toContain("Pair desktop app");
    expect(html).not.toContain("Desktop pairing secret");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(">Copy<");
    expect(getAccountSecret).not.toHaveBeenCalled();
  });

  it("reveals the existing credential and copy affordance after the reveal action", () => {
    const state = pairDesktopStateAfterReveal(`  ${SECRET}  `);
    const html = renderState(state);

    expect(state).toEqual({ status: "revealed", secret: SECRET });
    expect(html).toContain(`value="${SECRET}"`);
    expect(html).toContain("Desktop pairing secret");
    expect(html).toContain("CoachBuild desktop tray");
    expect(html).toContain("Copy");
    expect(html).toContain("Hide secret");
  });

  it("shows useful guidance instead of an empty credential when none is stored", () => {
    const state = pairDesktopStateAfterReveal(null);
    const html = renderState(state);

    expect(state).toEqual({ status: "missing" });
    expect(html).toContain("No My Stats account secret is saved in this browser yet");
    expect(html).toContain("Check again");
    expect(html).not.toContain("Desktop pairing secret");
    expect(html).not.toContain("<input");
  });

  it("copies only the revealed credential through the supplied clipboard writer", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(copyPairDesktopSecret(SECRET, { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(SECRET);
  });
});
