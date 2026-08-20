// ─────────────────────────────────────────────────────────────────────────────
// lib/rebuild/plan.ts — WHAT the cold rebuild runs, in WHAT order, and which
// of it is needed before a shippable artifact exists.
//
// This is a plan, not a runner. `controller.ts` executes it and
// `scripts/rebuild-controller.mjs` is the CLI. The split exists because the
// ordering decision here is the expensive one to get wrong — a stage in the
// wrong phase costs a day of unattended Riot time — and a plan that is a pure
// function of its options can be asserted in tests, which a spawn loop cannot.
//
// ── SCOPE: why phase 1 is five stages and not nineteen tables ───────────────
//
// The artifact (`public/consensus/item-set-consensus.json`) is the serialised
// return value of `reduceConsensusModel` over the responses of exactly two
// routes, `/api/pros` and `/api/otp` (HANDOFF-core-precompute.md §3). So the
// only tables that can change a byte of it are the ones those two routes read.
// Grepped, not assumed:
//
//   app/api/pros/route.ts   -> coachbuild.pros, pro_accounts, pro_matches,
//                              prostage_matches
//   app/api/otp/route.ts    -> coachbuild.otp_accounts, otp_matches
//
// `source` defaults to "all" (pros/route.ts:408) and `currentConsensusQuery`
// passes `source: "all"` explicitly, so `wantProstage` is true for every
// generator request and `prostage_matches` IS in the artifact's sample. That
// is the only reason it is in phase 1. It is also the cheapest stage there:
// Leaguepedia Cargo, zero Riot calls.
//
// Everything else in the schema — draft_matchup, draft_champ_stats, my_*,
// team_comps, prostage timelines, the audit tables — backs a *browsing*
// surface. None of it can reach the shop export. It is phase 2.
//
// ── The ledger tables are not stages ────────────────────────────────────────
//
// otp_featured, otp_featured_scanned, otp_champion_cursor, my_ingest_cursor,
// ingest_health and prostage_ingest_attempts are bookkeeping. They are written
// by the stages below as a side effect and rebuild themselves. They are listed
// per-stage under `writes` so the runbook can verify the right table after the
// right stage.
// ─────────────────────────────────────────────────────────────────────────────

export interface RebuildStageSpec {
  id: string;
  phase: 1 | 2;
  title: string;
  /** Script path relative to the repo root, run through `tsx`. */
  script: string;
  /** Number of invocations this stage gets. */
  units: (opts: ResolvedPlanOptions) => number;
  /** argv for unit `i`. Pure — the plan must be reproducible, because a
   *  checkpoint written by a previous process is only meaningful if this
   *  process derives the same keys from the same options. */
  unitArgs: (i: number, opts: ResolvedPlanOptions) => string[];
  /** Per-unit wall-clock cap in ms, with time spent asleep excluded. */
  maxMs: (opts: ResolvedPlanOptions) => number;
  /** True when a clean exit inside the cap means "this stage has drained" and
   *  the remaining units may be skipped. False for stages whose script always
   *  exits 0 at a time bound (the priority walk) or at a fixed batch size (the
   *  onetricks scrape) — there is no drain signal, so every unit runs. */
  drainOnCleanExit: boolean;
  /** Spends the single shared Riot key. Two such stages must never overlap
   *  (CLAUDE.md gotcha (d): the pacer serialises WITHIN a process only). */
  usesRiot: boolean;
  /** Needs a local Chrome through puppeteer-core. */
  usesChrome: boolean;
  writes: string[];
}

