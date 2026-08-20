// ─────────────────────────────────────────────────────────────────────────────
// lib/rebuild/controller.ts — the checkpointed, resumable cold-rebuild
// controller.
//
// It orchestrates the EXISTING ingest scripts. It does not reimplement any of
// them, it does not open a database connection, and it does not make a single
// Riot call itself. Its entire job is: run the plan in order, remember durably
// what finished, back off when an upstream says to, survive the machine going
// to sleep or losing power in the middle, and refuse to let a thin corpus be
// baked into an artifact the in-game shop panel will trust for a whole patch.
//
// ── Why a journal and not a state file ──────────────────────────────────────
//
// A state file has to be rewritten in place after every unit, which puts a
// read-modify-write on the exact failure this controller exists to survive:
// power loss. Even with write-temp-then-rename you are trusting the filesystem
// to order two operations across an unplanned reboot.
//
// The journal is APPEND-ONLY JSONL, fsynced after every record, and the live
// state is REPLAYED from it at startup. Crash-safety then falls out of the
// format instead of out of a protocol: the only record that can be damaged is
// the last one, and a damaged last record is dropped on replay. The worst case
// is that a unit that actually finished is re-run — and every unit is
// idempotent by construction, because every underlying script is cursor- or
// upsert-driven (that is what makes "the next tick brings it back" true for
// the priority walk, and what makes the match walk's walk-start cursor safe).
//
// So: progress recorded by this controller is a LOWER BOUND on progress made.
// It never claims more than happened. That is the correct direction to be
// wrong in, and it is why an external review's "assume partial progress is
// disposable" does not apply here.
//
// ── Why sleep is a first-class concept ──────────────────────────────────────
//
// This runs on a Windows desktop that sleeps. A naive per-unit timeout kills a
// perfectly healthy child the moment the lid comes back up, because eight
// hours of wall clock elapsed while nothing ran. The controller heartbeats, and
// any interval where the wall clock advanced far more than the heartbeat asked
// for is charged to sleep, not to the child. The unit's cap is spent in AWAKE
// time only.
//
// ── Every I/O edge is injected ──────────────────────────────────────────────
//
// Same reason as lib/consensus/generateArtifact.ts: the rules here are the kind
// where being wrong is expensive, and none of them can be exercised against a
// live database or a live Riot key today. `scripts/rebuild-controller.mjs`
// supplies the real spawn, the real clock and the real fsync; the tests supply
// fakes and assert the decisions.
// ─────────────────────────────────────────────────────────────────────────────

import type { PlannedUnit } from "./plan";

export const JOURNAL_VERSION = 1;

// ── Journal ─────────────────────────────────────────────────────────────────

export type JournalEvent =
  | { v: number; t: string; kind: "run-start"; runId: string; planKeys: string[] }
  | { v: number; t: string; kind: "unit-start"; key: string; attempt: number }
  | { v: number; t: string; kind: "unit-done"; key: string; ms: number; drained: boolean }
  | { v: number; t: string; kind: "unit-failed"; key: string; attempt: number; exitCode: number | null; reason: string }
  | { v: number; t: string; kind: "unit-capped"; key: string; ms: number }
  | { v: number; t: string; kind: "backoff"; key: string; ms: number; reason: string }
  | { v: number; t: string; kind: "sleep"; ms: number }
  | { v: number; t: string; kind: "stage-drained"; stage: string }
  | { v: number; t: string; kind: "abort"; reason: string }
  | { v: number; t: string; kind: "gate"; verdict: string; detail: string };

export interface JournalParse {
  events: JournalEvent[];
  /** Lines that would not parse. */
  dropped: number;
  /** True when a damaged line was NOT the final one — that is filesystem
   *  corruption rather than an interrupted append, and the CLI says so. */
  corruptBeforeEnd: boolean;
}

export function parseJournal(text: string): JournalParse {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const events: JournalEvent[] = [];
  let dropped = 0;
  let corruptBeforeEnd = false;
  lines.forEach((line, i) => {
    try {
      const parsed = JSON.parse(line) as JournalEvent;
      if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") {
        throw new Error("not an event");
      }
      events.push(parsed);
    } catch {
      dropped++;
      if (i !== lines.length - 1) corruptBeforeEnd = true;
    }
  });
  return { events, dropped, corruptBeforeEnd };
}

export interface ReplayState {
  /** Unit keys that completed cleanly, or were capped after doing real work
   *  in a stage that has no drain signal. */
  completed: Set<string>;
  /** Stages that signalled drain — their remaining units are skipped. */
  drained: Set<string>;
  /** Consecutive failed attempts per key, carried across process restarts so a
   *  crash loop cannot reset the retry budget and spin forever. */
  attempts: Map<string, number>;
  aborts: string[];
}

