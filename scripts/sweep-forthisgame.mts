// ---------------------------------------------------------------------------
// sweep-forthisgame.mts -- the HELD-OUT calibration sweep for the `For this
// game` block (lib/enemyComp/forThisGame.ts).
//
// WHY IT EXISTS. Every fixture in lib/__tests__/enemyComp-forThisGame.test.ts
// is one the author chose while designing the rules, so a green suite shows
// the rules do what was meant, not that what was meant reaches anyone. This
// drives the SHIPPED `resolveForThisGamePlan` and `applyForThisGameLine`
// (imported, never reimplemented) over the whole roster against production
// `/api/build` responses, and answers four questions the fixtures cannot:
//
//   1. REACH. How many champion-roles does `/api/build` cover right now? The
//      block can only exist where a build exists (HANDOFF 2026-08-29 §3: 323 at
//      16.16, 245 at 16.17 on flip day, expected to recover toward the 16.15
//      plateau as games accumulate).
//   2. FIRE RATE. Against a representative set of enemy comps -- the seven
//      scenario triggers plus random five-champion comps the author did not
//      pick -- how often does a plan exist at all?
//   3. SHAPE. When a plan exists, how many item slots did it claim (0/1/2) and
//      did it swap boots?
//   4. HONESTY. How often did `chooseCandidate` fall back to the curated pick
//      (`measured: false`), per channel. This is the number the feature is
//      judged on: a block labelled JUDGMENT that is measured 90% of the time is
//      a different feature from one that is measured 20% of the time.
//
// Usage:
//   npx tsx scripts/sweep-forthisgame.mts [--comps 20] [--concurrency 4]
//                                        [--out FILE] [--refresh]
//
// READ-ONLY against production. No database, no Riot key, no writes except the
// gitignored response cache (scripts/.sweep-forthisgame-cache.json) and the
// optional --out file. Concurrency is capped at 4 and each worker pauses
// between requests; `/api/build` is CDN-cached (s-maxage=21600) so a warm
// combo costs the origin nothing, but a cold one is nine coachless calls and
// ~2s of function time, and 865 of those at once is a self-inflicted outage.
// A second run reads the cache and costs production nothing.
//
// NOT covered by `npx tsc --noEmit` (tsconfig includes `**/*.ts`, not `.mts`).
// Typecheck with a temp tsconfig that lists this file explicitly.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { COMP_RATINGS } from "@/lib/draft/compRatings";
import {
  applyForThisGameLine,
  resolveForThisGamePlan,
  FOR_THIS_GAME_LINE_LEN,
  type ForThisGamePlan,
} from "@/lib/enemyComp/forThisGame";
import { classifyEnemyComp, SCENARIO_PRIORITY, type CompScenario } from "@/lib/enemyComp/scenarios";
import { MERCURYS_TREADS, PLATED_STEELCAPS } from "@/lib/enemyComp/counterItems";
import { roleIdToLane } from "@/components/live/deepLink";
import type { BuildResponse, ItemsBlock } from "@/lib/types";

const BASE = process.env.SWEEP_BASE ?? "https://coachbuild.vercel.app";
const CACHE_FILE = "scripts/.sweep-forthisgame-cache.json";
const SEED = 20260902;

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const COMPS_PER_COMBO = arg("comps", 20);
// Hard cap, not a default: the point of the cap is that a typo cannot become
// a load test against production.
const CONCURRENCY = Math.min(4, Math.max(1, arg("concurrency", 4)));
const PACE_MS = 150;
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const REFRESH = process.argv.includes("--refresh");

/** Deterministic PRNG (mulberry32) so a sweep is reproducible and two runs can
 *  be diffed. A random seed would make every rerun a different experiment. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROSTER = Object.keys(COMP_RATINGS)
  .map(Number)
  .sort((a, b) => a - b);
const ROLES = [0, 1, 2, 3, 4] as const;
const ROLE_NAME = ["Top", "Jungle", "Mid", "Bot", "Support"];

/**
 * The seven scenario triggers, one comp each, plus one that fires nothing.
 * The first five are the comps lib/__tests__/enemyComp-scenarios.test.ts
 * classifies, verbatim; the last three are synthetic and are CLASSIFIED HERE
 * before use (see `scenarioComps` in the report) rather than assumed, so a
 * comp that fails to trigger what its name claims is visible in the output
 * instead of silently measuring the wrong thing.
 */
