/**
 * Pure-logic tests for teamCompDisplay.ts's helper functions — the boxed
 * Teams section's role-label resolution, box-title fallback, and win/loss
 * derivability check that TeamComp.tsx's JSX consumes. Imported from
 * teamCompDisplay.ts rather than TeamComp.tsx itself: this repo's Vitest
 * harness has no React/JSX transform configured, and TeamComp.tsx is a
 * "use client" component file that contains real JSX — importing it
 * straight into a .test.ts trips vite's import-analysis lexer on the
 * untransformed JSX. No JSX rendering here either way (no jsdom/RTL in this
 * repo's harness) — these are plain functions, so they run fine under
 * vitest's node environment.
 */
import { describe, it, expect } from "vitest";
import { roleAbbrForPlayer, teamBoxTitle, isSelfInAlly } from "../teamCompDisplay";

describe("roleAbbrForPlayer", () => {
  it("prefers a valid role field over position", () => {
    // Index 0 but role field says Mid (2) — role field wins.
    expect(roleAbbrForPlayer(2, 0, 5)).toBe("Mid");
  });

  it("covers every role index", () => {
    expect(roleAbbrForPlayer(0, 4, 5)).toBe("Top");
    expect(roleAbbrForPlayer(1, 4, 5)).toBe("Jg");
    expect(roleAbbrForPlayer(2, 4, 5)).toBe("Mid");
    expect(roleAbbrForPlayer(3, 4, 5)).toBe("Bot");
    expect(roleAbbrForPlayer(4, 4, 5)).toBe("Sup");
  });

  it("falls back to position when role is null and roster is standard length", () => {
    expect(roleAbbrForPlayer(null, 0, 5)).toBe("Top");
    expect(roleAbbrForPlayer(null, 3, 5)).toBe("Bot");
  });

  it("falls back to position when role is out of range", () => {
    expect(roleAbbrForPlayer(9, 2, 5)).toBe("Mid");
  });

  it("gives no hint when role is null/invalid AND the roster isn't the standard length", () => {
    expect(roleAbbrForPlayer(null, 0, 4)).toBeUndefined();
    expect(roleAbbrForPlayer(undefined, 1, 6)).toBeUndefined();
  });
});

describe("teamBoxTitle", () => {
  it("prefers a real team name when present, regardless of side", () => {
    expect(teamBoxTitle("ally", "T1", "Some Other Team")).toBe("T1");
    expect(teamBoxTitle("enemy", "Gen.G")).toBe("Gen.G");
  });

  it("falls back to 'Ally team' with the tracked player's team when known", () => {
    expect(teamBoxTitle("ally", undefined, "G2 Esports")).toBe("Ally team — G2 Esports");
    expect(teamBoxTitle("ally", null, "G2 Esports")).toBe("Ally team — G2 Esports");
  });

  it("falls back to plain 'Ally team' when no tracked player team is known", () => {
    expect(teamBoxTitle("ally", undefined, null)).toBe("Ally team");
    expect(teamBoxTitle("ally", undefined)).toBe("Ally team");
  });

  it("falls back to plain 'Enemy team' — never derivable from tracked player context", () => {
    expect(teamBoxTitle("enemy", undefined)).toBe("Enemy team");
    expect(teamBoxTitle("enemy", null)).toBe("Enemy team");
  });
});

describe("isSelfInAlly", () => {
  it("is true when the tracked champion is in the ally roster", () => {
    expect(isSelfInAlly([112, 64, 555, 104, 43], 112)).toBe(true);
  });

  it("is false when the tracked champion is missing from the ally roster", () => {
    expect(isSelfInAlly([238, 875, 887, 51, 40], 112)).toBe(false);
  });

  it("is false against an empty roster", () => {
    expect(isSelfInAlly([], 112)).toBe(false);
  });
});