/** Rebuilds live state from the journal. Deliberately tolerant: an unmatched
 *  `unit-start` (the process died mid-unit) simply leaves the unit incomplete,
 *  which is the truthful answer. */
export function replayJournal(events: JournalEvent[]): ReplayState {
  const completed = new Set<string>();
  const drained = new Set<string>();
  const attempts = new Map<string, number>();
  const aborts: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "unit-done":
      case "unit-capped":
        completed.add(e.key);
        attempts.delete(e.key);
        break;
      case "unit-failed":
        attempts.set(e.key, (attempts.get(e.key) ?? 0) + 1);
        break;
      case "stage-drained":
        drained.add(e.stage);
        break;
      case "abort":
        aborts.push(e.reason);
        break;
      default:
        break;
    }
  }
  return { completed, drained, attempts, aborts };
}

// ── Reading what an upstream told us ────────────────────────────────────────

export interface UnitSignals {
  /** Seconds from a `Retry-After` header echoed into the child's output. */
  retryAfterSec: number | null;
  rateLimited: boolean;
  serverError: boolean;
  /** Neon's 402: the compute quota is gone. This is a HARD STOP, never a
   *  retry — retrying is what turned a bad cadence into a month-long outage. */
  quotaExhausted: boolean;
  /** Riot rejected the key outright (401/403). Also a hard stop: a development
   *  key expires every 24h and no amount of backoff renews it. */
  keyRejected: boolean;
}

const RETRY_AFTER_RE = /retry[-_ ]?after["'\s:=]+(\d+(?:\.\d+)?)/i;

/** Reads an ingest script's own output for the things a controller must react
 *  to. Text-based on purpose: the controller supervises child PROCESSES, so
 *  the response objects are three layers below it and the log line is the only
 *  honest interface. Every pattern below appears verbatim in this repo's
 *  scripts or in the driver errors they print. */
export function classifySignals(output: string): UnitSignals {
  const retryMatch = RETRY_AFTER_RE.exec(output);
  const retryAfterSec = retryMatch ? Math.max(0, Number(retryMatch[1])) : null;
  return {
    retryAfterSec: Number.isFinite(retryAfterSec as number) ? retryAfterSec : null,
    rateLimited: /\b429\b|rate[- ]?limit(ed)?\b|too many requests/i.test(output),
    serverError: /\b5\d\d\b|HTTP status 50\d|internal server error/i.test(output),
    quotaExhausted: /\b402\b|exceeded the compute time quota|compute time quota/i.test(output),
    keyRejected: /\b401\b|\b403\b|forbidden|unauthorized|invalid api key/i.test(output),
  };
}

// ── Backoff ─────────────────────────────────────────────────────────────────

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 0..1 fraction of the computed delay that is randomised away, so a
   *  restarted controller does not land on the same second as its predecessor. */
  jitter: number;
}

export const BACKOFF_DEFAULTS: BackoffOptions = {
  baseMs: 30_000,
  maxMs: 30 * 60_000,
  jitter: 0.25,
};

/** `Retry-After` WINS. It is the upstream telling us exactly when it will
 *  answer again, and guessing shorter gets the key suspended while guessing
 *  longer wastes the night. Only when there is no header do we fall back to
 *  exponential-with-jitter. The cap applies to both, because an upstream that
 *  says "come back in nine hours" should surface as a stall to a human rather
 *  than silently eat the run. */
export function backoffMs(
  attempt: number,
  signals: UnitSignals,
  opts: BackoffOptions = BACKOFF_DEFAULTS,
  random: () => number = Math.random
): number {
  const n = Math.max(1, attempt);
  let delay: number;
  if (signals.retryAfterSec != null && signals.retryAfterSec > 0) {
    delay = signals.retryAfterSec * 1000;
  } else {
    delay = opts.baseMs * 2 ** (n - 1);
  }
  delay = Math.min(delay, opts.maxMs);
  const jittered = delay * (1 - opts.jitter * random());
  return Math.max(0, Math.round(jittered));
}

// ── Sleep detection ─────────────────────────────────────────────────────────

/** Wall clock advanced far more than we asked to wait: the machine suspended.
 *  Returns the milliseconds to charge to sleep rather than to the running
 *  child. The tolerance absorbs ordinary scheduler jitter and NTP nudges. */
export function sleptMs(expectedWaitMs: number, observedWallMs: number, toleranceMs = 60_000): number {
  const excess = observedWallMs - expectedWaitMs;
  return excess > toleranceMs ? excess : 0;
}

// ── The artifact gate ───────────────────────────────────────────────────────

