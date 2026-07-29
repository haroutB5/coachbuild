import { describe, it, expect } from "vitest";
import {
  BUILD_TAB_OPTIONS,
  DEFAULT_BUILD_TAB,
  buildTabId,
  buildTabPanelId,
  isBuildTab,
  type BuildTab,
} from "../hextech/buildTabLayout";

// This file previously asserted a five-card left/right column split (runes,
// core, starting, proConsensus, situational) that had not described the real
// page since v0.51.0. It passed the whole time, because the module it tested had
// no importer — so the test certified a layout nothing rendered. The assertions
// below are deliberately about things BuildTabContent.tsx actually consumes.

describe("BUILD_TAB_OPTIONS", () => {
  it("is Build, Pro, OTP in that order", () => {
    expect(BUILD_TAB_OPTIONS.map((o) => o.value)).toEqual(["build", "pro", "otp"]);
  });

  // Pinned to mobile's labels on purpose — desktop adopts mobile's navigation
  // rather than inventing a parallel one. The user typed "WPA" for the first
  // tab; that question is open in HANDOFF-fronty.md and is theirs to settle, so
  // this test is the thing that has to change if they decide it, rather than the
  // label drifting quietly.
  it("labels match the mobile tab strip exactly", () => {
    expect(BUILD_TAB_OPTIONS.map((o) => o.label)).toEqual(["Build", "Pro", "OTP"]);
  });

  it("has no duplicate values", () => {
    const values = BUILD_TAB_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("opens on the WPA build", () => {
    expect(DEFAULT_BUILD_TAB).toBe("build");
    expect(BUILD_TAB_OPTIONS.some((o) => o.value === DEFAULT_BUILD_TAB)).toBe(true);
  });
});

describe("tab / panel ids", () => {
  // HextechTabs builds `hextech-tab-<value>` for the button's own id and
  // `hextech-tabpanel-<value>` for its aria-controls. BuildTabContent builds the
  // panel's id and aria-labelledby from these helpers. If the two shapes drift,
  // aria-controls points at nothing and aria-labelledby names nothing — an
  // a11y break with no visual symptom whatsoever, which is exactly the kind
  // this repo has shipped before.
  it("match the ids HextechTabs generates", () => {
    expect(buildTabId("build")).toBe("hextech-tab-build");
    expect(buildTabId("pro")).toBe("hextech-tab-pro");
    expect(buildTabId("otp")).toBe("hextech-tab-otp");
    expect(buildTabPanelId("build")).toBe("hextech-tabpanel-build");
    expect(buildTabPanelId("pro")).toBe("hextech-tabpanel-pro");
    expect(buildTabPanelId("otp")).toBe("hextech-tabpanel-otp");
  });

  it("are unique across every tab", () => {
    const ids = BUILD_TAB_OPTIONS.flatMap((o) => [buildTabId(o.value), buildTabPanelId(o.value)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never collide between a tab and a panel", () => {
    for (const o of BUILD_TAB_OPTIONS) {
      expect(buildTabId(o.value)).not.toBe(buildTabPanelId(o.value));
    }
  });
});

describe("isBuildTab", () => {
  it("accepts every declared tab", () => {
    for (const o of BUILD_TAB_OPTIONS) expect(isBuildTab(o.value)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const v of ["", "BUILD", "pros", "wpa", "proBuilds"]) expect(isBuildTab(v)).toBe(false);
  });

  it("narrows to BuildTab", () => {
    const raw: string = "otp";
    if (isBuildTab(raw)) {
      const narrowed: BuildTab = raw;
      expect(narrowed).toBe("otp");
    } else {
      throw new Error("expected 'otp' to narrow");
    }
  });
});
