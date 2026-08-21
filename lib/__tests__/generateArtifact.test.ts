/**
 * Tests for lib/consensus/generateArtifact.ts — the generation core behind
 * scripts/generate-consensus-artifact.mts.
 *
 * ── Why this is a library with tests instead of a script ───────────────────
 *
 * The file this generator writes is trusted absolutely by the in-game shop
 * export: an entry stored as `null` means "the generator asked, and this
 * champion-role genuinely has no pro data", and the export omits the block
 * WITHOUT falling back to a live query. So the difference between "no data"
 * and "the request failed" — the exact distinction whose absence caused the
 * 2026-08-20 nine-hour silent outage — has to be maintained one layer further
 * up, at generation time, where getting it wrong suppresses a block for a whole
 * patch instead of for one export.
 *
 * That rule is what these tests are for. They cannot be written against a
 * `.mts` entry point that parses argv and calls process.exit.
 *
 * ── The other thing being pinned ──────────────────────────────────────────
 *
 * That the generator draws THE SAME SAMPLE the live export draws. v0.70.0 fixed
 * the Pro Consensus card to limit=200&proMin=100 and left the export path on
 * limit=100 with no pro-play floor, and the "Pro build" line users got in their
 * shop stayed ~96% solo queue for weeks. A generator with a third copy of those
 * parameters would reproduce that bug into a committed file. The URL assertions
 * below are the guard.
 */
import { describe, it, expect, vi } from "vitest";
import type { ChampionRef } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";
import type { ProGame } from "@/components/proGames.types";
import {
  generateConsensusArtifact,
  resolveArtifactPatch,
  ARTIFACT_ROLES,
  type GenerateDeps,
} from "@/lib/consensus/generateArtifact";

const CHAMPS: ChampionRef[] = [
  { id: 3, key: "Galio", name: "Galio", icon: "g.png" },
  { id: 134, key: "Syndra", name: "Syndra", icon: "s.png" },
];

/** Enough metadata for the two ids the fixtures build with — 3152 completes
 *  (`into: []`), 3020 is boots. `isBuildItem` treats an id with NO metadata as
 *  "not a completed item", so an under-populated map here would silently empty
 *  every aggregate; see the `size === 0` refusal test below. */
const META = new Map<number, ItemDetail>([
  [3152, { id: 3152, name: "Hextech Rocketbelt", goldTotal: 2600, descriptionText: "", into: [], from: ["1026"], tags: ["AbilityPower"], purchasable: true }],
  [3020, { id: 3020, name: "Sorcerer's Shoes", goldTotal: 1100, descriptionText: "", into: [], from: ["1001"], tags: ["BootsMovement"], purchasable: true }],
]);

function game(id: string, championId: number, role: number, finalItems: number[]): ProGame {
  return {
    id,
    source: "soloq",
    player: { name: "p", team: null, role, country: null },
    account: { riotId: "p#EUW", region: "euw" },
    championId,
    championName: "x",
    role,
    patch: "16.13",
    win: true,
    kills: 1,
    deaths: 1,
    assists: 1,
    gameCreation: "2026-08-18T12:00:00.000Z",
    gameDurationSec: 1800,
    spells: [4, 14],
    finalItems,
    trinket: null,
    purchaseOrder: [],
    skillOrder: [],
    runes: { primaryTree: 8400, keystone: 8437, primary: [], secondaryTree: 8200, secondary: [], shards: [] },
  } as unknown as ProGame;
}

interface HarnessOptions {
  /** Called for every /api/pros or /api/otp URL. Return games, or throw to
   *  model a failed request. */
  sample?: (url: string) => ProGame[];
  meta?: Map<number, ItemDetail>;
  buildPatch?: string | null;
}