const SCENARIO_COMPS: Record<string, readonly number[]> = {
  /** Soraka + Aatrox (heal 3 each), Lux, Viktor, Caitlyn. */
  healers: [16, 266, 99, 112, 51],
  /** Karma, Lulu, Janna, Morgana, Renata -- shield 3 across the board. */
  shielders: [43, 117, 40, 25, 888],
  /** Malphite + Ornn (tankiness 3), Zed, Draven, Jhin -- tanks and heavy-ad. */
  tanks: [54, 516, 238, 119, 202],
  /** Thresh, Leona, Ashe, Lissandra (cc 3 each) + Lucian. */
  "heavy-cc": [412, 89, 22, 127, 236],
  /** Lux, Viktor, Ahri, Malphite (all ap) + Jhin. */
  "heavy-ap": [99, 112, 103, 54, 202],
  /** Draven, Jhin, Lucian, Zed (ad) + Lux: four AD, one dissenter. */
  "heavy-ad": [119, 202, 236, 238, 99],
  /** Zed, Talon, Kha'Zix (assassins) + Lux + Caitlyn. */
  assassins: [238, 91, 121, 99, 51],
  /** Five champions with no shared axis -- the negative control. */
  quiet: [51, 202, 99, 112, 24],
};

/** 404 means "this champion is not played in this role", which is a real
 *  answer. Anything else means WE DO NOT KNOW, and collapsing the two into one
 *  bucket would let a rate-limited sweep report a shrinking roster as though
 *  it were a finding about the data (the first enemy-comp sweep did exactly
 *  that). Counted separately, and retried. */
type BuildFetch =
  | { kind: "ok"; patch: string; items: ItemsBlock; fetchedAt: string }
  | { kind: "absent"; fetchedAt: string }
  | { kind: "failed"; detail: string; fetchedAt: string };

type CacheShape = { base: string; entries: Record<string, BuildFetch> };

function loadCache(): CacheShape {
  if (REFRESH || !existsSync(CACHE_FILE)) return { base: BASE, entries: {} };
  const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CacheShape;
  // A cache from another base is a different experiment.
  return parsed.base === BASE ? parsed : { base: BASE, entries: {} };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBuild(champ: number, role: number, attempt = 0): Promise<BuildFetch> {
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(`${BASE}/api/build?champ=${champ}&role=${role}`);
    if (res.status === 404) return { kind: "absent", fetchedAt };
    if (!res.ok) {
      if (attempt < 2) {
        await sleep(800 * (attempt + 1));
        return fetchBuild(champ, role, attempt + 1);
      }
      return { kind: "failed", detail: `HTTP ${res.status}`, fetchedAt };
    }
    const arr = (await res.json()) as BuildResponse[];
    const top = arr?.[0];
    if (!top?.items) return { kind: "absent", fetchedAt };
    return { kind: "ok", patch: top.patch, items: top.items, fetchedAt };
  } catch (err) {
    if (attempt < 2) {
      await sleep(800 * (attempt + 1));
      return fetchBuild(champ, role, attempt + 1);
    }
    return { kind: "failed", detail: err instanceof Error ? err.message : String(err), fetchedAt };
  }
}

async function mapPool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= xs.length) return;
        out[idx] = await f(xs[idx]);
      }
    })
  );
  return out;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

/** The spine every other build line in the set is built to: the champion's
 *  own WPA order with boots where the model put them. Mirrors what
 *  itemSetBody.ts's `buildLine` produces (and what the unit test uses). */
function spineOf(items: ItemsBlock): number[] {
  return [
    items.first.id,
    items.boots.id,
    items.second.id,
    items.third.id,
    ...items.fourthPlus.map((p) => p.id),
  ].slice(0, FOR_THIS_GAME_LINE_LEN);
}

function bootsIdsOf(items: ItemsBlock): Set<number> {
  return new Set<number>([
    items.boots.id,
    ...(items.alts?.boots ?? []).map((p) => p.id),
    MERCURYS_TREADS,
    PLATED_STEELCAPS,
  ]);
}

interface Tally {
  trials: number;
  plans: number;
  itemSwaps: [number, number, number]; // plans with 0 / 1 / 2 item picks
  bootsSwaps: number;
  bootsMeasured: number;
  bootsJudgment: number;
  itemMeasured: number;
  itemJudgment: number;
  byScenario: Record<CompScenario, { fired: number; claimedItem: number; claimedBoots: number; judgment: number }>;
  lineViolations: number;
}

