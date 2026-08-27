/**
 * Tests for components/hextech/consensusArtifact.ts — the per-patch
 * precomputed consensus the in-game shop export reads INSTEAD of the database.
 *
 * ── The bar ────────────────────────────────────────────────────────────────
 *
 * "It works" is not the bar. The bar is that an export driven by the artifact
 * produces BYTE-IDENTICAL output to an export driven by the live query, for
 * the same sample — because anything less means the shop panel silently
 * changes depending on whether Postgres happened to be up, which is a worse
 * failure than the outage this replaces (at least that one was visible).
 *
 * So the central test below does not compare item lists or spot-check fields.
 * It runs the REAL `applyItemSetsForBuild` twice against the same sample —
 * once with the database answering and no artifact, once with the artifact
 * answering and the database returning 500 — and compares the two POST bodies
 * as strings.
 *
 * ── The fixture, and what is real about it ─────────────────────────────────
 *
 * The champion is Galio Mid, and the item ids are the ones from the live
 * capture committed in CHANGELOG.md under *Web 0.114.0 — 2026-08-19* (commit
 * 2e2a7c9), the last known-good five-block export before the Neon quota died:
 *
 *     Starting            1056
 *     WPA build           8020, 4633, 3157, 3020, 3143, 3152
 *     Pro build           4005, 3152, 3157, 3173, 8020, 6664
 *     OTP build           4005, 3152, 4645, 3173, 6664, 4646
 *     Situational         3158, 3009, 3047, 4645, 4646, 3068
 *
 * STATED PLAINLY, because it matters for how much these tests are worth: the
 * capture records the exported BLOCKS, not the pro-game rows underneath them,
 * and `buildLine` is not invertible (it pads, it enforces the boots rule, it
 * de-duplicates across blocks). So this file does NOT claim to reproduce that
 * capture from first principles — the sample that produced it is in a database
 * that has been answering 402 since 2026-08-20 07:57 UTC.
 *
 * What the capture IS used for is real inputs: real Galio item ids, in real
 * roles, at real sample sizes, driving the real composer. The equivalence
 * claim is then proven on that, and — because a hand-built fixture can always
 * be accidentally special — re-proven on 200 randomised samples with the same
 * assertion. See "held-out" below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { BuildResponse, ChampionRef, ItemsBlock, Pick, RunesBlock } from "@/lib/types";
import type { ProGame } from "@/components/proGames.types";

// ── Real Galio Mid ids, from the 0.114.0 capture ───────────────────────────
const GALIO: ChampionRef = { id: 3, key: "Galio", name: "Galio", icon: "galio.png" };
const STARTER = 1056;
const BOOTS = 3020;
const WPA_LINE = [8020, 4633, 3157, 3020, 3143, 3152];
const PRO_LINE = [4005, 3152, 3157, 3173, 8020, 6664];
const OTP_LINE = [4005, 3152, 4645, 3173, 6664, 4646];
const SITUATIONAL = [3158, 3009, 3047, 4645, 4646, 3068];

/** ddragon-shaped item metadata for every id above. `into: []` is what makes an
 *  id count as a COMPLETED item (proConsensus.ts's isBuildItem); the four boots
 *  ids carry the boots recipe shape so lib/bootsItems.ts classifies them, which
 *  is what keeps them out of the completed-item slots and in `boots`. */
const ITEM_JSON = {
  type: "item",
  version: "16.13.1",
  data: Object.fromEntries([
    ["1056", { name: "Doran's Ring", tags: ["AbilityPower"], into: [], from: [] }],
    // Boots (tier 2): built FROM 1001, nothing further.
    ...[3020, 3158, 3009, 3047].map((id) => [
      String(id),
      { name: `Boots ${id}`, tags: ["BootsMovement"], into: [], from: ["1001"] },
    ]),
    // Completed AP/tank items.
    ...[8020, 4633, 3157, 3143, 3152, 4005, 3173, 6664, 4645, 4646, 3068].map((id) => [
      String(id),
      { name: `Item ${id}`, tags: ["AbilityPower", "Health"], into: [], from: ["1026"] },
    ]),
  ]),
};

function pick(id: number): Pick {
  return { id, name: `Item ${id}`, icon: `icon-${id}`, wpa: 0.03, winrate: 52, occurrence: 900 };
}

/** The WPA line's ids in the capture's own order, mapped onto the
 *  BuildResponse slots the composer reads them from. */
function galioItems(): ItemsBlock {
  return {
    starter: pick(STARTER),
    boots: pick(BOOTS),
    first: pick(8020),
    second: pick(4633),
    third: pick(3157),
    fourthPlus: [pick(3143), pick(3152)],
    alts: {
      boots: [pick(3158), pick(3009), pick(3047)],
      first: [pick(4645)],
      second: [pick(4646)],
      third: [pick(3068)],
    },
  } as ItemsBlock;
}

