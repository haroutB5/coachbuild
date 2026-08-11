/**
 * Tests for lib/draft/lolalyticsCheck.ts -- the EXTERNAL matchup-direction
 * tripwire added 2026-07-21 as a companion to lib/draft/ingestGuard.ts's
 * cross-source panel (baselines) + symmetry check (internal decode
 * integrity). This module verifies matchup DIRECTION against a third,
 * genuinely independent source (lolalytics's SSR counters pages), closing
 * the gap neither existing check covers -- see this file's own header for
 * the full reasoning.
 *
 * Fixtures (lib/draft/__fixtures__/):
 *  - lolalytics-garen-top.html: trimmed REAL bytes from the live Garen/top
 *    counters page (14 matchups, fetched + verified 2026-07-21).
 *  - lolalytics-garen-top-inverted.html: same real fixture with 2 rows'
 *    percentages replaced by their complement -- simulates the direction/
 *    keying error signature this check exists to catch.
 *  - lolalytics-mangled.html: a plausible markup-rework shape with only 2
 *    parseable rows -- proves the parser degrades gracefully instead of
 *    throwing, and the check verdict becomes "indeterminate".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseLolalyticsCounters,
  normalizeChampName,
  lolalyticsCountersUrl,
  runLolalyticsCheck,
  LOLALYTICS_PANEL,
  LOLALYTICS_TOLERANCE_PCT,
  LOLALYTICS_MIN_SAMPLE_GAMES,
  LOLALYTICS_MIN_PARSEABLE,
  LOLALYTICS_MIN_COMPARABLE,
  LOLALYTICS_FAIL_THRESHOLD,
  LOLALYTICS_FAIL_RATE_PCT,
  LOLALYTICS_RANK_SLUG,
  type LolalyticsCheckDeps,
  type LolalyticsPanelEntry,
} from "@/lib/draft/lolalyticsCheck";

const FIXTURES_DIR = join(__dirname, "..", "draft", "__fixtures__");
function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

const REAL_GAREN_HTML = loadFixture("lolalytics-garen-top.html");
const INVERTED_GAREN_HTML = loadFixture("lolalytics-garen-top-inverted.html");
const MANGLED_HTML = loadFixture("lolalytics-mangled.html");

describe("LOLALYTICS_PANEL", () => {
  it("has exactly 3 entries spanning 3 distinct roles (politeness: 3 pages total)", () => {
    expect(LOLALYTICS_PANEL).toHaveLength(3);
    expect(new Set(LOLALYTICS_PANEL.map((e) => e.role)).size).toBe(3);
  });

  // v0.109.0 — RANK is pinned as hard as patch already was, and for the same
  // reason. Verified live 2026-08-11: lolalytics' unpinned counters page is
  // Emerald+, which stopped resembling /draft's own bucket the moment v0.108.0
  // moved it to Diamond II+. Measured, same panel, same tolerance: unpinned
  // 3/33 = 9.1% disagreement (one matchup short of a false FAIL that blocks
  // retention), pinned 0/33 = 0.0%. `d2_plus` is lolalytics' own slug for our
  // bracket and its page echoes "D2+"; an unrecognised slug 404s rather than
  // silently defaulting, so a future rename breaks loudly.
  it("pins RANK on every counters URL, not just patch", () => {
    expect(LOLALYTICS_RANK_SLUG).toBe("d2_plus");
    for (const entry of LOLALYTICS_PANEL) {
      expect(lolalyticsCountersUrl(entry)).toContain(`&tier=${LOLALYTICS_RANK_SLUG}`);
      expect(lolalyticsCountersUrl(entry, "16.14")).toContain(`&tier=${LOLALYTICS_RANK_SLUG}`);
    }
  });

  it("lolalyticsCountersUrl builds the verified URL shape", () => {
    const viktor = LOLALYTICS_PANEL.find((e) => e.slug === "viktor")!;
    expect(lolalyticsCountersUrl(viktor)).toBe(`https://lolalytics.com/lol/viktor/counters/?lane=middle&tier=${LOLALYTICS_RANK_SLUG}`);
  });

  it("lolalyticsCountersUrl PINS the patch when given -- load-bearing, not cosmetic (see this function's doc comment: an unpinned fetch compared against a patch-behind DB produced 18 false disagreements live, 2026-07-21)", () => {
    const viktor = LOLALYTICS_PANEL.find((e) => e.slug === "viktor")!;
    expect(lolalyticsCountersUrl(viktor, "16.13")).toBe(
      `https://lolalytics.com/lol/viktor/counters/?lane=middle&tier=${LOLALYTICS_RANK_SLUG}&patch=16.13`
    );
  });
});

describe("parseLolalyticsCounters", () => {
  it("extracts every (opponent, winrate) pair from a real trimmed page sample", () => {
    const parsed = parseLolalyticsCounters(REAL_GAREN_HTML, "Garen");
    expect(parsed.length).toBe(14);
    expect(parsed[0]).toEqual({ oppName: "Twisted Fate", winPct: 44.83 });
    const ryze = parsed.find((p) => p.oppName === "Ryze");
    expect(ryze?.winPct).toBe(46.49);
  });

  it("never throws on malformed/empty input, and returns few/zero matches", () => {
    expect(() => parseLolalyticsCounters("", "Garen")).not.toThrow();
    expect(parseLolalyticsCounters("", "Garen")).toEqual([]);
    expect(() => parseLolalyticsCounters("<html>not lolalytics at all</html>", "Garen")).not.toThrow();
    expect(parseLolalyticsCounters("<html>not lolalytics at all</html>", "Garen")).toEqual([]);
  });

  it("degrades to well below LOLALYTICS_MIN_PARSEABLE on the mangled fixture, without throwing", () => {
    expect(() => parseLolalyticsCounters(MANGLED_HTML, "Garen")).not.toThrow();
    const parsed = parseLolalyticsCounters(MANGLED_HTML, "Garen");
    expect(parsed.length).toBeLessThan(LOLALYTICS_MIN_PARSEABLE);
    expect(parsed.length).toBe(2);
  });

  it("decodes HTML entities in opponent names (apostrophes, ampersands)", () => {
    const html = `Viktor<!----> wins against <!--t=1a-->Kai&#39;Sa<!----> <span class="text-green-300">50.00%</span> ` +
      `Viktor<!----> wins against <!--t=1b-->Nunu &amp; Willump<!----> <span class="text-green-300">51.00%</span>`;
    const parsed = parseLolalyticsCounters(html, "Viktor");
    expect(parsed).toEqual([
      { oppName: "Kai'Sa", winPct: 50.0 },
      { oppName: "Nunu & Willump", winPct: 51.0 },
    ]);
  });

  it("does not confuse a nearby 'average opponent winrate against X' sentence for the subject's own winrate", () => {
    // Real page shape: right after the subject's own winrate span, there is
    // often ALSO a pick-rate-deviation number and, further down, an
    // "average opponent winrate against {opp}" sentence for a DIFFERENT
    // opponent block -- neither should be picked up as Garen's winrate.
    const html =
      `Garen<!----> wins against <!--t=4l-->Gragas<!----> <span class="text-green-300">44.29%</span> of the time` +
      ` <span class="text-yellow-100">6.22%</span> less often than expected.` +
      ` The average opponent winrate against <!--t=4m-->Gragas<!----> is <span class="text-red-400">46.66%</span>.`;
    const parsed = parseLolalyticsCounters(html, "Garen");
    expect(parsed).toEqual([{ oppName: "Gragas", winPct: 44.29 }]);
  });

  it("dedupes a repeated opponent block instead of double-counting", () => {
    const html =
      `Garen<!----> wins against <!--t=1-->Ryze<!----> <span class="text-green-300">50.00%</span>` +
      `Garen<!----> wins against <!--t=2-->Ryze<!----> <span class="text-green-300">50.00%</span>`;
    expect(parseLolalyticsCounters(html, "Garen")).toHaveLength(1);
  });
});

describe("normalizeChampName", () => {
  it("collapses punctuation/case differences to the same key", () => {
    expect(normalizeChampName("Kai'Sa")).toBe(normalizeChampName("KaiSa"));
    expect(normalizeChampName("Nunu & Willump")).toBe(normalizeChampName("Nunu Willump"));
    expect(normalizeChampName("Vel'Koz")).toBe("velkoz");
    expect(normalizeChampName("Cho'Gath")).toBe("chogath");
  });
});

describe("runLolalyticsCheck", () => {
  function baseDeps(overrides: Partial<LolalyticsCheckDeps> = {}): LolalyticsCheckDeps {
    return {
      fetchHtml: async () => REAL_GAREN_HTML,
      getOurMatchup: async () => ({ winPct: 50, games: 5000 }),
      resolveChampIdByName: () => 999,
      ...overrides,
    };
  }
  const onePagePanel: LolalyticsPanelEntry[] = [
    { champId: 86, slug: "garen", subjectName: "Garen", lane: "top", role: 0, label: "Garen/top" },
  ];

  /** Builds deps that resolve each real opponent name to a stable synthetic
   *  id (index-based) and echo back the REAL fixture winrate for that name
   *  as "our" row -- i.e. a perfectly agreeing DB, so tests can override
   *  just the one or two rows they want to disagree. */
  function agreeingDeps(html: string, overridesByName: Record<string, { winPct: number; games: number }> = {}): LolalyticsCheckDeps {
    const byName = new Map(parseLolalyticsCounters(html, "Garen").map((p) => [p.oppName, p.winPct]));
    const names = Array.from(byName.keys());
    return {
      fetchHtml: async () => html,
      resolveChampIdByName: (name) => {
        const idx = names.indexOf(name);
        return idx === -1 ? null : idx + 1000; // stable synthetic id per opponent name
      },
      getOurMatchup: async (_subjectChampId, oppChampId) => {
        const name = names[oppChampId - 1000];
        if (!name) return null;
        if (overridesByName[name]) return overridesByName[name];
        const pct = byName.get(name);
        return pct === undefined ? null : { winPct: pct, games: 5000 };
      },
    };
  }

  it("passes when every high-sample matchup agrees within tolerance", async () => {
    const result = await runLolalyticsCheck(agreeingDeps(REAL_GAREN_HTML), onePagePanel);
    expect(result.verdict).toBe("pass");
    expect(result.comparisons).toHaveLength(14);
    expect(result.disagreements).toEqual([]);
  });

  it("FAILS when >= 2 high-sample matchups disagree beyond tolerance (direction/keying error signature)", async () => {
    // Fetches the INVERTED page (2 rows tampered to their complement), but
    // "our" side always reports the TRUE (un-inverted) real winrate parsed
    // from the ORIGINAL fixture -- simulates a correct DB compared against
    // lolalytics HTML where 2 rows disagree.
    const trueByName = new Map(parseLolalyticsCounters(REAL_GAREN_HTML, "Garen").map((p) => [p.oppName, p.winPct]));
    const parsedInverted = parseLolalyticsCounters(INVERTED_GAREN_HTML, "Garen");
    const names = parsedInverted.map((p) => p.oppName);
    const deps: LolalyticsCheckDeps = {
      fetchHtml: async () => INVERTED_GAREN_HTML,
      resolveChampIdByName: (name) => {
        const idx = names.indexOf(name);
        return idx === -1 ? null : idx + 1000;
      },
      getOurMatchup: async (_subjectChampId, oppChampId) => {
        const name = names[oppChampId - 1000];
        const truePct = name ? trueByName.get(name) : undefined;
        return truePct === undefined ? null : { winPct: truePct, games: 5000 };
      },
    };
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.verdict).toBe("fail");
    expect(result.disagreements.length).toBeGreaterThanOrEqual(LOLALYTICS_FAIL_THRESHOLD);
    expect(result.disagreements.some((d) => d.includes("Twisted Fate"))).toBe(true);
    expect(result.disagreements.some((d) => d.includes("Kayle"))).toBe(true);
  });

  it("threads the patch through to the fetched URL (page.url), pinning every panel page to OUR ingest's patch", async () => {
    const seenUrls: string[] = [];
    const deps = baseDeps({
      fetchHtml: async (url) => {
        seenUrls.push(url);
        return REAL_GAREN_HTML;
      },
    });
    const result = await runLolalyticsCheck(deps, onePagePanel, "16.13");
    const expectedUrl = `https://lolalytics.com/lol/garen/counters/?lane=top&tier=${LOLALYTICS_RANK_SLUG}&patch=16.13`;
    expect(seenUrls).toEqual([expectedUrl]);
    expect(result.pages[0].url).toBe(expectedUrl);
  });

  it("a single disagreeing matchup stays a PASS (one mismatch is cross-source noise, not the failure signature)", async () => {
    const deps = agreeingDeps(REAL_GAREN_HTML, { "Twisted Fate": { winPct: 90, games: 5000 } });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.disagreements).toHaveLength(1);
    expect(result.verdict).toBe("pass");
  });

  it("returns indeterminate when a page's HTML fetch throws", async () => {
    const deps = baseDeps({ fetchHtml: async () => { throw new Error("network down"); } });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.verdict).toBe("indeterminate");
    expect(result.pages[0].fetchError).toContain("network down");
    expect(result.pages[0].pageUsable).toBe(false);
  });

  it("returns indeterminate when the page's markup broke (mangled fixture, < LOLALYTICS_MIN_PARSEABLE rows)", async () => {
    const deps = baseDeps({ fetchHtml: async () => MANGLED_HTML });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.verdict).toBe("indeterminate");
    expect(result.pages[0].pageUsable).toBe(false);
    expect(result.pages[0].parsedPairs).toBeLessThan(LOLALYTICS_MIN_PARSEABLE);
    expect(result.comparisons).toEqual([]); // mangled page's parses never even attempted a compare
  });

  it("returns indeterminate when nothing resolves to a high-sample DB row (below LOLALYTICS_MIN_COMPARABLE)", async () => {
    const deps = baseDeps({
      resolveChampIdByName: () => 1,
      getOurMatchup: async () => null, // nothing in our DB yet for any opponent
    });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.verdict).toBe("indeterminate");
    expect(result.comparisons).toHaveLength(0);
  });

  it("excludes matchups below LOLALYTICS_MIN_SAMPLE_GAMES from comparisons entirely", async () => {
    const deps = baseDeps({
      resolveChampIdByName: () => 1,
      getOurMatchup: async () => ({ winPct: 90, games: LOLALYTICS_MIN_SAMPLE_GAMES - 1 }), // wildly wrong but LOW sample
    });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.comparisons).toHaveLength(0);
    expect(result.verdict).toBe("indeterminate"); // nothing comparable, never a false FAIL on low-sample noise
  });

  it("excludes an unresolved opponent name from comparisons (never a failure on its own)", async () => {
    const deps = baseDeps({ resolveChampIdByName: () => null });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.comparisons).toHaveLength(0);
  });

  it("uses LOLALYTICS_TOLERANCE_PCT as the default tolerance", async () => {
    const deps = baseDeps({
      resolveChampIdByName: () => 1,
      getOurMatchup: async () => ({ winPct: 50 + LOLALYTICS_TOLERANCE_PCT + 0.1, games: 5000 }),
    });
    const result = await runLolalyticsCheck(deps, onePagePanel);
    // every one of the 14 rows disagrees by the same fixed margin -> plenty >= failThreshold
    expect(result.disagreements.length).toBeGreaterThanOrEqual(LOLALYTICS_FAIL_THRESHOLD);
    expect(result.verdict).toBe("fail");
  });

  it("REGRESSION PIN (live-validation finding, 2026-07-21): a flat disagreement COUNT above the floor still PASSES when the RATE is ordinary noise at real scale", async () => {
    // Reproduces the shape that tripped this up live: lolalytics' real
    // counters pages return 100+ opponents, not the small handful "≥2
    // disagree" reads naturally for. 100 synthetic matchups, only 3
    // disagreeing (3% -- comfortably below LOLALYTICS_FAIL_RATE_PCT's 10%,
    // yet >= LOLALYTICS_FAIL_THRESHOLD's raw floor of 2) must still PASS.
    const names = Array.from({ length: 100 }, (_, i) => `Champ${i}`);
    const html = names
      .map((name, i) => `Garen<!----> wins against <!--t=${i}-->${name}<!----> <span class="text-green-300">50.00%</span>`)
      .join(" ");
    const deps: LolalyticsCheckDeps = {
      fetchHtml: async () => html,
      resolveChampIdByName: (name) => {
        const idx = names.indexOf(name);
        return idx === -1 ? null : idx;
      },
      getOurMatchup: async (_subjectChampId, oppChampId) => {
        // 3 out of 100 disagree by 10pt (well past the 4pt tolerance); the
        // other 97 agree exactly.
        const wrong = oppChampId < 3;
        return { winPct: wrong ? 60 : 50, games: 5000 };
      },
    };
    const result = await runLolalyticsCheck(deps, onePagePanel);
    expect(result.comparisons).toHaveLength(100);
    expect(result.disagreements).toHaveLength(3);
    expect(result.disagreements.length).toBeGreaterThanOrEqual(LOLALYTICS_FAIL_THRESHOLD); // clears the raw floor...
    expect(3 / 100).toBeLessThan(LOLALYTICS_FAIL_RATE_PCT); // ...but not the rate
    expect(result.verdict).toBe("pass"); // so the overall verdict must still be pass
  });
});