export interface PlanOptions {
  /** Pro roster depth. 1,445 was the pre-outage corpus; 200 is the documented
   *  freshness trade that reaches a shippable artifact roughly 3x sooner. */
  rosterSize?: number;
  /** Champions per invocation of the onetricks.gg discovery scrape. */
  championChunk?: number;
  /** Size of the champion pool being discovered. */
  championCount?: number;
  /** Matches fetched per discovered one-trick.
   *
   *  This is the single most expensive number in the whole plan and it is easy
   *  to miss: `scripts/ingest-otp-featured.mjs` DEFAULTS to 100, which across
   *  173 champions is roughly 22,000 paced Riot calls — over eight hours, on
   *  the critical path to the artifact. 40 matches a champion is what the
   *  proven scheduled cadence already uses, it is what produced the pre-outage
   *  baseline of ~39 stored games for a non-deep-walked champion, and it cuts
   *  this stage to about five hours. Depth beyond that is the deep walk's job,
   *  and the deep walk is NOT on the critical path — see `otpPrioritySlots`. */
  featuredMatches?: number;
  /** 1-hour slots of the OTP deep walk.
   *
   *  Deliberately small by default. The walk deepens the sample for champions
   *  that already have one; it does not put new champion-roles on the board.
   *  BREADTH — which is what the artifact gate measures — comes entirely from
   *  the discovery stage above. So the fastest route to a shippable artifact is
   *  `--otp-slots 0`, and the deep walk can run afterwards, at its re-cadenced
   *  duty cycle, with the artifact already shipped. That ordering matters:
   *  this walk is the job that exhausted the compute quota. */
  otpPrioritySlots?: number;
  /** Wall-clock slots for the pro match walk. It drains on its own, so this is
   *  a ceiling, not a target. */
  matchSlots?: number;
  matchSlotHours?: number;
  /** 1 = only what the artifact needs. 2 = only the rest. "all" = both. */
  phase?: 1 | 2 | "all";
}

export type ResolvedPlanOptions = Required<PlanOptions>;

export const PLAN_DEFAULTS: ResolvedPlanOptions = {
  rosterSize: 200,
  championChunk: 10,
  championCount: 173,
  featuredMatches: 40,
  otpPrioritySlots: 3,
  matchSlots: 6,
  matchSlotHours: 4,
  phase: "all",
};

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolvePlanOptions(opts: PlanOptions = {}): ResolvedPlanOptions {
  const merged = { ...PLAN_DEFAULTS, ...stripUndefined(opts) };
  if (merged.rosterSize < 1) throw new Error("rosterSize must be >= 1");
  if (merged.championChunk < 1) throw new Error("championChunk must be >= 1");
  if (merged.championCount < 1) throw new Error("championCount must be >= 1");
  if (merged.featuredMatches < 1) throw new Error("featuredMatches must be >= 1");
  if (merged.otpPrioritySlots < 0) throw new Error("otpPrioritySlots must be >= 0");
  if (merged.matchSlots < 0) throw new Error("matchSlots must be >= 0");
  if (merged.matchSlotHours <= 0) throw new Error("matchSlotHours must be > 0");
  return merged;
}

const HOUR = 3_600_000;