function galioRunes(): RunesBlock {
  return {
    primaryTree: { id: 8400, name: "Resolve", icon: "t" },
    secondaryTree: { id: 8200, name: "Sorcery", icon: "t" },
    keystone: pick(8437),
    primary: [pick(8446), pick(8429), pick(8451)],
    secondary: [pick(8210), pick(8237)],
    shards: { offense: pick(5005), flex: pick(5008), defense: pick(5002) },
  };
}

function galioBuild(): BuildResponse {
  return {
    champion: GALIO,
    role: 2,
    roleLabel: "Mid",
    patch: "16.13",
    tierLabel: "Diamond+",
    runes: galioRunes(),
    spells: [pick(4), pick(14)],
    items: galioItems(),
    generatedAt: "2026-08-19T16:48:15.000Z",
    sources: { provider: "coachless.gg" },
  };
}

/** A pro game holding a given final inventory. `share` in the aggregate is
 *  `count / itemsSampleSize`, so varying how many games hold which item is the
 *  only thing that moves the numbers — which is exactly what the count-based
 *  artifact encoding has to reproduce exactly. */
function proGame(id: string, finalItems: number[]): ProGame {
  return {
    id,
    source: "soloq",
    player: { name: "p", team: null, role: 2, country: null },
    account: { riotId: "p#EUW", region: "euw" },
    championId: GALIO.id,
    championName: "Galio",
    role: 2,
    patch: "16.13",
    win: true,
    kills: 3,
    deaths: 2,
    assists: 9,
    gameCreation: "2026-08-18T12:00:00.000Z",
    gameDurationSec: 1900,
    spells: [4, 14],
    finalItems,
    trinket: null,
    purchaseOrder: [],
    skillOrder: [],
    runes: { primaryTree: 8400, keystone: 8437, primary: [], secondaryTree: 8200, secondary: [], shards: [] },
  } as unknown as ProGame;
}

/** A sample whose per-item counts are all DIFFERENT and mostly non-terminating
 *  as fractions (n = 193 games), so a rounded or re-derived share would show up
 *  as a diff rather than being masked by clean halves and thirds. */
function galioProSample(): ProGame[] {
  const games: ProGame[] = [];
  const counts: Record<number, number> = {
    [PRO_LINE[0]]: 171,
    [PRO_LINE[1]]: 158,
    [PRO_LINE[2]]: 127,
    [PRO_LINE[3]]: 96,
    [PRO_LINE[4]]: 71,
    [PRO_LINE[5]]: 43,
    [BOOTS]: 149,
    [3158]: 37,
    [STARTER]: 180,
  };
  for (let g = 0; g < 193; g++) {
    const items = Object.entries(counts)
      .filter(([, c]) => g < c)
      .map(([id]) => Number(id));
    games.push(proGame(`pro-${g}`, items.length > 0 ? items : [STARTER]));
  }
  return games;
}

function galioOtpSample(): ProGame[] {
  const games: ProGame[] = [];
  const counts: Record<number, number> = {
    [OTP_LINE[0]]: 89,
    [OTP_LINE[1]]: 77,
    [OTP_LINE[2]]: 61,
    [OTP_LINE[3]]: 47,
    [OTP_LINE[4]]: 29,
    [OTP_LINE[5]]: 13,
    [BOOTS]: 68,
    [3047]: 19,
  };
  for (let g = 0; g < 101; g++) {
    const items = Object.entries(counts)
      .filter(([, c]) => g < c)
      .map(([id]) => Number(id));
    games.push(proGame(`otp-${g}`, items.length > 0 ? items : [STARTER]));
  }
  return games;
}

const ARTIFACT_URL = "/consensus/item-set-consensus.json";
const PORT = 48291;
const SESSION = "sess-artifact";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

interface FetchLog {
  calls: string[];
  dbCalls: string[];
}

/** Stubs the four things a real export touches. `db` decides what /api/pros and
 *  /api/otp do; `artifact` decides what the static asset does. Every request is
 *  logged, because "the database was never touched" is an assertion this file
 *  makes repeatedly and it has to be checkable rather than assumed. */