function harness(o: HarnessOptions = {}): { deps: GenerateDeps; urls: string[] } {
  const urls: string[] = [];
  const deps: GenerateDeps = {
    fetchJson: (async (url: string) => {
      urls.push(url);
      if (url.includes("/api/build")) {
        if (o.buildPatch === null) throw new Error("HTTP 404");
        return { patch: o.buildPatch ?? "16.13" };
      }
      return { games: o.sample ? o.sample(url) : [], players: [], pending: false };
    }) as GenerateDeps["fetchJson"],
    listChampions: async () => CHAMPS,
    loadItemMeta: async () => o.meta ?? META,
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  };
  return { deps, urls };
}

describe("generateConsensusArtifact — what it refuses to write", () => {
  it("THE RULE: a combo whose request FAILED is omitted entirely, never stored as null", async () => {
    // This is the whole file in one test. A stored `null` is read by the export
    // as "genuinely no data, omit the block and do not ask the database"; an
    // ABSENT key is read as "not covered, go and ask". So a failed request must
    // produce absence, because absence is recoverable and a wrong null is not.
    const { deps } = harness({
      sample: (url) => {
        if (url.includes("championId=134") && url.includes("role=2")) throw new Error("HTTP 500");
        return [game("g", 3, 0, [3152, 3152])];
      },
    });
    const report = await generateConsensusArtifact({ base: "http://x", minCoverage: 0 }, deps);

    expect(report.artifact.entries["134|2"]).toBeUndefined();
    expect(Object.keys(report.artifact.entries)).not.toContain("134|2");
    expect(report.failures.some((f) => f.includes("134|2"))).toBe(true);
    // Every OTHER combo still landed — one bad champion-role does not poison
    // the run.
    expect(report.artifact.entries["134|0"]).toBeDefined();
    expect(report.artifact.entries["3|2"]).toBeDefined();
  });

  it("PARTIAL SUCCESS IS FAILURE: pro resolving and otp failing drops the whole combo", async () => {
    // Keeping the pro half and writing `otp: null` would publish "this champion
    // has no one-tricks" as a fact the export believes without checking.
    const { deps } = harness({
      sample: (url) => {
        if (url.includes("/api/otp") && url.includes("championId=3&role=1")) throw new Error("HTTP 500");
        return [game("g", 3, 1, [3152])];
      },
    });
    const report = await generateConsensusArtifact({ base: "http://x", minCoverage: 0 }, deps);
    expect(report.artifact.entries["3|1"]).toBeUndefined();
  });

  it("THE OTHER HALF: a genuinely empty sample IS written, as an explicit null", async () => {
    // Absence has to be recordable, or the artifact would fall through to the
    // database for the ~73% of champion-roles that legitimately have nothing —
    // which is most of them, and would put Postgres straight back in the
    // request path.
    const { deps } = harness({ sample: () => [] });
    const report = await generateConsensusArtifact({ base: "http://x" }, deps);
    expect(report.artifact.entries["3|2"]).toEqual({ pro: null, otp: null });
    expect(report.failures).toEqual([]);
    expect(report.artifact.coverage.pro).toBe(0);
  });

  it("refuses the whole run below --min-coverage rather than publishing a thin artifact", async () => {
    // A thin artifact suppresses blocks for a whole patch cycle. The previous
    // artifact, or the live query, is a better answer than a bad one.
    const { deps } = harness({
      sample: (url) => {
        if (url.includes("role=0")) return [game("g", 3, 0, [3152])];
        throw new Error("HTTP 500");
      },
    });
    await expect(generateConsensusArtifact({ base: "http://x", minCoverage: 0.95 }, deps)).rejects.toThrow(
      /below the 95.0% floor/
    );
  });

  it("refuses outright when item metadata is empty", async () => {
    // Measured, not theoretical: the equivalence test in
    // components/__tests__/consensusArtifact.test.ts first FAILED because its
    // artifact was built with an empty metadata map, and the two Pro build
    // lines came out two items apart. `isBuildItem` treats an unknown id as
    // "not a completed item", so an empty map reduces every sample to nothing
    // and every entry to `null` — a patch-long outage, baked into a file.
    const { deps } = harness({ meta: new Map() });
    await expect(generateConsensusArtifact({ base: "http://x" }, deps)).rejects.toThrow(/came back EMPTY/);
  });

  it("refuses when the champion filter matches nothing, instead of writing an empty artifact", async () => {
    const { deps } = harness();
    await expect(
      generateConsensusArtifact({ base: "http://x", championIds: [99999] }, deps)
    ).rejects.toThrow(/No champions resolved/);
  });
});

