#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/rebuild-controller.mjs — CLI for the checkpointed cold rebuild.
//
// This file owns argv, spawning, the clock, the fsync and stdout. Every
// DECISION — what runs, in what order, what a failure means, how long to back
// off, whether the corpus is thick enough to bake into an artifact — lives in
// lib/rebuild/plan.ts and lib/rebuild/controller.ts and is unit-tested there.
// A script cannot be tested and this one supervises a 30-hour unattended run
// on a machine that sleeps, so the split is not stylistic.
//
//   npx tsx scripts/rebuild-controller.mjs --phase 1            # to a shippable artifact
//   npx tsx scripts/rebuild-controller.mjs --resume             # after a crash/reboot
//   npx tsx scripts/rebuild-controller.mjs --plan               # print the plan, run nothing
//   npx tsx scripts/rebuild-controller.mjs --status             # what the journal knows
//   npx tsx scripts/rebuild-controller.mjs --gate --base http://localhost:3000
//
// ── Resume ──────────────────────────────────────────────────────────────────
//
// There is no difference between a first run and a resume except which units
// the journal already records. `--resume` is therefore a readability flag, not
// a mode: running the same command again after a power cut picks up where the
// journal left off. `--fresh` is the only way to ignore an existing journal,
// and it renames rather than deletes it.
//
// ── What it deliberately does NOT do ────────────────────────────────────────
//
// It never opens a database connection, never calls Riot, never commits, never
// deploys, and never runs two Riot-spending scripts at once (CLAUDE.md gotcha
// (d) — the pacer serialises within a process only, and exceeding Riot's cap
// suspends the key for every surface in the app).
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { buildPlan, planCeilingHours, REBUILD_STAGES, ARTIFACT_CRITICAL_TABLES } = await import(
  "../lib/rebuild/plan.ts"
);
const {
  runController,
  parseJournal,
  replayJournal,
  parseCoverageLine,
  evaluateArtifactGate,
  sleptMs,
  GATE_DEFAULTS,
  BACKOFF_DEFAULTS,
  JOURNAL_VERSION,
} = await import("../lib/rebuild/controller.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const LOG_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"),
  "CoachBuild"
);
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const DEFAULT_JOURNAL = path.join(LOG_DIR, "rebuild-journal.jsonl");
const CONSOLE_LOG = path.join(LOG_DIR, "rebuild-controller.log");

// ── argv ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function val(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

if (has("--help") || has("-h")) {
  console.log(
    [
      "rebuild-controller — checkpointed, resumable cold rebuild of the CoachBuild corpus",
      "",
      "  --phase <1|2|all>       which half of the plan to run (default 1)",
      "  --roster-size <n>       pro roster depth (default 200; 1445 was the pre-outage corpus)",
      "  --otp-slots <n>         1-hour OTP deep-walk slots (default 3; 0 is the fastest artifact)",
      "  --featured-matches <n>  matches per discovered one-trick (default 40; the script's own",
      "                          default of 100 is ~8h of paced Riot time across 173 champions)",
      "  --match-slots <n>       pro-match walk slots (default 6)",
      "  --match-slot-hours <n>  hours per pro-match slot (default 4)",
      "  --champion-chunk <n>    champions per onetricks discovery invocation (default 10)",
      "  --journal <path>        journal file (default %LOCALAPPDATA%/CoachBuild/rebuild-journal.jsonl)",
      "  --resume                readability flag; resuming is the default behaviour",
      "  --fresh                 rename an existing journal aside and start over",
      "  --plan                  print the plan and exit",
      "  --status                print what the journal already records and exit",
      "  --gate --base <url>     run the artifact coverage gate only, write nothing",
      "  --min-pro <n>           gate: champion-roles that must carry pro data (default " +
        GATE_DEFAULTS.minPro + ")",
      "  --min-otp <n>           gate: champion-roles that must carry otp data (default " +
        GATE_DEFAULTS.minOtp + ")",
      "  --max-attempts <n>      failed attempts on one unit before the run aborts (default 5)",
      "  --backoff-base-ms <n>   first retry delay; doubles per attempt (default 30000)",
      "  --dry-run               log every unit it would run, spawn nothing",
      "",
      "Exit codes: 0 complete · 1 aborted · 2 gate refused · 3 bad arguments",
    ].join("\n")
  );
  process.exit(0);
}

const phaseArg = val("--phase", "1");
const planOpts = {
  phase: phaseArg === "all" ? "all" : Number(phaseArg) === 2 ? 2 : 1,
  rosterSize: numOrUndef(val("--roster-size")),
  otpPrioritySlots: numOrUndef(val("--otp-slots")),
  matchSlots: numOrUndef(val("--match-slots")),
  matchSlotHours: numOrUndef(val("--match-slot-hours")),
  championChunk: numOrUndef(val("--champion-chunk")),
  featuredMatches: numOrUndef(val("--featured-matches")),
};
const journalPath = val("--journal", DEFAULT_JOURNAL);
const baseMs = numOrUndef(val("--backoff-base-ms"));
const dryRun = has("--dry-run");