export interface ArtifactCoverage {
  combos: number;
  pro: number;
  otp: number;
  /** Fraction of attempted champion-roles that RESOLVED — the generator's own
   *  --min-coverage measure. */
  resolved: number;
}

export interface GateThresholds {
  /** Champion-roles that must carry real pro data. The generator's own
   *  --min-coverage CANNOT substitute for this: a completely empty database
   *  resolves every combo successfully as `null`, so `resolved` would read
   *  100% while the artifact contained nothing at all. This is the gate that
   *  actually stands between a thin corpus and a shop panel that trusts it for
   *  a whole patch. */
  minPro: number;
  minOtp: number;
  /** The generator's request-success floor, re-asserted here so the controller
   *  refuses before it spends the write rather than after. */
  minResolved: number;
}

export const GATE_DEFAULTS: GateThresholds = {
  // Anchored on HANDOFF-core-precompute.md §2d's realistic-coverage figure of
  // 455 pro / 133 otp, discounted to roughly two thirds so a partial rebuild
  // can ship without waiting for full parity — but not a token one.
  minPro: 300,
  minOtp: 80,
  minResolved: 0.95,
};

export interface GateVerdict {
  ok: boolean;
  reasons: string[];
}

export function evaluateArtifactGate(
  coverage: ArtifactCoverage,
  thresholds: GateThresholds = GATE_DEFAULTS
): GateVerdict {
  const reasons: string[] = [];
  if (coverage.pro < thresholds.minPro) {
    reasons.push(`pro coverage ${coverage.pro} < ${thresholds.minPro} champion-roles`);
  }
  if (coverage.otp < thresholds.minOtp) {
    reasons.push(`otp coverage ${coverage.otp} < ${thresholds.minOtp} champion-roles`);
  }
  if (coverage.resolved < thresholds.minResolved) {
    reasons.push(
      `resolved ${(coverage.resolved * 100).toFixed(1)}% < ${(thresholds.minResolved * 100).toFixed(1)}%`
    );
  }
  return { ok: reasons.length === 0, reasons };
}

const COVERAGE_RE =
  /resolved\s+(\d+)\s*\/\s*(\d+)\s*\(([\d.]+)%\)\s*[^\d]*pro\s+(\d+),\s*otp\s+(\d+)/i;

/** Reads the generator CLI's own summary line. Returns null rather than
 *  guessing — a gate that cannot read the numbers must not pass. */
export function parseCoverageLine(stdout: string): ArtifactCoverage | null {
  const m = COVERAGE_RE.exec(stdout);
  if (!m) return null;
  const attempted = Number(m[2]);
  if (!Number.isFinite(attempted) || attempted <= 0) return null;
  return {
    combos: attempted,
    resolved: Number(m[1]) / attempted,
    pro: Number(m[4]),
    otp: Number(m[5]),
  };
}

// ── The loop ────────────────────────────────────────────────────────────────

export interface UnitResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout+stderr tail, for signal classification. */
  output: string;
  /** Awake milliseconds the unit consumed. */
  awakeMs: number;
  /** Milliseconds the machine spent suspended during the unit. */
  sleptMs: number;
}

export interface ControllerDeps {
  /** Wall clock. */
  now: () => number;
  /** Runs one unit to completion, enforcing `unit.maxMs` of AWAKE time and
   *  reporting how much of the elapsed wall clock was sleep. */
  runUnit: (unit: PlannedUnit) => Promise<UnitResult>;
  /** Durable, fsynced append. Must not return until the record is on disk. */
  append: (event: JournalEvent) => void;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
  random?: () => number;
}

export interface ControllerOptions {
  runId: string;
  /** Failed attempts on one unit before the run aborts. */
  maxAttempts?: number;
  /** Rate-limit retries are not real failures and get a much longer leash: an
   *  upstream 429 always recovers, and giving up on one wastes the night. */
  maxRateLimitAttempts?: number;
  backoff?: BackoffOptions;
  /** Stop after phase 1 so the artifact can be generated and shipped before
   *  the long tail runs. */
  stopAfterPhase?: 1 | 2 | null;
}

export type ControllerStatus = "complete" | "aborted";

export interface ControllerReport {
  status: ControllerStatus;
  reason: string | null;
  executed: string[];
  skipped: string[];
  failedKey: string | null;
}

/** Executes the plan, resuming from whatever the journal already records.
 *
 *  Ordering rule: units run strictly in plan order and one at a time. Every
 *  phase-1 stage except `prostage` spends the single shared Riot key, and the
 *  pacer only serialises within a process, so overlapping two of them
 *  suspends the key for the whole app (CLAUDE.md gotcha (d)). Serial is not a
 *  simplification here, it is the constraint. */