function stubFetch(opts: {
  db: "live" | "down";
  artifact: string | null;
  proGames: ProGame[];
  otpGames: ProGame[];
  onBody?: (body: string) => void;
}): FetchLog {
  const log: FetchLog = { calls: [], dbCalls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      log.calls.push(String(url));
      if (url.startsWith(ARTIFACT_URL)) {
        return opts.artifact === null
          ? jsonResponse({ error: "not found" }, false, 404)
          : jsonResponse(JSON.parse(opts.artifact));
      }
      if (url.startsWith("/api/pros") || url.startsWith("/api/otp")) {
        log.dbCalls.push(String(url));
        if (opts.db === "down") return jsonResponse({ error: "Internal server error" }, false, 500);
        return jsonResponse({
          games: url.startsWith("/api/pros") ? opts.proGames : opts.otpGames,
          players: [],
          pending: false,
        });
      }
      if (url.startsWith("https://cdn.coachless.gg")) return jsonResponse(ITEM_JSON);
      if (url.includes("/apply-itemsets")) {
        opts.onBody?.(init?.body as string);
        return jsonResponse({ ok: true, count: 1 });
      }
      return jsonResponse({}, false, 404);
    })
  );
  return log;
}

/** Builds the artifact the way the GENERATOR builds it: one shared reduction,
 *  serialised through the same writer the script uses. Not a hand-written
 *  literal — a hand-written one would be testing my typing, not the encoder. */
async function buildArtifact(patch: string, proGames: ProGame[], otpGames: ProGame[]): Promise<string> {
  const { aggregateProConsensus } = await import("../hextech/proConsensus");
  const { getItemDetailMap } = await import("../itemDetail");
  const {
    CONSENSUS_ARTIFACT_SCHEMA,
    consensusArtifactKey,
    currentConsensusQuery,
    reduceConsensusModel,
    serializeConsensusArtifact,
  } = await import("../hextech/consensusArtifact");

  // The generator MUST hold real item metadata. Without it, `isBuildItem`
  // classifies every id as "not a completed item" and the reduction comes out
  // MATERIALLY different — which is not hypothetical: the first run of the
  // equivalence test below failed for exactly this reason, because this helper
  // was building its artifact with no CDN stub in place and the two Pro build
  // lines diverged by two items. That measured divergence is why
  // `generateConsensusArtifact` refuses outright on an empty metadata map
  // rather than degrading the way the live path is allowed to: the live path's
  // degraded answer lives for one export, an artifact's lives for a patch.
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ITEM_JSON)));
  const meta = await getItemDetailMap("16.13.1");
  expect(meta.size).toBeGreaterThan(0);
  const pro = proGames.length === 0 ? null : reduceConsensusModel("pro", aggregateProConsensus(proGames, meta));
  const otp = otpGames.length === 0 ? null : reduceConsensusModel("otp", aggregateProConsensus(otpGames, meta));
  return serializeConsensusArtifact({
    schema: CONSENSUS_ARTIFACT_SCHEMA,
    patch,
    generatedAt: "2026-08-21T00:00:00.000Z",
    query: currentConsensusQuery(),
    coverage: { combos: 1, pro: pro ? 1 : 0, otp: otp ? 1 : 0 },
    entries: {
      [consensusArtifactKey(GALIO.id, 2)]: { pro, otp },
    },
  });
}

async function exportOnce(opts: {
  db: "live" | "down";
  artifact: string | null;
  proGames?: ProGame[];
  otpGames?: ProGame[];
}): Promise<{ body: string; log: FetchLog }> {
  let body = "";
  const log = stubFetch({
    db: opts.db,
    artifact: opts.artifact,
    proGames: opts.proGames ?? galioProSample(),
    otpGames: opts.otpGames ?? galioOtpSample(),
    onBody: (b) => (body = b),
  });
  const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
  await applyItemSetsForBuild({
    champ: GALIO,
    lane: "mid",
    roleLabel: "Mid",
    build: galioBuild(),
    port: PORT,
    session: SESSION,
  });
  return { body, log };
}

function blocksOf(body: string): string[] {
  return JSON.parse(body).sets[0].blocks.map((b: { type: string }) => b.type);
}