export const REBUILD_STAGES: RebuildStageSpec[] = [
  {
    id: "roster",
    phase: 1,
    title: "pro roster discovery (lolpros.gg scrape + Riot account-v1)",
    script: "scripts/ingest-roster.mjs",
    units: () => 1,
    unitArgs: (_i, o) => [String(o.rosterSize)],
    // ~2 Riot calls per pro at the 1.3s pacer, plus the scrape. 200 pros is
    // well inside an hour; 1,445 is not, hence the derived cap.
    maxMs: (o) => Math.max(HOUR, Math.ceil((o.rosterSize * 2 * 1300) / HOUR) * HOUR),
    drainOnCleanExit: true,
    usesRiot: true,
    usesChrome: false,
    writes: ["pros", "pro_accounts"],
  },
  {
    id: "otp-featured",
    phase: 1,
    title: "one-trick discovery (onetricks.gg scrape + account resolution)",
    script: "scripts/ingest-otp-featured.mjs",
    units: (o) => Math.ceil(o.championCount / o.championChunk),
    unitArgs: (_i, o) => [
      "--champions",
      String(o.championChunk),
      "--matches",
      String(o.featuredMatches),
    ],
    maxMs: () => 2 * HOUR,
    // Stalest-first and bounded by --champions, so every invocation advances
    // the frontier and exits 0 whether or not the fleet is covered. No drain
    // signal: all units run.
    drainOnCleanExit: false,
    usesRiot: true,
    usesChrome: true,
    // It writes otp_matches too, and that is the point: this stage — not the
    // deep walk — is what puts a champion-role on the board at all.
    writes: ["otp_featured", "otp_accounts", "otp_matches"],
  },
  {
    id: "otp-priority",
    phase: 1,
    title: "OTP deep walk (sample DEPTH only — breadth already came from discovery)",
    script: "scripts/ingest-otp-priority.mjs",
    units: (o) => o.otpPrioritySlots,
    unitArgs: () => ["--max-hours", "1"],
    // The walk bounds itself at 1h. This cap is the controller's independent
    // backstop for a wedged run, deliberately above the walk's own bound so a
    // healthy run is never killed by it.
    maxMs: () => 2 * HOUR,
    drainOnCleanExit: false,
    usesRiot: true,
    usesChrome: false,
    writes: ["otp_matches", "otp_featured_scanned", "otp_champion_cursor"],
  },
  {
    id: "prostage",
    phase: 1,
    title: "pro-stage matches (Leaguepedia Cargo — zero Riot calls)",
    script: "scripts/ingest-prostage.mjs",
    units: () => 3,
    unitArgs: () => ["--via-export"],
    maxMs: () => 2 * HOUR,
    drainOnCleanExit: true,
    usesRiot: false,
    usesChrome: false,
    writes: ["prostage_matches", "prostage_ingest_attempts"],
  },
  {
    id: "matches",
    phase: 1,
    title: "pro solo-queue match corpus (the long pole)",
    script: "scripts/ingest-matches.mjs",
    units: (o) => o.matchSlots,
    unitArgs: () => [],
    maxMs: (o) => o.matchSlotHours * HOUR,
    // This one really does drain: the script loops until nextCursor === null,
    // so a unit that exits 0 inside its cap means the corpus is walked.
    drainOnCleanExit: true,
    usesRiot: true,
    usesChrome: false,
    writes: ["pro_matches"],
  },
  {
    id: "draft",
    phase: 2,
    title: "draft matchups (u.gg, wholesale per patch)",
    script: "scripts/ingest-draft.mjs",
    units: () => 1,
    unitArgs: () => [],
    maxMs: () => 3 * HOUR,
    drainOnCleanExit: true,
    usesRiot: false,
    usesChrome: false,
    writes: ["draft_matchup", "draft_champ_stats"],
  },
  {
    id: "prostage-timelines",
    phase: 2,
    title: "pro-stage timeline backfill",
    script: "scripts/backfill-prostage-timelines.mjs",
    units: () => 2,
    unitArgs: () => [],
    maxMs: () => 3 * HOUR,
    drainOnCleanExit: true,
    usesRiot: true,
    usesChrome: false,
    writes: ["prostage_matches"],
  },
  {
    id: "mystats",
    phase: 2,
    title: "personal match history (needs my_account re-entered first)",
    script: "scripts/ingest-mystats.mjs",
    units: () => 1,
    unitArgs: () => [],
    maxMs: () => 2 * HOUR,
    drainOnCleanExit: true,
    usesRiot: true,
    usesChrome: false,
    writes: ["my_matches", "my_ingest_cursor"],
  },
];

/** The tables `/api/pros` and `/api/otp` read. Anything not in here cannot
 *  change the artifact — this list is the scope reduction, in one place. */
export const ARTIFACT_CRITICAL_TABLES = [
  "pros",
  "pro_accounts",
  "pro_matches",
  "prostage_matches",
  "otp_accounts",
  "otp_matches",
] as const;

export interface PlannedUnit {
  /** Stable across runs and across resumes. This is the checkpoint key. */
  key: string;
  stage: string;
  phase: 1 | 2;
  index: number;
  unitsInStage: number;
  script: string;
  argv: string[];
  maxMs: number;
  drainOnCleanExit: boolean;
  usesRiot: boolean;
  usesChrome: boolean;
}

/** Flattens the stage specs into the concrete, ordered unit list the
 *  controller executes. Pure: same options in, same keys out, which is exactly
 *  what makes a checkpoint written by an earlier process meaningful. */
export function buildPlan(opts: PlanOptions = {}): PlannedUnit[] {
  const o = resolvePlanOptions(opts);
  const units: PlannedUnit[] = [];
  for (const stage of REBUILD_STAGES) {
    if (o.phase !== "all" && stage.phase !== o.phase) continue;
    const n = stage.units(o);
    for (let i = 0; i < n; i++) {
      units.push({
        key: `${stage.id}#${i}`,
        stage: stage.id,
        phase: stage.phase,
        index: i,
        unitsInStage: n,
        script: stage.script,
        argv: stage.unitArgs(i, o),
        maxMs: stage.maxMs(o),
        drainOnCleanExit: stage.drainOnCleanExit,
        usesRiot: stage.usesRiot,
        usesChrome: stage.usesChrome,
      });
    }
  }
  return units;
}

/** Upper bound on unattended wall clock, in hours, if every unit burns its full
 *  cap. Real runs finish sooner because the draining stages exit early. */
export function planCeilingHours(opts: PlanOptions = {}): number {
  return buildPlan(opts).reduce((h, u) => h + u.maxMs / HOUR, 0);
}