describe("generateConsensusArtifact — it draws the SAME sample the export draws", () => {
  it("requests limit=200&proMin=100&source=all for pro and limit=200 for otp", async () => {
    const { deps, urls } = harness({ sample: () => [] });
    await generateConsensusArtifact({ base: "http://x", championIds: [3] }, deps);
    const pros = urls.filter((u) => u.includes("/api/pros"));
    const otps = urls.filter((u) => u.includes("/api/otp"));
    expect(pros).toHaveLength(ARTIFACT_ROLES.length);
    expect(otps).toHaveLength(ARTIFACT_ROLES.length);
    for (const u of pros) {
      expect(u).toContain("limit=200");
      expect(u).toContain("proMin=100");
      expect(u).toContain("source=all");
    }
    for (const u of otps) expect(u).toContain("limit=200");
  });

  it("stamps those same parameters into the artifact, so a reader never has to assume them", async () => {
    const { deps } = harness({ sample: () => [] });
    const report = await generateConsensusArtifact({ base: "http://x", championIds: [3] }, deps);
    expect(report.artifact.query).toEqual({
      pro: { limit: 200, proMin: 100, source: "all" },
      otp: { limit: 200 },
    });
  });

  it("generates the five concrete lanes and never role 5", async () => {
    // Role 5 is "auto", the Builds page's default state. The export always
    // resolves a concrete lane before composing a set (LANE_TO_ROLE_ID), so a
    // role-5 entry could never be looked up — it would only inflate the file.
    const { deps } = harness({ sample: () => [] });
    const report = await generateConsensusArtifact({ base: "http://x", championIds: [3] }, deps);
    expect(Object.keys(report.artifact.entries).sort()).toEqual(["3|0", "3|1", "3|2", "3|3", "3|4"]);
  });
});

