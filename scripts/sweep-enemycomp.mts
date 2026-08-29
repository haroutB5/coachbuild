// ---------------------------------------------------------------------------
// sweep-enemycomp.mts -- the HELD-OUT evaluation for the enemy-comp signal.
//
// WHY IT EXISTS. Every fixture in the test suite is one I chose while designing
// the rules, so passing them is circular: it shows the rules do what I meant,
// not that what I meant is any good. This drives the SHIPPED `resolveCompSignal`
// (imported, never reimplemented) over the whole roster against production data
// and random comps I did not pick, and answers three questions the fixtures
// cannot:
//
//   1. Does it fire neither never nor always? A gate that almost never fires is
//      dead code with a green suite; one that almost always fires is a label
//      that means nothing.
//   2. Is MAX_WPA_COST calibrated or arbitrary? The answer is the distribution
//      of the gap between a champion's chosen boots and the counter boot it
//      would swap to, over every champion-role where that swap is even
//      possible. A threshold sitting in a dense part of that distribution is a
//      knob; one sitting in a sparse part is a decision.
//   3. How much of the roster can this reach at all?
//
// Usage:
//   npx tsx scripts/sweep-enemycomp.mts [--comps 20] [--concurrency 12] [--out FILE]
//
// Read-only against production. No database, no Riot key, no writes.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { resolveCompSignal, MAX_WPA_COST } from "../lib/enemyComp/compSignal";
import { MAGIC_RESIST_BOOTS, ARMOR_BOOTS } from "../lib/enemyComp/counterItems";
import { COMP_RATINGS } from "../lib/draft/compRatings";
import { flattenSituational } from "../components/hextech/situational";
import type { BuildResponse, ItemsBlock } from "../lib/types";

const BASE = process.env.SWEEP_BASE ?? "https://coachbuild.vercel.app";
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const COMPS_PER_COMBO = arg("comps", 20);
const CONCURRENCY = arg("concurrency", 12);
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;

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

const ROSTER = Object.keys(COMP_RATINGS).map(Number).sort((a, b) => a - b);
const LANES = [0, 1, 2, 3, 4];
const LANE_NAME = ["Top", "JG", "Mid", "Bot", "Sup"];

/** 404 means "this champion is not played in this role", which is a real
 *  answer. Anything else means WE DO NOT KNOW, and collapsing the two into one
 *  `null` would let a rate-limited sweep report a shrinking roster as though it
 *  were a finding about the data. The first run of this script did exactly
 *  that: 245 of 865 combos "had data" with no way to tell how many of the other
 *  620 were genuine 404s. Counted separately now, and retried, so a run that
 *  hit trouble cannot be read as a measurement. */
type BuildFetch =
  | { kind: "ok"; items: ItemsBlock }
  | { kind: "absent" }
  | { kind: "failed"; detail: string };

async function fetchBuild(champ: number, role: number, attempt = 0): Promise<BuildFetch> {
  try {
    const res = await fetch(`${BASE}/api/build?champ=${champ}&role=${role}`);
    if (res.status === 404) return { kind: "absent" };
    if (!res.ok) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        return fetchBuild(champ, role, attempt + 1);
      }
      return { kind: "failed", detail: `HTTP ${res.status}` };
    }
    const arr = (await res.json()) as BuildResponse[];
    const items = arr?.[0]?.items;
    return items ? { kind: "ok", items } : { kind: "absent" };
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return fetchBuild(champ, role, attempt + 1);
    }
    return { kind: "failed", detail: err instanceof Error ? err.message : String(err) };
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