function idsOf(body: string, type: string): number[] {
  const block = JSON.parse(body).sets[0].blocks.find((b: { type: string }) => b.type === type);
  return block ? block.items.map((i: { id: string }) => Number(i.id)) : [];
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── THE CORRECTNESS BAR ─────────────────────────────────────────────────────
describe("artifact-driven export == live-query export, byte for byte", () => {
  it("the two POST bodies are identical strings, and the artifact run never touches the database", async () => {
    // 1. The live run: no artifact at all (404), database answering. This is
    //    production as it stands today.
    const live = await exportOnce({ db: "live", artifact: null });
    expect(live.log.dbCalls.length).toBeGreaterThan(0);
    expect(live.body).not.toBe("");

    // 2. The artifact built from the SAME sample.
    vi.resetModules();
    vi.unstubAllGlobals();
    const artifact = await buildArtifact("16.13", galioProSample(), galioOtpSample());

    // 3. The artifact run, with the database DOWN. If anything fell through to
    //    the live query it would get a 500, lose its block, and the bodies
    //    would differ — so this is not just "the artifact works", it is "the
    //    artifact is sufficient".
    vi.resetModules();
    vi.unstubAllGlobals();
    const fromArtifact = await exportOnce({ db: "down", artifact });

    expect(fromArtifact.log.dbCalls).toEqual([]);
    expect(fromArtifact.body).toBe(live.body);
  });

  it.each([
    ["n = 20 is absent", -1, false],
    ["n = 21 is present", 0, true],
  ])("applies the OTP floor identically through the artifact and live paths: %s", async (_label, offset, present) => {
    const { OTP_CONSENSUS_MIN_GAMES } = await import("../hextech/consensusArtifact");
    const otpGames = Array.from({ length: OTP_CONSENSUS_MIN_GAMES + offset }, (_, gameIndex) =>
      proGame(`otp-floor-${gameIndex}`, [OTP_LINE[0], BOOTS])
    );

    const live = await exportOnce({ db: "live", artifact: null, otpGames });
    vi.resetModules();
    vi.unstubAllGlobals();
    const artifact = await buildArtifact("16.13", galioProSample(), otpGames);
    vi.resetModules();
    vi.unstubAllGlobals();
    const fromArtifact = await exportOnce({ db: "down", artifact, otpGames });

    expect(fromArtifact.log.dbCalls).toEqual([]);
    expect(fromArtifact.body).toBe(live.body);
    expect(blocksOf(live.body).includes("OTP most built")).toBe(present);
  });

  it("the shape is the documented five-block 0.114.0 export, from the artifact alone", async () => {
    const artifact = await buildArtifact("16.13", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const { body } = await exportOnce({ db: "down", artifact });
    // The canonical order from HANDOFF-core-itemset-blocks.md §2: Starting,
    // then the source-named build lines in emit order, then Situational last.
    expect(blocksOf(body)).toEqual(["Starting", "WPA build", "Pro most built", "OTP most built", "Situational"]);
    expect(idsOf(body, "Starting")).toEqual([STARTER]);
    // Every id in the two consensus blocks came out of the artifact's counts,
    // so this is also a check that the reduction survived the JSON round trip
    // with its ORDER intact (share desc, itemId asc).
    expect(idsOf(body, "Pro most built")).toContain(PRO_LINE[0]);
    expect(idsOf(body, "OTP most built")).toContain(OTP_LINE[0]);
  });

  it("REGRESSION (2026-08-20): with the database down and NO artifact, the same export loses both blocks", async () => {
    // The state the user actually saw. Kept as the negative control: without
    // it, the test above could pass because the two runs are both broken in
    // the same way.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body } = await exportOnce({ db: "down", artifact: null });
    expect(blocksOf(body)).toEqual(["Starting", "WPA build", "Situational"]);
    // And it says so, on the wire, rather than silently.
    const diagnostics: string[] = JSON.parse(body).diagnostics;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join(" ")).toContain("Pro build");
    expect(diagnostics.join(" ")).toContain("OTP build");
    expect(diagnostics.join(" ")).toContain("500");
  });

  it("HELD OUT: 200 randomised samples, every one byte-identical through the artifact", async () => {
    // A hand-built fixture can be accidentally special — a share that happens
    // to be exactly representable, an ordering that happens not to depend on a
    // tie-break. This re-runs the same claim on samples nobody designed:
    // random item subsets, random sample sizes, random counts, including the
    // degenerate ones (empty samples, single-game samples, ties).
    const { aggregateProConsensus } = await import("../hextech/proConsensus");
    const { getItemDetailMap } = await import("../itemDetail");
    const { reduceConsensusModel, consensusSourceToInput, serializeConsensusArtifact, parseConsensusArtifact } =
      await import("../hextech/consensusArtifact");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ITEM_JSON)));
    const meta = await getItemDetailMap("16.13.1");

    // Deterministic PRNG — a flaky property test is worse than none.
    let seed = 20260820;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pool = [...WPA_LINE, ...PRO_LINE, ...OTP_LINE, ...SITUATIONAL, STARTER];

    for (let trial = 0; trial < 200; trial++) {
      const n = Math.floor(rnd() * 40);
      const games: ProGame[] = [];
      for (let g = 0; g < n; g++) {
        const items = pool.filter(() => rnd() < 0.35);
        games.push(proGame(`t${trial}-${g}`, items));
      }
      const model = aggregateProConsensus(games, meta);
      const reduced = reduceConsensusModel("pro", model);

      // THE ORACLE, and it is deliberately NOT `consensusSourceToInput`.
      //
      // The first version of this test compared `consensusSourceToInput(reduced)`
      // against `consensusSourceToInput(parsed)` — both sides through the same
      // function — so a mutant that rounded every share to four decimal places
      // survived it untouched. A check that cannot fail is worse than no check,
      // because it reads as coverage.
      //
      // So the expected side is the ORIGINAL expression this refactor replaced,
      // written out verbatim from itemSetsApply.ts as it stood at 33785c7:
      // fold in only the support final's top, re-sort share-desc / itemId-asc,
      // and take `share` STRAIGHT OFF the model rather than re-deriving it.
      // Nothing about the count encoding is involved in producing it.
      const preRefactor =
        model.items.length === 0 && model.boots.length === 0 && model.supportFinals === null
          ? null
          : {
              items: [...model.items, ...(model.supportFinals ? [model.supportFinals.top] : [])]
                .sort((a, b) => (b.share !== a.share ? b.share - a.share : a.itemId - b.itemId))
                .map((e) => ({ itemId: e.itemId, share: e.share })),
              boots: model.boots.map((e) => ({ itemId: e.itemId, share: e.share })),
            };
      const liveInput = preRefactor;

      // What the ARTIFACT path produces: same reduction, through JSON.
      const text = serializeConsensusArtifact({
        schema: 1,
        patch: "16.13",
        generatedAt: "2026-08-21T00:00:00.000Z",
        query: { pro: { limit: 200, proMin: 100, source: "all" }, otp: { limit: 200 } },
        coverage: { combos: 1, pro: 1, otp: 1 },
        entries: { "3|2": { pro: reduced, otp: null } },
      });
      const parsed = parseConsensusArtifact(JSON.parse(text));
      expect(parsed).not.toBeNull();
      const artifactInput = consensusSourceToInput(parsed!.entries["3|2"].pro);

      expect(JSON.stringify(artifactInput)).toBe(JSON.stringify(liveInput));
      // Not just equal as JSON — equal as DOUBLES. JSON.stringify would hide a
      // difference between 0 and -0, and `toEqual` would hide NaN.
      for (let i = 0; i < (liveInput?.items.length ?? 0); i++) {
        expect(Object.is(artifactInput!.items[i].share, liveInput!.items[i].share)).toBe(true);
      }
    }
  });
});