function newTally(): Tally {
  const byScenario = Object.fromEntries(
    SCENARIO_PRIORITY.map((s) => [s, { fired: 0, claimedItem: 0, claimedBoots: 0, judgment: 0 }])
  ) as Tally["byScenario"];
  return {
    trials: 0,
    plans: 0,
    itemSwaps: [0, 0, 0],
    bootsSwaps: 0,
    bootsMeasured: 0,
    bootsJudgment: 0,
    itemMeasured: 0,
    itemJudgment: 0,
    byScenario,
    lineViolations: 0,
  };
}

function record(t: Tally, plan: ForThisGamePlan | null, items: ItemsBlock): void {
  t.trials++;
  if (!plan) return;
  t.plans++;
  t.itemSwaps[Math.min(plan.items.length, 2)]++;
  for (const s of plan.scenarios) t.byScenario[s].fired++;
  if (plan.boots) {
    t.bootsSwaps++;
    if (plan.boots.measured) t.bootsMeasured++;
    else {
      t.bootsJudgment++;
      t.byScenario[plan.boots.scenario].judgment++;
    }
    t.byScenario[plan.boots.scenario].claimedBoots++;
  }
  for (const p of plan.items) {
    if (p.measured) t.itemMeasured++;
    else {
      t.itemJudgment++;
      t.byScenario[p.scenario].judgment++;
    }
    t.byScenario[p.scenario].claimedItem++;
  }
  // Free structural check on the LINE, driven through the shipped function:
  // exactly one boots, no duplicates, never longer than the spine.
  const spine = spineOf(items);
  const bootsIds = bootsIdsOf(items);
  const line = applyForThisGameLine(spine, plan, bootsIds);
  const boots = line.ids.filter((id) => bootsIds.has(id)).length;
  const dupes = new Set(line.ids).size !== line.ids.length;
  if (boots !== 1 || dupes || line.ids.length > Math.min(FOR_THIS_GAME_LINE_LEN, spine.length)) {
    t.lineViolations++;
  }
}

function summarize(t: Tally) {
  const bootsTotal = t.bootsMeasured + t.bootsJudgment;
  const itemTotal = t.itemMeasured + t.itemJudgment;
  return {
    trials: t.trials,
    plans: t.plans,
    planRate: pct(t.plans, t.trials),
    itemSwapDistribution: {
      "0": t.itemSwaps[0],
      "1": t.itemSwaps[1],
      "2": t.itemSwaps[2],
      "0pct": pct(t.itemSwaps[0], t.plans),
      "1pct": pct(t.itemSwaps[1], t.plans),
      "2pct": pct(t.itemSwaps[2], t.plans),
    },
    bootsSwaps: t.bootsSwaps,
    bootsSwapRate: pct(t.bootsSwaps, t.plans),
    honesty: {
      boots: { measured: t.bootsMeasured, judgment: t.bootsJudgment, judgmentPct: pct(t.bootsJudgment, bootsTotal) },
      item: { measured: t.itemMeasured, judgment: t.itemJudgment, judgmentPct: pct(t.itemJudgment, itemTotal) },
      all: {
        measured: t.bootsMeasured + t.itemMeasured,
        judgment: t.bootsJudgment + t.itemJudgment,
        judgmentPct: pct(t.bootsJudgment + t.itemJudgment, bootsTotal + itemTotal),
      },
    },
    byScenario: t.byScenario,
    lineViolations: t.lineViolations,
  };
}