function pct(n: number, d: number) {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}
function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function main() {
  const combos = ROSTER.flatMap((c) => LANES.map((l) => ({ champ: c, role: l })));
  process.stderr.write(`fetching ${combos.length} champion-roles from ${BASE}\n`);

  let done = 0;
  const builds = await mapPool(combos, CONCURRENCY, async (c) => {
    const r = await fetchBuild(c.champ, c.role);
    if (++done % 100 === 0) process.stderr.write(`  ${done}/${combos.length}
`);
    return { ...c, r };
  });

  const failed = builds.filter((b) => b.r.kind === "failed");
  const absent = builds.filter((b) => b.r.kind === "absent");
  const withData = builds
    .filter((b) => b.r.kind === "ok")
    .map((b) => ({ champ: b.champ, role: b.role, items: (b.r as { kind: "ok"; items: ItemsBlock }).items }));
  if (failed.length > 0) {
    process.stderr.write(
      `WARNING: ${failed.length} combos could not be resolved (e.g. ` +
        failed
          .slice(0, 3)
          .map((f) => `${f.champ}/${f.role} ${(f.r as { kind: "failed"; detail: string }).detail}`)
          .join(", ") +
        `). Those are UNKNOWN, not absent.
`
    );
  }

  // -- Q3: reachability. What fraction of the roster can this touch at all? --
  const reach = { mr: 0, armor: 0, either: 0 };
  /** The calibration set for Q2: the REAL gap between a champion's chosen boots
   *  and the counter boot it would swap to, for every combo where that swap is
   *  possible. This is the distribution MAX_WPA_COST has to sit inside. */
  const gaps: number[] = [];
  for (const b of withData) {
    const pool = flattenSituational(b.items);
    const mr = pool.find((p) => MAGIC_RESIST_BOOTS.has(p.id));
    const ar = pool.find((p) => ARMOR_BOOTS.has(p.id));
    if (mr) reach.mr++;
    if (ar) reach.armor++;
    if (mr || ar) reach.either++;
    for (const hit of [mr, ar]) if (hit) gaps.push(b.items.boots.wpa - hit.wpa);
  }

  // -- Q1: fire rate over comps I did not choose ---------------------------
  const rand = rng(20260829);
  const stats = {
    trials: 0,
    fired: 0,
    byRule: { cc: 0, "damage-ad": 0, "damage-ap": 0 } as Record<string, number>,
    firedCosts: [] as number[],
    combosThatEverFire: 0,
    combosThatAlwaysFire: 0,
    /** Of the fires, how many actually MOVE the promoted item, versus how many
     *  only add the title because it was already at the head of the row.
     *  Without this split, "the signal fired 359 times" reads as 359 reorders
     *  when it may be mostly relabels. Both are legitimate (the label is real
     *  information either way) but they are different features and the report
     *  must not conflate them. */
    firesThatReorder: 0,
    firesThatOnlyRelabel: 0,
  };
  const perCombo: Array<{ label: string; fired: number; of: number }> = [];

  for (const b of withData) {
    let fired = 0;
    for (let t = 0; t < COMPS_PER_COMBO; t++) {
      // A random comp of 3 to 5 distinct champions, uniform over the roster.
      // Uniform is deliberately NOT the real champ-select distribution; it is
      // the held-out one, chosen so the sweep cannot inherit my assumptions
      // about which comps matter.
      const size = 3 + Math.floor(rand() * 3);
      const picked = new Set<number>();
      while (picked.size < size) picked.add(ROSTER[Math.floor(rand() * ROSTER.length)]);
      const signal = resolveCompSignal([...picked], b.items);
      stats.trials++;
      if (signal) {
        fired++;
        stats.fired++;
        stats.byRule[signal.rule]++;
        stats.firedCosts.push(signal.wpaCost);
        const raw = flattenSituational(b.items).map((p) => p.id);
        const moved = raw.findIndex((id) => signal.promotedIds.includes(id)) > 0;
        if (moved) stats.firesThatReorder++;
        else stats.firesThatOnlyRelabel++;
      }
    }
    if (fired > 0) stats.combosThatEverFire++;
    if (fired === COMPS_PER_COMBO) stats.combosThatAlwaysFire++;
    perCombo.push({ label: `${b.champ} ${LANE_NAME[b.role]}`, fired, of: COMPS_PER_COMBO });
  }

  const gapsSorted = [...gaps].sort((a, b) => a - b);
  const costsSorted = [...stats.firedCosts].sort((a, b) => a - b);
  const underThreshold = gapsSorted.filter((g) => g <= MAX_WPA_COST).length;

  const report = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    seed: 20260829,
    compsPerCombo: COMPS_PER_COMBO,
    combosRequested: combos.length,
    combosWithData: withData.length,
    combosNotPlayedInRole: absent.length,
    combosUnresolved: failed.length,
    reachability: {
      magicResistBootAvailable: reach.mr,
      armorBootAvailable: reach.armor,
      eitherAvailable: reach.either,
      eitherPct: pct(reach.either, withData.length),
    },
    fireRate: {
      trials: stats.trials,
      fired: stats.fired,
      pct: pct(stats.fired, stats.trials),
      byRule: stats.byRule,
      combosThatEverFire: stats.combosThatEverFire,
      combosThatEverFirePct: pct(stats.combosThatEverFire, withData.length),
      combosThatAlwaysFire: stats.combosThatAlwaysFire,
      combosThatAlwaysFirePct: pct(stats.combosThatAlwaysFire, withData.length),
      firesThatReorder: stats.firesThatReorder,
      firesThatReorderPct: pct(stats.firesThatReorder, stats.fired),
      firesThatOnlyRelabel: stats.firesThatOnlyRelabel,
      firesThatOnlyRelabelPct: pct(stats.firesThatOnlyRelabel, stats.fired),
    },
    maxWpaCost: MAX_WPA_COST,
    swapGapDistribution: {
      n: gapsSorted.length,
      min: gapsSorted[0],
      p10: quantile(gapsSorted, 0.1),
      p25: quantile(gapsSorted, 0.25),
      median: quantile(gapsSorted, 0.5),
      p75: quantile(gapsSorted, 0.75),
      p90: quantile(gapsSorted, 0.9),
      max: gapsSorted[gapsSorted.length - 1],
      atOrUnderThreshold: underThreshold,
      atOrUnderThresholdPct: pct(underThreshold, gapsSorted.length),
      // How many swaps sit within 0.1 WPA either side of the threshold. A
      // threshold in a SPARSE band is a decision; one in a dense band means
      // small changes to the constant move many champions.
      within0p1OfThreshold: gapsSorted.filter((g) => Math.abs(g - MAX_WPA_COST) <= 0.1).length,
      /** Count per 0.25-wide bucket, so the SHAPE is visible and a threshold
       *  can be argued from a sparse band rather than asserted. */
      histogram: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => {
          const lo = -1.5 + i * 0.25;
          return [lo.toFixed(2), gapsSorted.filter((g) => g >= lo && g < lo + 0.25).length];
        })
      ),
    },
    firedCostDistribution: {
      n: costsSorted.length,
      median: quantile(costsSorted, 0.5),
      p90: quantile(costsSorted, 0.9),
      max: costsSorted[costsSorted.length - 1],
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ report, perCombo }, null, 2) + "\n");
    process.stderr.write(`wrote ${OUT}\n`);
  }
}

await main();