describe("resolveArtifactPatch", () => {
  it("reads the label off a REAL /api/build response, not from ddragon", async () => {
    // The freshness comparison at export time is `artifact.patch` against
    // `BuildResponse.patch`. A second, independently-derived definition of "the
    // current patch" would risk a permanent STALE verdict — a fallback that
    // silently never fires, with everything appearing to work.
    const { deps, urls } = harness({ buildPatch: "16.14" });
    expect(await resolveArtifactPatch({ base: "http://x" }, deps, 3)).toBe("16.14");
    expect(urls[0]).toContain("/api/build?champ=3");
  });

  it("normalises a three-segment ddragon version to the two-segment build label", async () => {
    const { deps } = harness({ buildPatch: "16.14.1" });
    expect(await resolveArtifactPatch({ base: "http://x" }, deps, 3)).toBe("16.14");
  });

  it("an explicit patch wins, and an unparseable one is rejected rather than stamped", async () => {
    const { deps } = harness();
    expect(await resolveArtifactPatch({ base: "http://x", patch: "16.9.1" }, deps, 3)).toBe("16.9");
    await expect(resolveArtifactPatch({ base: "http://x", patch: "latest" }, deps, 3)).rejects.toThrow(
      /not a major.minor label/
    );
  });

  it("walks the roles rather than aborting on a champion not played in role 0", async () => {
    let calls = 0;
    const { deps } = harness();
    const wrapped: GenerateDeps = {
      ...deps,
      fetchJson: (async (url: string) => {
        if (url.includes("/api/build")) {
          calls++;
          if (calls < 3) throw new Error("HTTP 404");
          return { patch: "16.13" };
        }
        return { games: [] };
      }) as GenerateDeps["fetchJson"],
    };
    expect(await resolveArtifactPatch({ base: "http://x" }, wrapped, 3)).toBe("16.13");
    expect(calls).toBe(3);
  });

  it("reads the patch off /api/build's ARRAY shape, not just the single object", async () => {
    // The live route returns an array of item sets (situational ships as a
    // second one). This test exists because the object-only mock below stayed
    // green while the real generator could not resolve a patch at all, which
    // blocked the artifact gate during the 2026-08-21 Neon cutover.
    const { deps } = harness();
    const wrapped: GenerateDeps = {
      ...deps,
      fetchJson: (async (url: string) => {
        if (url.includes("/api/build")) return [{ patch: "16.16.1" }, { patch: "16.16.1" }];
        return { games: [] };
      }) as GenerateDeps["fetchJson"],
    };
    expect(await resolveArtifactPatch({ base: "http://x" }, wrapped, 3)).toBe("16.16");
  });

  it("treats an EMPTY array from /api/build as no answer, and walks on", async () => {
    const { deps } = harness();
    let calls = 0;
    const wrapped: GenerateDeps = {
      ...deps,
      fetchJson: (async (url: string) => {
        if (url.includes("/api/build")) {
          calls++;
          return calls < 3 ? [] : [{ patch: "16.14.1" }];
        }
        return { games: [] };
      }) as GenerateDeps["fetchJson"],
    };
    expect(await resolveArtifactPatch({ base: "http://x" }, wrapped, 3)).toBe("16.14");
    expect(calls).toBe(3);
  });

  it("throws rather than guessing when no role answers", async () => {
    const { deps } = harness({ buildPatch: null });
    await expect(resolveArtifactPatch({ base: "http://x" }, deps, 3)).rejects.toThrow(/Could not read a patch label/);
  });
});

describe("generateConsensusArtifact — the report", () => {
  it("counts what actually carried data, not what was attempted", async () => {
    const { deps } = harness({
      sample: (url) => (url.includes("/api/pros") && url.includes("role=2") ? [game("g", 3, 2, [3152])] : []),
    });
    const report = await generateConsensusArtifact({ base: "http://x" }, deps);
    expect(report.attempted).toBe(CHAMPS.length * ARTIFACT_ROLES.length);
    expect(report.resolved).toBe(report.attempted);
    expect(report.coverage).toBe(1);
    expect(report.artifact.coverage.pro).toBe(2); // one per champion, role 2 only
    expect(report.artifact.coverage.otp).toBe(0);
  });

  it("uses the injected clock, so a regenerated artifact with identical data is a reviewable diff", async () => {
    const { deps } = harness({ sample: () => [] });
    const report = await generateConsensusArtifact({ base: "http://x" }, deps);
    expect(report.artifact.generatedAt).toBe("2026-08-21T00:00:00.000Z");
  });

  it("honours the concurrency limit without dropping or duplicating a combo", async () => {
    const seen = new Set<string>();
    const { deps } = harness({
      sample: (url) => {
        const m = /championId=(\d+)&role=(\d+)/.exec(url)!;
        seen.add(`${url.includes("/api/pros") ? "pro" : "otp"}:${m[1]}|${m[2]}`);
        return [];
      },
    });
    const report = await generateConsensusArtifact({ base: "http://x", concurrency: 3 }, deps);
    expect(seen.size).toBe(CHAMPS.length * ARTIFACT_ROLES.length * 2);
    expect(report.resolved).toBe(CHAMPS.length * ARTIFACT_ROLES.length);
  });

  it("reports progress for every combo exactly once", async () => {
    const onProgress = vi.fn();
    const { deps } = harness({ sample: () => [] });
    await generateConsensusArtifact({ base: "http://x" }, { ...deps, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(CHAMPS.length * ARTIFACT_ROLES.length);
  });
});