async function main() {
  const cache = loadCache();
  const combos = ROSTER.flatMap((champ) => ROLES.map((role) => ({ champ, role })));
  const missing = combos.filter((c) => !cache.entries[`${c.champ}:${c.role}`]);
  process.stderr.write(
    `${combos.length} champion-roles; ${combos.length - missing.length} cached, fetching ${missing.length} from ${BASE} at concurrency ${CONCURRENCY}\n`
  );

  let done = 0;
  await mapPool(missing, CONCURRENCY, async (c) => {
    const r = await fetchBuild(c.champ, c.role);
    cache.entries[`${c.champ}:${c.role}`] = r;
    if (++done % 50 === 0 || done === missing.length) {
      process.stderr.write(`  ${done}/${missing.length}\n`);
      writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
    await sleep(PACE_MS);
  });
  if (missing.length > 0) writeFileSync(CACHE_FILE, JSON.stringify(cache));

  const builds = combos.map((c) => ({ ...c, r: cache.entries[`${c.champ}:${c.role}`] }));
  const failed = builds.filter((b) => b.r.kind === "failed");
  const absent = builds.filter((b) => b.r.kind === "absent");
  const withData = builds.filter((b) => b.r.kind === "ok") as Array<{
    champ: number;
    role: number;
    r: Extract<BuildFetch, { kind: "ok" }>;
  }>;
  if (failed.length > 0) {
    process.stderr.write(
      `WARNING: ${failed.length} combos could not be resolved (e.g. ` +
        failed
          .slice(0, 3)
          .map((f) => `${f.champ}/${f.role} ${(f.r as { detail: string }).detail}`)
          .join(", ") +
        `). Those are UNKNOWN, not absent. Re-run to retry them.\n`
    );
  }

  // -- Q1: reach -------------------------------------------------------------
  const patches: Record<string, number> = {};
  for (const b of withData) patches[b.r.patch] = (patches[b.r.patch] ?? 0) + 1;
  const perRole = ROLES.map((role) => ({
    role: ROLE_NAME[role],
    withData: withData.filter((b) => b.role === role).length,
    absent: absent.filter((b) => b.role === role).length,
    failed: failed.filter((b) => b.role === role).length,
  }));
  const fetchedAts = builds.map((b) => b.r.fetchedAt).sort();

  // -- The scenario comps, classified rather than assumed ----------------------
  const scenarioComps = Object.fromEntries(
    Object.entries(SCENARIO_COMPS).map(([name, ids]) => {
      const c = classifyEnemyComp(ids);
      return [name, { ids, scenarios: c ? c.scenarios : null, damageLean: c?.evidence.damageLean ?? null }];
    })
  );

  // -- Q2..Q4 over the scenario comps ------------------------------------------
  const scenarioTally = newTally();
  const perScenarioComp: Record<string, ReturnType<typeof summarize>> = {};
  for (const [name, ids] of Object.entries(SCENARIO_COMPS)) {
    const t = newTally();
    for (const b of withData) {
      const plan = resolveForThisGamePlan({
        enemyChampionIds: ids,
        championId: b.champ,
        lane: roleIdToLane(b.role as 0 | 1 | 2 | 3 | 4),
        items: b.r.items,
      });
      record(t, plan, b.r.items);
      record(scenarioTally, plan, b.r.items);
    }
    perScenarioComp[name] = summarize(t);
  }

  // -- Q2..Q4 over random comps the author did not choose ----------------------
  // Uniform over the roster, five distinct champions. Uniform is deliberately
  // NOT the real champ-select distribution; it is the held-out one, chosen so
  // the sweep cannot inherit the author's assumptions about which comps matter.
  const rand = rng(SEED);
  const randomTally = newTally();
  let combosThatEverPlan = 0;
  let combosThatAlwaysPlan = 0;
  const perLane = ROLES.map(() => newTally());
  for (const b of withData) {
    let plans = 0;
    for (let t = 0; t < COMPS_PER_COMBO; t++) {
      const picked = new Set<number>();
      while (picked.size < 5) picked.add(ROSTER[Math.floor(rand() * ROSTER.length)]);
      const plan = resolveForThisGamePlan({
        enemyChampionIds: [...picked],
        championId: b.champ,
        lane: roleIdToLane(b.role as 0 | 1 | 2 | 3 | 4),
        items: b.r.items,
      });
      if (plan) plans++;
      record(randomTally, plan, b.r.items);
      record(perLane[b.role], plan, b.r.items);
    }
    if (plans > 0) combosThatEverPlan++;
    if (plans === COMPS_PER_COMBO) combosThatAlwaysPlan++;
  }

  const report = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    responsesFetchedBetween: [fetchedAts[0], fetchedAts[fetchedAts.length - 1]],
    seed: SEED,
    compsPerCombo: COMPS_PER_COMBO,
    reach: {
      combosRequested: combos.length,
      combosWithData: withData.length,
      combosWithDataPct: pct(withData.length, combos.length),
      combosNotPlayedInRole: absent.length,
      combosUnresolved: failed.length,
      patches,
      perRole,
    },
    scenarioComps,
    scenarioSweep: { all: summarize(scenarioTally), perComp: perScenarioComp },
    randomSweep: {
      ...summarize(randomTally),
      combosThatEverPlan,
      combosThatEverPlanPct: pct(combosThatEverPlan, withData.length),
      combosThatAlwaysPlan,
      combosThatAlwaysPlanPct: pct(combosThatAlwaysPlan, withData.length),
      perLane: Object.fromEntries(ROLES.map((r) => [ROLE_NAME[r], summarize(perLane[r])])),
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
    process.stderr.write(`wrote ${OUT}\n`);
  }
}

await main();
