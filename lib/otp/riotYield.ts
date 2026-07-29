// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/riotYield.ts — "is a scheduled Riot job running right now?"
//
// THIS IS THE SAFETY-CRITICAL PART OF THE CONTINUOUS FETCHER. Read this header
// before changing anything in it.
//
// lib/pro/pacer.ts serialises Riot calls at 1.3s — but only WITHIN one process.
// Two Riot-calling processes at once therefore double the request rate against
// ONE key budget. Riot's live response headers give the real ceiling as
// `x-app-rate-limit: 100:120,20:1`, i.e. 100 requests per 120 seconds; the
// pacer's 1.3s floor already runs at ~92 requests per 120 seconds, which is
// ~92% of it. There is no headroom for a second caller. Exceeding the cap
// SUSPENDS the key for every surface in the app (CLAUDE.md gotcha (d)) — every
// build card, every pro page, My Stats, all of it, not just this ingest.
//
// WHY BY PROCESS AND NOT BY CLOCK. "CoachBuildMatchIngest starts at 01:20 and
// takes about an hour, so 03:00 is free" is arithmetic that nothing enforces.
// The measured runtimes of those jobs span 23-115 minutes; a slot that is free
// on the median is occupied on the tail. Gotcha (d) exists precisely because
// that reasoning failed before. So the question asked here is the literal one:
// is there a live process running one of those scripts?
//
// TWO INDEPENDENT SIGNALS, because each has a blind spot the other covers:
//
//   1. PROCESS SCAN (primary). Enumerate node.exe / powershell.exe / pwsh.exe
//      and match their command lines against RIOT_JOB_MARKERS. A running
//      `npx tsx scripts/ingest-otp.mjs` shows up as THREE node processes (the
//      npx shim, the tsx loader and the script), all three carrying the script
//      path — verified live 2026-07-29.
//   2. TASK SCHEDULER STATE (secondary). `schtasks /query /fo csv` reports
//      `Running` for a task the moment it fires. This closes the seam between
//      the .ps1 wrapper starting and its node child existing, and it still
//      answers if the process enumeration is ever denied.
//
// Either signal saying "busy" means busy. Neither being ABLE to answer means
// busy too — see `detectRiotJobs`'s fail-closed contract below.
//
// WHY THE WRAPPER SCRIPTS ARE IN THE MARKER LIST AND NOT JUST THE .mjs FILES:
// the wrapper exists for the whole slot, including the ~10s of npx/tsx/ddragon
// startup before the job's first Riot call. Detecting the wrapper means we stop
// BEFORE the other job's first request, not merely soon after it.
// ─────────────────────────────────────────────────────────────────────────────

/** One process, reduced to what the predicate needs. */
export interface ProcessSnapshot {
  pid: number;
  name: string;
  commandLine: string;
}

/** Injectable so the predicate is testable without spawning anything. */
export type ProcessLister = () => Promise<ProcessSnapshot[]>;

/** Injectable Task Scheduler probe. Returns the names of tasks reported as
 *  currently running. */
export type TaskStateLister = () => Promise<string[]>;

/**
 * Command-line fragments that mean "a process is spending the shared Riot key".
 *
 * EXACT BASENAMES, deliberately — a looser `includes("ingest-otp")` would match
 * this fetcher's own command line (`ingest-otp-priority.mjs`) and it would
 * yield to itself forever. Note `"ingest-otp.mjs"` keeps its extension for the
 * same reason: it must not match `ingest-otp-featured.mjs`, which has its own
 * entry.
 *
 * Riot callers ONLY. `ingest-draft.mjs` (u.gg) and `ingest-prostage*.mjs`
 * (Leaguepedia + lolesports) are deliberately absent: they contend for a
 * different source's budget, and yielding to them would cost hours of Riot time
 * for no safety gain.
 */
export const RIOT_JOB_MARKERS: readonly string[] = [
  "ingest-matches.mjs",
  "ingest-matches-scheduled.ps1",
  "ingest-otp.mjs",
  "ingest-otp-scheduled.ps1",
  "ingest-otp-featured.mjs",
  "ingest-otp-featured-scheduled.ps1",
  "ingest-mystats.mjs",
  "ingest-player.mjs",
  "ingest-roster.mjs",
  "audit-accounts.mjs",
  "backfill-mystats-kda.mjs",
  "backfill-game-stats.mjs",
  "resolve-known-mains.mjs",
];