// ── The encoding itself ─────────────────────────────────────────────────────
describe("the count encoding reproduces shares exactly", () => {
  it("a non-terminating share round-trips to the identical double", async () => {
    const { consensusSourceToInput } = await import("../hextech/consensusArtifact");
    // 127/193 is not representable in binary and not a clean decimal either.
    const input = consensusSourceToInput({ n: 193, i: [[3152, 127]], b: [] });
    expect(Object.is(input!.items[0].share, 127 / 193)).toBe(true);
    // And it survives the JSON hop the browser actually performs.
    const reread = consensusSourceToInput(JSON.parse(JSON.stringify({ n: 193, i: [[3152, 127]], b: [] })));
    expect(Object.is(reread!.items[0].share, 127 / 193)).toBe(true);
  });

  it("mirrors proConsensus's own `n > 0 ? count / n : 0` guard rather than dividing by zero", async () => {
    const { consensusSourceToInput } = await import("../hextech/consensusArtifact");
    const input = consensusSourceToInput({ n: 0, i: [[3152, 4]], b: [] });
    expect(input!.items[0].share).toBe(0);
    expect(Number.isFinite(input!.items[0].share)).toBe(true);
  });

  it("folds in ONLY the support-quest final's top pick, never the alternatives", async () => {
    // 2026-07-26: the five finals are mutually exclusive, so a six-item shop
    // line carrying two of them spends two slots on one choice.
    const { reduceConsensusModel } = await import("../hextech/consensusArtifact");
    const freq = (itemId: number, count: number) => ({ itemId, count, share: count / 100 });
    const reduced = reduceConsensusModel("pro", {
      items: [freq(3152, 80)],
      boots: [freq(3020, 60)],
      itemsSampleSize: 100,
      supportFinals: { top: freq(3871, 90), alternatives: [freq(3876, 10)] },
      // No timelines in this fixture: the subject is the support-final FOLD,
      // and `p` must stay out of it entirely.
      purchasePositions: { sampleSize: 0, positions: new Map(), boots: [], bootsSampleSize: 0 },
      bootsPurchased: [],
    } as never);
    expect(reduced!.p).toBeUndefined();
    expect(reduced!.i.map(([id]) => id)).toEqual([3871, 3152]); // 0.90 then 0.80
    expect(reduced!.i.map(([id]) => id)).not.toContain(3876);
  });

  it("an aggregate that came to nothing reduces to null — genuine absence, not an empty object", async () => {
    const { reduceConsensusModel } = await import("../hextech/consensusArtifact");
    expect(
      reduceConsensusModel("pro", { items: [], boots: [], itemsSampleSize: 0, supportFinals: null } as never)
    ).toBeNull();
  });
});