function numOrUndef(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`rebuild-controller: not a number: ${v}`);
    process.exit(3);
  }
  return n;
}

// ── logging ─────────────────────────────────────────────────────────────────

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(CONSOLE_LOG, stamped + "\n");
  } catch {
    /* the console is the primary sink; a failed tee must never stop a run */
  }
}

// ── the journal: append-only, fsynced, replayed ─────────────────────────────

function appendEvent(event) {
  // openSync/writeSync/fsyncSync rather than appendFileSync, because the whole
  // crash-safety argument rests on the record being ON DISK before the next
  // unit starts. appendFileSync returns once the write is in the page cache,
  // which a power cut discards.
  const fd = openSync(journalPath, "a");
  try {
    writeSync(fd, JSON.stringify(event) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readState() {
  if (!existsSync(journalPath)) return { events: [], dropped: 0, corruptBeforeEnd: false };
  return parseJournal(readFileSync(journalPath, "utf8"));
}

if (has("--fresh") && existsSync(journalPath)) {
  const aside = `${journalPath}.${Date.now()}.bak`;
  renameSync(journalPath, aside);
  log(`--fresh: previous journal moved to ${aside} (renamed, never deleted)`);
}

const plan = buildPlan(planOpts);

// ── --plan ──────────────────────────────────────────────────────────────────

if (has("--plan")) {
  console.log(`plan: phase=${planOpts.phase}  units=${plan.length}  ceiling=${planCeilingHours(planOpts).toFixed(1)}h`);
  console.log("");
  for (const stage of REBUILD_STAGES) {
    const units = plan.filter((u) => u.stage === stage.id);
    if (units.length === 0) continue;
    console.log(
      `  phase ${stage.phase}  ${stage.id}  x${units.length}  ` +
        `${stage.usesRiot ? "RIOT" : "no-riot"}${stage.usesChrome ? " chrome" : ""}` +
        `${stage.drainOnCleanExit ? " drains" : ""}`
    );
    console.log(`      ${stage.title}`);
    console.log(`      writes: ${stage.writes.join(", ")}`);
    console.log(`      argv:   ${stage.script} ${units[0].argv.join(" ")}`);
  }
  console.log("");
  console.log(`artifact-critical tables: ${ARTIFACT_CRITICAL_TABLES.join(", ")}`);
  process.exit(0);
}

// ── --status ────────────────────────────────────────────────────────────────

if (has("--status")) {
  const parsed = readState();
  const state = replayJournal(parsed.events);
  console.log(`journal: ${journalPath}`);
  console.log(`  records: ${parsed.events.length}  dropped: ${parsed.dropped}  version: ${JOURNAL_VERSION}`);
  if (parsed.corruptBeforeEnd) {
    console.log("  WARNING: a damaged record was not the final one. That is not an interrupted");
    console.log("  append — treat the journal as a lower bound and expect some units to re-run.");
  }
  console.log(`  complete: ${state.completed.size}/${plan.length} units`);
  console.log(`  drained stages: ${[...state.drained].join(", ") || "(none)"}`);
  for (const u of plan) {
    const mark = state.completed.has(u.key) ? "done" : state.drained.has(u.stage) ? "skip" : "todo";
    const att = state.attempts.get(u.key);
    console.log(`    [${mark}] ${u.key}${att ? `  (${att} failed attempts)` : ""}`);
  }
  for (const a of state.aborts) console.log(`  abort recorded: ${a}`);
  process.exit(0);
}

// ── spawn tunables ──────────────────────────────────────────────────────────
//
// These live ABOVE --gate on purpose. `--gate` calls spawnUnit() directly, and
// spawnUnit reads all three at call time; declared after the gate branch they
// sat in the temporal dead zone, so `--gate` died on
// `ReferenceError: Cannot access 'HEARTBEAT_MS' before initialization`
// before it could issue a single request. Every other entry point reaches
// spawnUnit further down the file, which is why only the gate was affected.
const HEARTBEAT_MS = 30_000;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 20_000;

// ── --gate ──────────────────────────────────────────────────────────────────

if (has("--gate")) {
  const base = val("--base", "http://localhost:3000");
  const thresholds = {
    minPro: numOrUndef(val("--min-pro")) ?? GATE_DEFAULTS.minPro,
    minOtp: numOrUndef(val("--min-otp")) ?? GATE_DEFAULTS.minOtp,
    minResolved: GATE_DEFAULTS.minResolved,
  };
  log(`gate: dry-run generation against ${base}`);
  const res = await spawnUnit(
    { key: "gate", script: "scripts/generate-consensus-artifact.mts", argv: ["--base", base, "--dry-run"], maxMs: 60 * 60_000 },
    { quiet: false }
  );
  const coverage = parseCoverageLine(res.output);
  if (!coverage) {
    log("gate REFUSED: could not read a coverage line from the generator's output.");
    log("A gate that cannot read the numbers must not pass. Check the generator ran at all.");
    process.exit(2);
  }
  const verdict = evaluateArtifactGate(coverage, thresholds);
  log(
    `gate: combos=${coverage.combos} resolved=${(coverage.resolved * 100).toFixed(1)}% ` +
      `pro=${coverage.pro} otp=${coverage.otp}`
  );
  if (!verdict.ok) {
    for (const r of verdict.reasons) log(`gate REFUSED: ${r}`);
    log("Run more otp-priority slots (OTP coverage) or more match slots (pro coverage), then re-gate.");
    process.exit(2);
  }
  log("gate PASSED — safe to generate the artifact for real:");
  log(`  npm run consensus:generate -- --base ${base}`);
  process.exit(0);
}

// ── spawning a unit ─────────────────────────────────────────────────────────


/** Runs one unit, enforcing `maxMs` of AWAKE time.
 *
 *  The heartbeat is the sleep detector. Each tick asks to wait HEARTBEAT_MS; if
 *  the wall clock advanced dramatically more than that, the machine suspended
 *  and the excess is charged to sleep rather than to the child. A laptop that
 *  sleeps eight hours mid-walk therefore resumes with its budget intact instead
 *  of having a healthy child killed on the first tick after the lid opens. */
function spawnUnit(unit, { quiet = false } = {}) {
  return new Promise((resolve) => {
    if (dryRun) {
      log(`--dry-run: would spawn ${unit.script} ${unit.argv.join(" ")}`);
      resolve({ exitCode: 0, timedOut: false, output: "", awakeMs: 0, sleptMs: 0 });
      return;
    }
    const child = spawn(process.execPath, [TSX, path.join(ROOT, unit.script), ...unit.argv], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let tail = "";
    const absorb = (buf) => {
      const text = buf.toString();
      if (!quiet) process.stdout.write(text);
      tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    let awakeMs = 0;
    let slept = 0;
    let last = Date.now();
    let killed = false;
    let timedOut = false;

    const beat = setInterval(() => {
      const nowMs = Date.now();
      const observed = nowMs - last;
      last = nowMs;
      const asleep = sleptMs(HEARTBEAT_MS, observed);
      if (asleep > 0) {
        slept += asleep;
        log(`heartbeat saw a ${Math.round(asleep / 1000)}s wall-clock jump — charging it to sleep, not to ${unit.key}`);
      }
      awakeMs += observed - asleep;
      if (awakeMs >= unit.maxMs && !killed) {
        killed = true;
        timedOut = true;
        log(`${unit.key} reached its ${Math.round(unit.maxMs / 60000)} min awake cap — terminating`);
        child.kill();
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref?.();
      }
    }, HEARTBEAT_MS);
    beat.unref?.();

    const finish = (exitCode) => {
      clearInterval(beat);
      const nowMs = Date.now();
      const observed = nowMs - last;
      const asleep = sleptMs(HEARTBEAT_MS, observed);
      slept += asleep;
      awakeMs += Math.max(0, observed - asleep);
      resolve({ exitCode, timedOut, output: tail, awakeMs, sleptMs: slept });
    };

    child.on("error", (err) => {
      tail += `\nspawn error: ${err.message}\n`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// ── run ─────────────────────────────────────────────────────────────────────

const parsed = readState();
if (parsed.corruptBeforeEnd) {
  log("WARNING: the journal has a damaged record that is not the final one.");
  log("Progress is still a LOWER bound (every unit is idempotent), so the run continues.");
}
const state = replayJournal(parsed.events);
log(
  `journal ${journalPath}: ${parsed.events.length} records, ${state.completed.size}/${plan.length} units already complete`
);
if (state.completed.size > 0) log("resuming — completed units are skipped, not re-run");

const report = await runController(plan, state, {
  now: () => Date.now(),
  runUnit: (unit) => spawnUnit(unit),
  append: appendEvent,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
}, {
  runId: `${new Date().toISOString()}-${process.pid}`,
  stopAfterPhase: planOpts.phase === "all" ? null : planOpts.phase,
  maxAttempts: numOrUndef(val("--max-attempts")),
  backoff: baseMs === undefined ? undefined : { ...BACKOFF_DEFAULTS, baseMs },
});

log(`controller ${report.status}: executed ${report.executed.length}, skipped ${report.skipped.length}`);
if (report.status === "aborted") {
  log(`ABORTED: ${report.reason}`);
  log("Fix the cause, then re-run the same command — the journal makes it a resume.");
  process.exit(1);
}
log("All planned units are complete. Next: run the artifact gate.");
log(`  npx tsx scripts/rebuild-controller.mjs --gate --base http://localhost:3000`);
process.exit(0);