/** Scheduled tasks that run Riot-calling work. Matched case-insensitively
 *  against `schtasks` output, which prints the leading backslash path. */
export const RIOT_SCHEDULED_TASKS: readonly string[] = [
  "CoachBuildMatchIngest",
  "CoachBuildOtpIngest",
];

/** Anything whose command line contains this is US, and must never count as a
 *  competitor. Both the node script and its PowerShell wrapper share it. */
export const SELF_MARKER = "ingest-otp-priority";

export interface YieldMatch {
  pid: number;
  name: string;
  /** Which entry of RIOT_JOB_MARKERS / RIOT_SCHEDULED_TASKS matched. */
  marker: string;
  source: "process" | "task";
}

export interface YieldVerdict {
  /** True = do not make a Riot call. */
  busy: boolean;
  matches: YieldMatch[];
  /** Human-readable, goes straight into the log. */
  reason: string;
}

/**
 * PURE. Given a process snapshot (and optionally the set of scheduled tasks
 * reporting `Running`), decide whether a Riot call is safe right now.
 *
 * FAIL-CLOSED CONTRACT: pass `listerFailed: true` when the enumeration itself
 * could not be performed. The verdict is then `busy` — "I could not look" is
 * treated as "a job might be running", never as "the coast is clear". The
 * caller is expected to abort after a run of consecutive failures rather than
 * spin forever; a permanently blind fetcher that keeps calling Riot is the
 * exact failure this module exists to prevent.
 */
export function detectRiotJobs(
  processes: readonly ProcessSnapshot[],
  opts: {
    runningTasks?: readonly string[];
    listerFailed?: boolean;
    markers?: readonly string[];
    taskNames?: readonly string[];
    selfMarker?: string;
  } = {}
): YieldVerdict {
  const markers = opts.markers ?? RIOT_JOB_MARKERS;
  const taskNames = opts.taskNames ?? RIOT_SCHEDULED_TASKS;
  const selfMarker = opts.selfMarker ?? SELF_MARKER;

  if (opts.listerFailed) {
    return {
      busy: true,
      matches: [],
      reason: "process enumeration FAILED — treating as busy (fail-closed)",
    };
  }

  const matches: YieldMatch[] = [];

  for (const proc of processes) {
    const cmd = proc.commandLine ?? "";
    if (cmd.includes(selfMarker)) continue; // that is this fetcher, or its wrapper
    for (const marker of markers) {
      if (cmd.includes(marker)) {
        matches.push({ pid: proc.pid, name: proc.name, marker, source: "process" });
        break; // one marker per process is enough to condemn it
      }
    }
  }

  for (const task of opts.runningTasks ?? []) {
    const hit = taskNames.find((t) => task.toLowerCase().includes(t.toLowerCase()));
    if (hit) matches.push({ pid: -1, name: task, marker: hit, source: "task" });
  }

  if (matches.length === 0) {
    return { busy: false, matches: [], reason: "no scheduled Riot job detected" };
  }
  const summary = matches
    .map((m) => (m.source === "task" ? `task ${m.marker}` : `${m.name} pid ${m.pid} (${m.marker})`))
    .join(", ");
  return { busy: true, matches, reason: `scheduled Riot job running: ${summary}` };
}

// ── Windows implementations ─────────────────────────────────────────────────
// child_process is imported DYNAMICALLY, inside the functions, so importing
// this module for its pure half (tests, or anything the Next app might ever
// pull in) never drags a Node-only builtin into a bundle.

/** Only these image names can be running one of the marker scripts. Narrowing
 *  the CIM filter keeps the snapshot small on a machine with hundreds of
 *  processes. */
const WATCHED_IMAGES = ["node.exe", "powershell.exe", "pwsh.exe"] as const;

function execCapture(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const { execFile } = await import("node:child_process");
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        }
      );
    })();
  });
}

