/**
 * Tests for lib/lolalytics/counters.ts — the lolalytics counter-pick feed.
 *
 * Fixture: lib/lolalytics/__fixtures__/lolalytics-viktor-counters-trimmed.html
 * — REAL bytes sliced from _research/site-import/lolalytics-viktor-counters.html
 * (Viktor/middle, Emerald+, patch 16.17, captured 2026-09-08): the <title> +
 * canonical link + 4 complete card+tooltip blocks (Olaf, Vel'Koz, Xerath —
 * whose vs-link carries NO query string — and Smolder). No network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOLALYTICS_MIN_GAMES,
  LolalyticsCountersError,
  championSlugForCounters,
  countersPageUrl,
  parseCountersPage,
  rankCounterSuggestions,
  resolveCountersForEnemy,
} from "@/lib/lolalytics/counters";
import { resolveCounterPickPool, splitCounterSuggestions } from "@/lib/lolalytics/pool";

const FIXTURE_HTML = readFileSync(
  join(__dirname, "..", "__fixtures__", "lolalytics-viktor-counters-trimmed.html"),
  "utf8"
);

// Real champion ids for the four fixture rows.
const CHAMPIONS = [
  { id: 112, name: "Viktor" },
  { id: 2, name: "Olaf" },
  { id: 161, name: "Vel'Koz" },
  { id: 101, name: "Xerath" },
  { id: 901, name: "Smolder" },
];

describe("countersPageUrl", () => {
  it("builds the orchestrator-verified SSR shape (lane + emerald_plus tier + patch)", () => {
    expect(countersPageUrl("mel", "middle", "16.17")).toBe(
      "https://lolalytics.com/lol/mel/counters/?lane=middle&tier=emerald_plus&patch=16.17"
    );
  });
});

describe("championSlugForCounters", () => {
  it("folds plain names directly (viktor, wukong — wukong proven by /lol/wukong/counters/ in the fixture)", () => {
    expect(championSlugForCounters("Viktor")).toBe("viktor");
    expect(championSlugForCounters("Wukong")).toBe("wukong");
    expect(championSlugForCounters("Vel'Koz")).toBe("velkoz");
  });
  it("applies the fixture-proven nunu override (card links /vs/nunu/ for 'Nunu & Willump')", () => {
    expect(championSlugForCounters("Nunu & Willump")).toBe("nunu");
  });
});

describe("parseCountersPage (fixture-driven)", () => {
  it("parses all 4 cards with page-perspective numbers", () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.skippedCards).toBe(0);

    const olaf = parsed.rows.find((r) => r.oppSlug === "olaf")!;
    expect(olaf.oppName).toBe("Olaf");
    expect(olaf.pageWinPct).toBeCloseTo(43.81, 2);
    expect(olaf.fieldWinPct).toBeCloseTo(47.84, 2);
    expect(olaf.delta1pp).toBeCloseTo(-4.03, 2);
    expect(olaf.delta2pp).toBeCloseTo(-7.93, 2);
    expect(olaf.games).toBe(105);
  });

  it("accepts vs-links with no query string (xerath card links /build/ bare)", () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    const xerath = parsed.rows.find((r) => r.oppSlug === "xerath")!;
    expect(xerath.oppName).toBe("Xerath");
    expect(xerath.pageWinPct).toBeCloseTo(48.78, 2);
    expect(xerath.games).toBe(8674);
  });

  it("pins the direction proof: every card's tooltip agrees with its WR column", () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    expect(parsed.directionAgreements).toBe(4);
  });

  it("throws not-counters-page on a non-counters document (never a silent empty list)", () => {
    expect(() => parseCountersPage("<html><head><title>Cloudflare challenge</title></head></html>", {
      slug: "viktor",
      subjectName: "Viktor",
    })).toThrowError(LolalyticsCountersError);
    try {
      parseCountersPage("<html></html>", { slug: "viktor", subjectName: "Viktor" });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("not-counters-page");
    }
  });

  it("throws no-cards when the title is right but no card chunk exists", () => {
    const html = "<html><head><title>Viktor Counters - LoLalytics</title></head><body>redesign</body></html>";
    try {
      parseCountersPage(html, { slug: "viktor", subjectName: "Viktor" });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("no-cards");
    }
  });

  it("throws page-mismatch when the page serves a different champion (redirect/wrong slug)", () => {
    try {
      parseCountersPage(FIXTURE_HTML, { slug: "mel", subjectName: "Mel" });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("page-mismatch");
    }
  });

  it("throws direction-unproven when a tooltip disagrees with its card (column perspective flip)", () => {
    // Flip Olaf's tooltip WR to its complement — the card still says 43.81.
    const tampered = FIXTURE_HTML.replace(
      'wins against <!--t=4l-->Olaf<!----> <span class="text-green-300">43.81%',
      'wins against <!--t=4l-->Olaf<!----> <span class="text-green-300">56.19%'
    );
    expect(tampered).not.toBe(FIXTURE_HTML);
    try {
      parseCountersPage(tampered, { slug: "viktor", subjectName: "Viktor" });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("direction-unproven");
    }
  });

  it("throws direction-unproven when tooltips vanish entirely (WR column becomes unprovable)", () => {
    const stripped = FIXTURE_HTML.replaceAll(" wins against ", " — removed ");
    try {
      parseCountersPage(stripped, { slug: "viktor", subjectName: "Viktor" });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("direction-unproven");
    }
  });
});

describe("rankCounterSuggestions — direction convention + sample gate", () => {
  const byName = new Map(CHAMPIONS.map((c) => [c.name.toLowerCase().replace(/[^a-z0-9]/g, ""), c]));

  it("flips to candidate perspective: Vel'Koz beats Viktor 51.37% (page WR 48.63)", () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    // Gate at 0 to isolate the direction flip from the sample gate.
    const ranked = rankCounterSuggestions(parsed.rows, byName, 0, 15);
    const velkoz = ranked.suggestions.find((s) => s.champId === 161)!;
    expect(velkoz.winRate).toBeCloseTo(1 - 0.4863, 4);
    expect(velkoz.delta1pp).toBeCloseTo(47.73 - 48.63, 2); // field minus page = candidate edge
    expect(velkoz.delta2pp).toBeCloseTo(3.0, 2); // negated page Δ2
    expect(velkoz.games).toBe(1530);
  });

  it("ranks only champions that beat the enemy, candidate win rate descending", () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    const ranked = rankCounterSuggestions(parsed.rows, byName, 0, 15);
    expect(ranked.suggestions.map((s) => s.champId)).toEqual([2, 161, 101]);
    expect(ranked.suggestions.some((s) => s.champId === 901)).toBe(false); // Smolder loses to Viktor (34.07% candidate WR)
  });

  it(`applies the ${LOLALYTICS_MIN_GAMES}-game sample gate (Olaf n=105 and Smolder n=452 hidden, counted)`, () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    const ranked = rankCounterSuggestions(parsed.rows, byName);
    expect(ranked.suggestions.map((s) => s.champId)).toEqual([161, 101]);
    expect(ranked.gated).toBe(2);
  });

  it("throws unmapped-champions when no row resolves (list gap, not 'no counters')", () => {
    const parsed = parseCountersPage(FIXTURE_HTML, { slug: "viktor", subjectName: "Viktor" });
    try {
      rankCounterSuggestions(parsed.rows, new Map(), 0);
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("unmapped-champions");
    }
  });
});

describe("counter-pick pool provider + rank-preserving intersection", () => {
  const ranked = [
    { champId: 2, rank: 1 },
    { champId: 161, rank: 2 },
    { champId: 101, rank: 3 },
    { champId: 99, rank: 4 },
    { champId: 45, rank: 5 },
    { champId: 55, rank: 6 },
  ];

  it("prefers an available LCU pool and preserves lolalytics rank order", () => {
    const pool = resolveCounterPickPool({ lcuPoolChampIds: [101, 2], mystatsPoolChampIds: [161] });
    const split = splitCounterSuggestions(ranked, pool, 5, 5);
    expect(pool.source).toBe("lcu");
    expect(split.poolPicks.map((s) => s.champId)).toEqual([2, 101]);
    expect(split.overallPicks.map((s) => s.champId)).toEqual([161, 99, 45, 55]);
  });

  it("uses mystats only when the LCU pool is unavailable", () => {
    const pool = resolveCounterPickPool({ lcuPoolChampIds: [], mystatsPoolChampIds: [161, 45] });
    const split = splitCounterSuggestions(ranked, pool, 5, 5);
    expect(pool.source).toBe("mystats");
    expect(split.poolPicks.map((s) => s.champId)).toEqual([161, 45]);
  });

  it("falls back to the global top five when neither pool is available", () => {
    const pool = resolveCounterPickPool({ lcuPoolChampIds: null, mystatsPoolChampIds: null });
    const split = splitCounterSuggestions(ranked, pool, 5, 5);
    expect(pool.source).toBe("none");
    expect(split.poolPicks).toEqual([]);
    expect(split.overallPicks.map((s) => s.champId)).toEqual([2, 161, 101, 99, 45]);
  });
});

describe("resolveCountersForEnemy", () => {
  it("orchestrates fetch -> parse -> rank over injected deps (no network)", async () => {
    const resolved = await resolveCountersForEnemy({ id: 112, name: "Viktor" }, "middle", "16.17", {
      fetchImpl: (async () =>
        new Response(FIXTURE_HTML, { status: 200, headers: { "Content-Type": "text/html" } })) as never,
      champions: CHAMPIONS,
    });
    expect(resolved.enemySlug).toBe("viktor");
    expect(resolved.tier).toBe("emerald_plus");
    expect(resolved.patch).toBe("16.17");
    expect(resolved.suggestions.map((s) => s.champId)).toEqual([161, 101]);
    expect(resolved.parsedRows).toBe(4);
    expect(resolved.gatedRows).toBe(2);
    expect(typeof resolved.fetchedAt).toBe("string");
  });

  it("maps HTTP failures to typed fetch-failed (where the worker-webview fallback would plug in)", async () => {
    const throwing = () => Promise.reject(new Error("blocked"));
    try {
      await resolveCountersForEnemy({ id: 112, name: "Viktor" }, "middle", "16.17", {
        fetchImpl: throwing,
        champions: CHAMPIONS,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("fetch-failed");
    }

    const http404 = (async () => new Response("nope", { status: 404 })) as never;
    try {
      await resolveCountersForEnemy({ id: 112, name: "Viktor" }, "middle", "16.17", {
        fetchImpl: http404,
        champions: CHAMPIONS,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as LolalyticsCountersError).code).toBe("fetch-failed");
    }
  });
});