export async function runController(
  plan: PlannedUnit[],
  state: ReplayState,
  deps: ControllerDeps,
  opts: ControllerOptions
): Promise<ControllerReport> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const maxRateLimitAttempts = opts.maxRateLimitAttempts ?? 20;
  const backoffOpts = opts.backoff ?? BACKOFF_DEFAULTS;
  const random = deps.random ?? Math.random;
  const stamp = () => new Date(deps.now()).toISOString();
  const emit = (e: Omit<JournalEvent, "v" | "t">) =>
    deps.append({ v: JOURNAL_VERSION, t: stamp(), ...e } as JournalEvent);

  emit({ kind: "run-start", runId: opts.runId, planKeys: plan.map((u) => u.key) } as never);

  const executed: string[] = [];
  const skipped: string[] = [];
  const drained = new Set(state.drained);
  const attempts = new Map(state.attempts);

  for (const unit of plan) {
    if (opts.stopAfterPhase != null && unit.phase > opts.stopAfterPhase) {
      skipped.push(unit.key);
      continue;
    }
    if (state.completed.has(unit.key)) {
      skipped.push(unit.key);
      deps.log(`skip ${unit.key} — already recorded complete`);
      continue;
    }
    if (drained.has(unit.stage)) {
      skipped.push(unit.key);
      deps.log(`skip ${unit.key} — stage ${unit.stage} already drained`);
      continue;
    }

    for (;;) {
      const attempt = (attempts.get(unit.key) ?? 0) + 1;
      emit({ kind: "unit-start", key: unit.key, attempt } as never);
      deps.log(`run ${unit.key} (attempt ${attempt}): ${unit.script} ${unit.argv.join(" ")}`);

      const result = await deps.runUnit(unit);
      if (result.sleptMs > 0) {
        emit({ kind: "sleep", ms: result.sleptMs } as never);
        deps.log(`machine slept ${Math.round(result.sleptMs / 1000)}s during ${unit.key} — not charged to its budget`);
      }
      const signals = classifySignals(result.output);

      if (signals.quotaExhausted) {
        const reason = `${unit.key}: database compute quota exhausted (HTTP 402) — stopping rather than retrying`;
        emit({ kind: "abort", reason } as never);
        return { status: "aborted", reason, executed, skipped, failedKey: unit.key };
      }
      if (signals.keyRejected && result.exitCode !== 0) {
        const reason = `${unit.key}: upstream rejected the credential (401/403) — a development Riot key expires every 24h and backoff cannot renew it`;
        emit({ kind: "abort", reason } as never);
        return { status: "aborted", reason, executed, skipped, failedKey: unit.key };
      }

      if (result.timedOut) {
        // Not a failure: a capped unit in a time-bounded stage did real work
        // and its own cursor holds the frontier. Record it and move on.
        emit({ kind: "unit-capped", key: unit.key, ms: result.awakeMs } as never);
        attempts.delete(unit.key);
        executed.push(unit.key);
        deps.log(`${unit.key} hit its ${Math.round(unit.maxMs / 60000)} min awake cap — recorded as progress, continuing`);
        break;
      }

      if (result.exitCode === 0) {
        emit({ kind: "unit-done", key: unit.key, ms: result.awakeMs, drained: unit.drainOnCleanExit } as never);
        attempts.delete(unit.key);
        executed.push(unit.key);
        if (unit.drainOnCleanExit) {
          drained.add(unit.stage);
          emit({ kind: "stage-drained", stage: unit.stage } as never);
          deps.log(`stage ${unit.stage} drained on a clean exit — its remaining units are unnecessary`);
        }
        break;
      }

      const reason = signals.rateLimited
        ? "rate limited"
        : signals.serverError
          ? "upstream 5xx"
          : `exit ${result.exitCode}`;
      emit({ kind: "unit-failed", key: unit.key, attempt, exitCode: result.exitCode, reason } as never);
      attempts.set(unit.key, attempt);

      const ceiling = signals.rateLimited || signals.serverError ? maxRateLimitAttempts : maxAttempts;
      if (attempt >= ceiling) {
        const abortReason = `${unit.key}: ${reason}, ${attempt} attempts exhausted`;
        emit({ kind: "abort", reason: abortReason } as never);
        return { status: "aborted", reason: abortReason, executed, skipped, failedKey: unit.key };
      }

      const delay = backoffMs(attempt, signals, backoffOpts, random);
      emit({ kind: "backoff", key: unit.key, ms: delay, reason } as never);
      deps.log(`${unit.key} failed (${reason}) — backing off ${Math.round(delay / 1000)}s before attempt ${attempt + 1}`);
      await deps.wait(delay);
    }
  }

  return { status: "complete", reason: null, executed, skipped, failedKey: null };
}