/**
 * Enumerate the watched images with their full command lines.
 *
 * PowerShell + CIM rather than `wmic`: wmic is deprecated and absent from
 * recent Windows 11 builds, and `tasklist` cannot show a command line at all,
 * which is the only field that distinguishes `ingest-otp.mjs` from any other
 * node process on the box.
 *
 * THROWS on failure — deliberately. The caller converts that into
 * `listerFailed: true`, which `detectRiotJobs` turns into a busy verdict.
 * Swallowing it here and returning `[]` would read as "nothing is running",
 * which is the one wrong answer this module must never give.
 */
export async function listWindowsProcesses(timeoutMs = 15000): Promise<ProcessSnapshot[]> {
  const filter = WATCHED_IMAGES.map((n) => `Name='${n}'`).join(" OR ");
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3`;
  const out = await execCapture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs
  );
  return parseCimJson(out);
}

/** PURE. ConvertTo-Json emits a bare object for a single result, an array for
 *  several, and an empty string for none — all three are normal and none is an
 *  error. */
export function parseCimJson(stdout: string): ProcessSnapshot[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      pid: typeof o.ProcessId === "number" ? o.ProcessId : -1,
      name: typeof o.Name === "string" ? o.Name : "",
      commandLine: typeof o.CommandLine === "string" ? o.CommandLine : "",
    };
  });
}

/**
 * Names of scheduled tasks currently reported as `Running`.
 *
 * Non-fatal by design, unlike the process lister: this is the SECONDARY signal,
 * so losing it degrades coverage of one seam rather than the whole predicate.
 * An empty array from a failure is safe here only because the primary signal
 * still has to pass. Never make this the sole signal.
 */
export async function listRunningScheduledTasks(timeoutMs = 15000): Promise<string[]> {
  try {
    const out = await execCapture("schtasks.exe", ["/query", "/fo", "csv", "/nh"], timeoutMs);
    return parseSchtasksCsv(out);
  } catch {
    return [];
  }
}

/** PURE. schtasks csv rows are `"TaskName","Next Run Time","Status"`. */
export function parseSchtasksCsv(stdout: string): string[] {
  const running: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.match(/"([^"]*)"/g);
    if (!cells || cells.length < 3) continue;
    const strip = (c: string) => c.slice(1, -1);
    const name = strip(cells[0]);
    const status = strip(cells[cells.length - 1]);
    if (status.trim().toLowerCase() === "running") running.push(name);
  }
  return running;
}

/**
 * Command line of ONE pid, or null when no such process exists.
 *
 * Exists for the continuous walker's single-instance lock, not for the yield
 * predicate. SELF_MARKER above deliberately makes this walk invisible to
 * itself — otherwise it would yield to itself forever — which means two copies
 * of it would each classify the other as "self" and run concurrently, doubling
 * the request rate against one key budget. That is the very failure this module
 * exists to prevent, arriving through its own escape hatch. The lock in
 * lib/otp/deepWalk.ts closes it, and this is the probe it needs.
 *
 * Returns null both for "no such process" and for a failed probe. That is safe
 * ONLY in the lock's direction: a null here means "take the lock", and taking a
 * lock that another live instance holds is caught a moment later by that
 * instance's own lock file being overwritten... which it is NOT. So the caller
 * must treat a probe failure as a reason to log loudly, not as a clean answer.
 * See the caller's `--force` handling.
 */
export async function getProcessCommandLine(
  pid: number,
  timeoutMs = 15000
): Promise<string | null> {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}"; ` +
    `if ($p) { $p.CommandLine } else { "" }`;
  try {
    const out = await execCapture(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      timeoutMs
    );
    const text = out.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** The live predicate: both signals, fail-closed on the primary one. */
export async function checkRiotJobsRunning(): Promise<YieldVerdict> {
  let processes: ProcessSnapshot[] = [];
  let listerFailed = false;
  try {
    processes = await listWindowsProcesses();
  } catch {
    listerFailed = true;
  }
  const runningTasks = listerFailed ? [] : await listRunningScheduledTasks();
  return detectRiotJobs(processes, { runningTasks, listerFailed });
}