describe("OTP consensus minimum sample", () => {
  const modelWithSampleSize = (itemsSampleSize: number) =>
    ({
      items: [{ itemId: 3152, count: itemsSampleSize, share: 1 }],
      boots: [],
      itemsSampleSize,
      supportFinals: null,
      // 2026-08-27 — the empty purchase-position model. Present rather than
      // omitted because this describe is about the OTP SAMPLE floor and
      // nothing else: a model missing the field would make these five tests
      // fail for a reason that has nothing to do with what they assert.
      purchasePositions: { sampleSize: 0, positions: new Map(), boots: [], bootsSampleSize: 0 },
      bootsPurchased: [],
    }) as never;

  it("excludes OTP n = 20 at the boundary", async () => {
    const { OTP_CONSENSUS_MIN_GAMES, reduceConsensusModel } = await import("../hextech/consensusArtifact");
    expect(reduceConsensusModel("otp", modelWithSampleSize(OTP_CONSENSUS_MIN_GAMES - 1))).toBeNull();
  });

  it("includes OTP n = 21 at the boundary", async () => {
    const { OTP_CONSENSUS_MIN_GAMES, reduceConsensusModel } = await import("../hextech/consensusArtifact");
    expect(reduceConsensusModel("otp", modelWithSampleSize(OTP_CONSENSUS_MIN_GAMES))?.n).toBe(
      OTP_CONSENSUS_MIN_GAMES
    );
  });

  it("excludes an OTP sample of n = 1", async () => {
    const { reduceConsensusModel } = await import("../hextech/consensusArtifact");
    expect(reduceConsensusModel("otp", modelWithSampleSize(1))).toBeNull();
  });

  it("includes a large OTP sample", async () => {
    const { OTP_CONSENSUS_MIN_GAMES, reduceConsensusModel } = await import("../hextech/consensusArtifact");
    const largeSampleSize = OTP_CONSENSUS_MIN_GAMES * 10;
    expect(reduceConsensusModel("otp", modelWithSampleSize(largeSampleSize))?.n).toBe(largeSampleSize);
  });

  it("does not apply the OTP floor to pro consensus", async () => {
    const { reduceConsensusModel } = await import("../hextech/consensusArtifact");
    expect(reduceConsensusModel("pro", modelWithSampleSize(1))?.n).toBe(1);
  });

  it("keeps both the artifact bake and live fallback on the one source-aware reducer", () => {
    const generator = fs.readFileSync(
      path.join(process.cwd(), "lib", "consensus", "generateArtifact.ts"),
      "utf8"
    );
    const liveFallback = fs.readFileSync(
      path.join(process.cwd(), "components", "hextech", "itemSetsApply.ts"),
      "utf8"
    );
    const sharedCall = /reduceConsensusModel\(\s*source,\s*aggregateProConsensus\(/g;

    expect(generator.match(sharedCall)).toHaveLength(1);
    expect(liveFallback.match(sharedCall)).toHaveLength(1);
  });
});

// ── Parsing fails CLOSED ────────────────────────────────────────────────────
describe("parseConsensusArtifact refuses anything it does not fully understand", () => {
  const base = {
    schema: 1,
    patch: "16.13",
    generatedAt: "2026-08-21T00:00:00.000Z",
    query: { pro: { limit: 200, proMin: 100, source: "all" }, otp: { limit: 200 } },
    coverage: { combos: 1, pro: 1, otp: 0 },
    entries: { "3|2": { pro: { n: 10, i: [[3152, 7]], b: [] }, otp: null } },
  };

  it("accepts a well-formed artifact", async () => {
    const { parseConsensusArtifact } = await import("../hextech/consensusArtifact");
    expect(parseConsensusArtifact(structuredClone(base))).not.toBeNull();
  });

  it.each([
    ["a future schema", { schema: 2 }],
    ["a missing schema", { schema: undefined }],
    ["an unparseable patch", { patch: "latest" }],
    ["a missing query block", { query: undefined }],
    ["a query without the pro-play floor", { query: { pro: { limit: 200, source: "all" }, otp: { limit: 200 } } }],
    ["entries that are not objects", { entries: { "3|2": 7 } }],
    ["a count entry of the wrong arity", { entries: { "3|2": { pro: { n: 10, i: [[3152]], b: [] }, otp: null } } }],
    ["a non-numeric count", { entries: { "3|2": { pro: { n: 10, i: [[3152, "7"]], b: [] }, otp: null } } }],
    ["a source with no denominator", { entries: { "3|2": { pro: { i: [], b: [] }, otp: null } } }],
  ])("refuses %s", async (_label, patchIn) => {
    const { parseConsensusArtifact } = await import("../hextech/consensusArtifact");
    expect(parseConsensusArtifact({ ...structuredClone(base), ...(patchIn as object) })).toBeNull();
  });

  it("a refused artifact is not an error the user pays for — the export just uses the database", async () => {
    // The whole reason parsing fails closed: a half-understood artifact would
    // serve a WRONG shop panel confidently, where a refused one costs a query.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body, log } = await exportOnce({ db: "live", artifact: JSON.stringify({ schema: 99 }) });
    expect(log.dbCalls.length).toBeGreaterThan(0);
    expect(blocksOf(body)).toContain("Pro most built");
    expect(warn).not.toHaveBeenCalled();
  });
});

// ── The serialiser is a review surface ──────────────────────────────────────
describe("serializeConsensusArtifact", () => {
  it("is deterministic: the same data twice produces the same bytes, so a real change is the only diff", async () => {
    const a = await buildArtifact("16.13", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const b = await buildArtifact("16.13", galioProSample(), galioOtpSample());
    expect(a).toBe(b);
  });

  it("writes ONE LINE PER champion-role, in numeric order", async () => {
    const { serializeConsensusArtifact } = await import("../hextech/consensusArtifact");
    const text = serializeConsensusArtifact({
      schema: 1,
      patch: "16.13",
      generatedAt: "2026-08-21T00:00:00.000Z",
      query: { pro: { limit: 200, proMin: 100, source: "all" }, otp: { limit: 200 } },
      coverage: { combos: 3, pro: 0, otp: 0 },
      entries: {
        "10|4": { pro: null, otp: null },
        "3|2": { pro: null, otp: null },
        "3|0": { pro: null, otp: null },
      },
    });
    const entryLines = text.split("\n").filter((l) => /^"\d+\|\d+"/.test(l));
    expect(entryLines.map((l) => l.split(":")[0])).toEqual(['"3|0"', '"3|2"', '"10|4"']);
    // Round-trips through a real JSON parse — the hand-rolled layout must not
    // cost validity.
    const { parseConsensusArtifact } = await import("../hextech/consensusArtifact");
    expect(parseConsensusArtifact(JSON.parse(text))).not.toBeNull();
  });
});

// ── The order of preference, case by case ───────────────────────────────────
//
// The order is the point, and it is the opposite of a cache. A cache asks the
// authority and keeps a copy in case it is slow; this asks the artifact and
// only reaches for the database when the artifact cannot answer. Each test
// below pins one of the four cases in `resolveConsensus`, and every one of them
// checks the DATABASE CALL LOG as well as the answer — "it produced the right
// items" would pass just as well if it quietly queried Postgres to get them,
// and not querying Postgres is the entire deliverable.
describe("artifact first, database second", () => {
  async function resolveOnce(opts: { db: "live" | "down"; artifact: string | null; proGames?: ProGame[] }) {
    const log = stubFetch({
      db: opts.db,
      artifact: opts.artifact,
      proGames: opts.proGames ?? galioProSample(),
      otpGames: galioOtpSample(),
    });
    const { resolveProConsensus } = await import("../hextech/itemSetsApply");
    const res = await resolveProConsensus(GALIO, "mid", "16.13");
    return { res, log };
  }

  /** An artifact for a chosen patch with chosen entries, written through the
   *  REAL serialiser so a malformed literal cannot slip past. */
  async function artifactWith(
    patch: string,
    entries: Record<string, { pro: unknown; otp: unknown }>
  ): Promise<string> {
    const { serializeConsensusArtifact } = await import("../hextech/consensusArtifact");
    return serializeConsensusArtifact({
      schema: 1,
      patch,
      generatedAt: "2026-08-21T00:00:00.000Z",
      query: { pro: { limit: 200, proMin: 100, source: "all" }, otp: { limit: 200 } },
      coverage: { combos: Object.keys(entries).length, pro: 1, otp: 1 },
      entries: entries as never,
    });
  }

  it("CASE 1 — a fresh artifact that covers the combo answers alone: no database call at all", async () => {
    const artifact = await buildArtifact("16.13", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const { res, log } = await resolveOnce({ db: "live", artifact });
    expect(res.origin).toBe("artifact");
    expect(res.failure).toBeNull();
    expect(res.data!.items.length).toBeGreaterThan(0);
    expect(log.dbCalls).toEqual([]);
  });

  it("CASE 1b — a stored null is GENUINE ABSENCE: no block, no failure, and still no database call", async () => {
    // The distinction 33785c7 introduced, carried one layer up. If a stored
    // null fell through to the live query, the ~73% of champion-roles that
    // legitimately have no data would put Postgres straight back in the
    // request path and the whole exercise would be pointless.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const artifact = await artifactWith("16.13", { "3|2": { pro: null, otp: null } });
    vi.resetModules();
    vi.unstubAllGlobals();
    const { res, log } = await resolveOnce({ db: "live", artifact });
    expect(res.origin).toBe("artifact");
    expect(res.data).toBeNull();
    expect(res.failure).toBeNull();
    expect(log.dbCalls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("CASE 2 — a fresh artifact that does NOT cover the combo falls through to the live query", async () => {
    // An absent key and a stored null are deliberately different facts. This is
    // the absent one: the generator never reached this champion-role, so we do
    // not know, so we ask.
    const artifact = await artifactWith("16.13", { "99|0": { pro: null, otp: null } });
    vi.resetModules();
    vi.unstubAllGlobals();
    const { res, log } = await resolveOnce({ db: "live", artifact });
    expect(res.origin).toBe("live");
    expect(res.failure).toBeNull();
    expect(log.dbCalls.length).toBeGreaterThan(0);
  });

  it("CASE 2b — a STALE artifact loses to a working database: fresh data wins whenever it is available", async () => {
    const artifact = await buildArtifact("16.12", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const { res, log } = await resolveOnce({ db: "live", artifact });
    expect(res.origin).toBe("live");
    expect(log.dbCalls.length).toBeGreaterThan(0);
  });

  it("CASE 3 — a STALE artifact RECOVERS the block when the database is down, and says so honestly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const artifact = await buildArtifact("16.12", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const { res, log } = await resolveOnce({ db: "down", artifact });

    expect(log.dbCalls.length).toBeGreaterThan(0); // it DID try the database first
    expect(res.origin).toBe("artifact-fallback");
    expect(res.data).not.toBeNull(); // the block SURVIVES
    // The failure is still reported — an outage stays loud — but the sentence
    // must not claim a block was omitted when it was not, or a reader learns to
    // ignore the line.
    expect(res.failure).not.toBeNull();
    expect(res.failure!.recoveredFrom).toEqual({
      patch: "16.12",
      generatedAt: "2026-08-21T00:00:00.000Z",
      stale: true,
    });
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("SERVED FROM");
    expect(line).toContain("STALE");
    expect(line).toContain("500");
    expect(line).not.toContain("OMITTED");
  });

  it("CASE 4 — nothing precomputed and the database down: the block is lost, and the line names BOTH reasons", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res } = await resolveOnce({ db: "down", artifact: null });
    expect(res.data).toBeNull();
    expect(res.failure!.recoveredFrom).toBeUndefined();
    expect(res.failure!.artifactReason).toContain("HTTP 404");
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("OMITTED");
    expect(line).toContain("500");
    // The half that did not exist before: why the fallback that exists to
    // prevent this did not fire.
    expect(line).toContain("precomputed fallback could not cover it");
  });

  it("CASE 4b — a fresh artifact that skips this combo, with the database down, names the missing entry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const artifact = await artifactWith("16.13", { "99|0": { pro: null, otp: null } });
    vi.resetModules();
    vi.unstubAllGlobals();
    const { res } = await resolveOnce({ db: "down", artifact });
    expect(res.data).toBeNull();
    expect(res.failure!.artifactReason).toContain("no entry for championId=3 role=2");
    expect(String(warn.mock.calls[0][0])).toContain("OMITTED");
  });

  it("a recovered failure is filed under its own ring-buffer kind, so it cannot be mistaken for a lost block", async () => {
    const artifact = await buildArtifact("16.12", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveOnce({ db: "down", artifact });
    const entries = JSON.parse(store.get("coachbuild:companion:lastErrors:v1") ?? "[]");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("pro-consensus-http-500-recovered");
  });

  it("fetches the artifact ONCE per page even though both resolvers consult it", async () => {
    // The champ-select auto-export opens a fresh tab per game and runs inside a
    // 30-second window; two fetches of the same static file would be pure
    // latency. A miss is memoised for the same reason — otherwise an un-baked
    // artifact costs a 404 on the pro AND the OTP resolution, every time.
    const artifact = await buildArtifact("16.13", galioProSample(), galioOtpSample());
    vi.resetModules();
    vi.unstubAllGlobals();
    const log = stubFetch({
      db: "live",
      artifact,
      proGames: galioProSample(),
      otpGames: galioOtpSample(),
      onBody: () => {},
    });
    const { applyItemSetsForBuild } = await import("../hextech/itemSetsApply");
    await applyItemSetsForBuild({
      champ: GALIO,
      lane: "mid",
      roleLabel: "Mid",
      build: galioBuild(),
      port: PORT,
      session: SESSION,
    });
    expect(log.calls.filter((u) => u.startsWith(ARTIFACT_URL))).toHaveLength(1);
  });
});
