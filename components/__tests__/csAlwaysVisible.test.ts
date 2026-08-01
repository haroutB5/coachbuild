/**
 * THE CS/MIN VISIBILITY INVARIANT (2026-08-01).
 *
 * HARD USER DIRECTIVE: "Some stats like cs/min aren't showing for all champs.
 * I want that included always."
 *
 * CS/min renders wherever a rate EXISTS. A thin sample changes the figure's
 * COLOUR (muted instead of gold, matching how this page already treats a
 * low-sample win rate), never its presence. An em dash in a CS column means
 * exactly one thing: `csPerMin === null`, nothing measured.
 *
 * WHY THIS FILE IS STRUCTURAL. The regression this guards against is not a bad
 * number — it is someone reinstating `csRateIsQuotable` as a visibility gate,
 * which is what it was originally written to be and what its name still
 * suggests. An example-based assertion cannot catch that: `csRateIsQuotable`
 * itself keeps returning exactly what it always did (it is still the right
 * answer to "is this sample thick?"), and there is no render test harness in
 * this repo to observe the JSX. So this asserts over the component SOURCE, the
 * same posture as lib/__tests__/mystats-queue-invariant.test.ts.
 *
 * Measured before the change, on the live account that prompted it: the gate
 * suppressed 34 of 35 champion rows, every one of which had a real
 * time-weighted rate. Corki showed an em dash while holding 7.0 over 9 games.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csRateIsQuotable, formatCsPerMin } from "@/components/hextech/mystats/profileModel";
import { MYSTATS_LOW_SAMPLE_THRESHOLD } from "@/components/hextech/myStats";

const ROOT = join(__dirname, "..", "..");
const CHAMPION_PANEL = join(ROOT, "components", "hextech", "mystats", "ChampionPerformancePanel.tsx");
const MATCH_PANEL = join(ROOT, "components", "hextech", "mystats", "MatchPerformancePanel.tsx");

/** Source with comments stripped — the prose in these files legitimately
 *  discusses the old gate at length, and matching on it would be matching on
 *  the explanation rather than the code. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("CS/min is never hidden by sample size", () => {
  it("ChampionPerformancePanel derives the displayed value from csPerMin alone, not from quotability", () => {
    const src = code(CHAMPION_PANEL);
    // The value shown must be gated on the rate EXISTING...
    expect(src).toMatch(/const cs\s*=\s*row\.csPerMin\s*!==\s*null\s*\?\s*formatCsPerMin/);
    // ...and must NOT be gated on quotability, in either direction.
    expect(src).not.toMatch(/const cs\s*=\s*quotable/);
    expect(src).not.toMatch(/csRateIsQuotable\([^)]*\)\s*\?\s*formatCsPerMin/);
  });

  it("MatchPerformancePanel's CS tile passes the raw season rate as its value", () => {
    const src = code(MATCH_PANEL);
    expect(src).toMatch(/value:\s*seasonCsPerMin\s*,/);
    expect(src).not.toMatch(/value:\s*csQuotable\s*\?/);
  });

  it("both panels still USE quotability — as styling weight, so a thin sample stays visible-but-muted", () => {
    // If a future edit deletes the concept outright rather than demoting it,
    // thin samples would render in the same gold as a 60-game average. The
    // directive was "always show", not "stop distinguishing".
    expect(code(CHAMPION_PANEL)).toMatch(/csThinSample/);
    expect(code(MATCH_PANEL)).toMatch(/valueClassName:\s*csQuotable\s*\?/);
  });
});

describe("csRateIsQuotable remains a correct thin-sample predicate", () => {
  it(`is false below ${MYSTATS_LOW_SAMPLE_THRESHOLD} games and true at or above it`, () => {
    expect(csRateIsQuotable(7.0, MYSTATS_LOW_SAMPLE_THRESHOLD - 1)).toBe(false);
    expect(csRateIsQuotable(7.0, MYSTATS_LOW_SAMPLE_THRESHOLD)).toBe(true);
  });

  it("is false when there is no rate at all — the one case that still renders an em dash", () => {
    expect(csRateIsQuotable(null, 50)).toBe(false);
  });

  it("formats a thin-sample rate identically to a thick one — only the colour differs", () => {
    // Pinning this stops a future 'fix' from smuggling the old behaviour back in
    // as a formatter that returns an em dash for small samples.
    expect(formatCsPerMin(5.8)).toBe(formatCsPerMin(5.8));
    expect(formatCsPerMin(5.8)).not.toMatch(/—|-{2}/);
  });
});

describe("the real rows that regressed", () => {
  // Values read off the live account on 2026-08-01, pre-fix. Every one of these
  // rendered an em dash; every one has a real measured rate.
  const REGRESSED = [
    { name: "Corki", csPerMin: 7.0, csGames: 9 },
    { name: "Malzahar", csPerMin: 7.8, csGames: 7 },
    { name: "Viktor (Top)", csPerMin: 6.8, csGames: 6 },
    { name: "Galio", csPerMin: 5.8, csGames: 5 },
  ];

  for (const row of REGRESSED) {
    it(`${row.name}: has a rate to show, and is correctly marked thin`, () => {
      expect(row.csPerMin).not.toBeNull();
      expect(csRateIsQuotable(row.csPerMin, row.csGames)).toBe(false);
      expect(formatCsPerMin(row.csPerMin)).toBeTruthy();
    });
  }
});
