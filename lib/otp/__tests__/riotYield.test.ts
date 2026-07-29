import { describe, expect, it } from "vitest";
import {
  RIOT_JOB_MARKERS,
  RIOT_SCHEDULED_TASKS,
  SELF_MARKER,
  detectRiotJobs,
  parseCimJson,
  parseSchtasksCsv,
  type ProcessSnapshot,
} from "../riotYield";

/**
 * REAL OUTPUT, NOT A MOCK.
 *
 * Captured verbatim on 2026-07-29 at ~17:00 local from
 *   Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'"
 *     | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3
 * while the scheduled task CoachBuildOtpIngest (fired 16:20, kill limit 2h45)
 * was genuinely mid-run on this machine.
 *
 * The point of pinning the real bytes rather than a hand-written snapshot is
 * that the predicate's only job is reading THIS shape: doubled backslashes, the
 * quoting PowerShell puts around an image path, the three-process footprint an
 * `npx tsx <script>` invocation actually has. A snapshot someone typed would
 * agree with the parser by construction and prove nothing.
 *
 * Negatives are included on purpose — the companion tray app and five
 * `next start` processes from this same repo were live at capture time and must
 * NOT count as Riot jobs.
 */
const LIVE_CIM_JSON = String.raw`[{"ProcessId":16500,"Name":"powershell.exe","CommandLine":"powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Program Files\\CoachBuild Overlay\\resources\\companion.ps1\" -NoTray"},{"ProcessId":30648,"Name":"node.exe","CommandLine":"\"node\"   \"C:\\Claude\\AI\\coachbuild\\node_modules\\.bin\\\\..\\next\\dist\\bin\\next\" start -p 4715"},{"ProcessId":11608,"Name":"node.exe","CommandLine":"\"node\"   \"C:\\Claude\\AI\\coachbuild\\node_modules\\.bin\\\\..\\next\\dist\\bin\\next\" start -p 3555"},{"ProcessId":26124,"Name":"powershell.exe","CommandLine":"\"powershell.exe\" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\Claude\\AI\\coachbuild\\scripts\\ingest-otp-scheduled.ps1"},{"ProcessId":30116,"Name":"node.exe","CommandLine":"\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Program Files\\nodejs/node_modules/npm/bin/npx-cli.js\" tsx scripts/ingest-otp.mjs --champions 30"},{"ProcessId":31348,"Name":"node.exe","CommandLine":"\"node\"   \"C:\\Claude\\AI\\coachbuild\\node_modules\\.bin\\\\..\\tsx\\dist\\cli.mjs\" scripts/ingest-otp.mjs --champions 30"},{"ProcessId":26808,"Name":"node.exe","CommandLine":"\"C:\\Program Files\\nodejs\\node.exe\" --require C:\\Claude\\AI\\coachbuild\\node_modules\\tsx\\dist\\preflight.cjs --import file:///C:/Claude/AI/coachbuild/node_modules/tsx/dist/loader.mjs scripts/ingest-otp.mjs --champions 30"}]`;

describe("parseCimJson", () => {
  it("parses the live capture", () => {
    const procs = parseCimJson(LIVE_CIM_JSON);
    expect(procs).toHaveLength(7);
    expect(procs.map((p) => p.pid)).toEqual([16500, 30648, 11608, 26124, 30116, 31348, 26808]);
    expect(procs[3].commandLine).toContain("ingest-otp-scheduled.ps1");
  });

  it("accepts the three shapes ConvertTo-Json actually emits", () => {
    // A single result is a bare object, several are an array, none is an empty
    // string. All three are normal; none is an error.
    expect(parseCimJson("")).toEqual([]);
    expect(parseCimJson("   \r\n ")).toEqual([]);
    expect(parseCimJson('{"ProcessId":1,"Name":"node.exe","CommandLine":"x"}')).toEqual([
      { pid: 1, name: "node.exe", commandLine: "x" },
    ]);
  });

  it("does not invent fields for a malformed entry", () => {
    expect(parseCimJson('{"ProcessId":null,"Name":null,"CommandLine":null}')).toEqual([
      { pid: -1, name: "", commandLine: "" },
    ]);
  });
});

describe("detectRiotJobs against the LIVE CoachBuildOtpIngest run", () => {
  const live = parseCimJson(LIVE_CIM_JSON);

  it("reports busy", () => {
    const verdict = detectRiotJobs(live);
    expect(verdict.busy).toBe(true);
  });

  it("catches the wrapper AND all three node processes of one npx tsx run", () => {
    // The wrapper matters most: it exists for the whole slot including the ~10s
    // of npx/tsx startup before the job's first Riot call, so detecting it means
    // stopping BEFORE that call rather than soon after it.
    const verdict = detectRiotJobs(live);
    expect(verdict.matches.map((m) => m.pid).sort((a, b) => a - b)).toEqual([
      26124, 26808, 30116, 31348,
    ]);
    expect(verdict.matches.find((m) => m.pid === 26124)?.marker).toBe("ingest-otp-scheduled.ps1");
    expect(
      verdict.matches.filter((m) => m.marker === "ingest-otp.mjs").map((m) => m.pid).sort()
    ).toEqual([26808, 30116, 31348]);
  });

  it("does NOT flag the companion or the repo's next start processes", () => {
    const verdict = detectRiotJobs(live);
    const flagged = new Set(verdict.matches.map((m) => m.pid));
    expect(flagged.has(16500)).toBe(false); // companion.ps1 tray app
    expect(flagged.has(30648)).toBe(false); // next start -p 4715
    expect(flagged.has(11608)).toBe(false); // next start -p 3555
  });

  it("names what it saw, in a line that can go straight into the log", () => {
    const verdict = detectRiotJobs(live);
    expect(verdict.reason).toContain("scheduled Riot job running");
    expect(verdict.reason).toContain("ingest-otp-scheduled.ps1");
    expect(verdict.reason).toContain("26124");
  });

  it("is still busy from the Task Scheduler signal alone", () => {
    // The secondary signal has to stand on its own: it closes the seam between
    // the .ps1 firing and its node child existing.
    const verdict = detectRiotJobs([], { runningTasks: ["\\CoachBuildOtpIngest"] });
    expect(verdict.busy).toBe(true);
    expect(verdict.matches[0]).toMatchObject({ marker: "CoachBuildOtpIngest", source: "task" });
  });
});

describe("detectRiotJobs — the free case", () => {
  it("is not busy on an idle machine", () => {
    const idle: ProcessSnapshot[] = [
      { pid: 1, name: "node.exe", commandLine: "next start -p 4715" },
      { pid: 2, name: "powershell.exe", commandLine: "companion.ps1 -NoTray" },
    ];
    const verdict = detectRiotJobs(idle, { runningTasks: [] });
    expect(verdict.busy).toBe(false);
    expect(verdict.reason).toBe("no scheduled Riot job detected");
  });

  it("FAILS CLOSED when the enumeration could not be performed", () => {
    // "I could not look" is never "the coast is clear".
    const verdict = detectRiotJobs([], { listerFailed: true });
    expect(verdict.busy).toBe(true);
    expect(verdict.matches).toHaveLength(0);
    expect(verdict.reason).toContain("fail-closed");
  });

  it("a busy verdict with no matches means ONLY the blind case", () => {
    // The walker distinguishes "blind" from "genuinely busy" structurally
    // rather than by string-matching the reason, so this invariant is
    // load-bearing: a real detection always carries at least one match.
    const real = detectRiotJobs([{ pid: 9, name: "node.exe", commandLine: "ingest-matches.mjs" }]);
    expect(real.busy).toBe(true);
    expect(real.matches.length).toBeGreaterThan(0);
  });
});

describe("self-exclusion — the walk must not yield to itself", () => {
  it("ignores its own node process and its own wrapper", () => {
    const self: ProcessSnapshot[] = [
      {
        pid: 100,
        name: "node.exe",
        commandLine: `node C:\\Claude\\AI\\coachbuild\\scripts\\ingest-otp-priority.mjs --max-hours 12`,
      },
      {
        pid: 101,
        name: "powershell.exe",
        commandLine: `powershell.exe -File C:\\Claude\\AI\\coachbuild\\scripts\\ingest-otp-priority.ps1`,
      },
    ];
    expect(detectRiotJobs(self).busy).toBe(false);
  });

  it("the priority script's own name does not substring-match ingest-otp.mjs", () => {
    // Belt AND braces: the marker list uses exact basenames precisely so the
    // self-exclusion is not the only thing standing between this walk and
    // yielding to itself forever. If someone loosens a marker to
    // "ingest-otp", this test fails before the walk deadlocks in production.
    const cmd = "scripts/ingest-otp-priority.mjs";
    for (const marker of RIOT_JOB_MARKERS) {
      expect(cmd.includes(marker), `marker ${marker} wrongly matches the priority walker`).toBe(
        false
      );
    }
  });

  it("still detects a real job running beside us", () => {
    const mixed: ProcessSnapshot[] = [
      { pid: 100, name: "node.exe", commandLine: "node scripts/ingest-otp-priority.mjs" },
      { pid: 200, name: "node.exe", commandLine: "node scripts/ingest-matches.mjs --accounts 40" },
    ];
    const verdict = detectRiotJobs(mixed);
    expect(verdict.busy).toBe(true);
    expect(verdict.matches.map((m) => m.pid)).toEqual([200]);
  });

  it("ingest-otp.mjs and ingest-otp-featured.mjs are distinct markers", () => {
    const featured: ProcessSnapshot[] = [
      { pid: 1, name: "node.exe", commandLine: "node scripts/ingest-otp-featured.mjs --champions 20" },
    ];
    const verdict = detectRiotJobs(featured);
    expect(verdict.matches[0].marker).toBe("ingest-otp-featured.mjs");
  });
});

describe("marker list scope", () => {
  it("covers every Riot-calling script and no non-Riot one", () => {
    // ingest-draft (u.gg) and ingest-prostage (Leaguepedia/lolesports) contend
    // for a DIFFERENT source's budget. Yielding to them would cost hours of
    // Riot time for no safety gain, so their absence is deliberate — pinned so
    // a well-meaning "add all the ingests" change has to argue with a test.
    expect(RIOT_JOB_MARKERS).toContain("ingest-matches.mjs");
    expect(RIOT_JOB_MARKERS).toContain("ingest-mystats.mjs");
    expect(RIOT_JOB_MARKERS.some((m) => m.includes("draft"))).toBe(false);
    expect(RIOT_JOB_MARKERS.some((m) => m.includes("prostage"))).toBe(false);
  });

  it("does not list the priority walk's own scheduled task", () => {
    // CoachBuildOtpPriority must never appear here: the walk would yield to
    // itself and never make a single call.
    expect(RIOT_SCHEDULED_TASKS.some((t) => t.toLowerCase().includes("priority"))).toBe(false);
    expect(SELF_MARKER).toBe("ingest-otp-priority");
  });
});

describe("parseSchtasksCsv", () => {
  it("picks out only the Running rows", () => {
    const csv = [
      '"\\CoachBuildMatchIngest","29/07/2026 19:20:00","Ready"',
      '"\\CoachBuildOtpIngest","29/07/2026 22:20:00","Running"',
      '"\\CoachBuildDraftIngest","30/07/2026 08:00:00","Ready"',
    ].join("\r\n");
    expect(parseSchtasksCsv(csv)).toEqual(["\\CoachBuildOtpIngest"]);
  });

  it("ignores the header row and blank lines", () => {
    const csv = '"TaskName","Next Run Time","Status"\r\n\r\n"\\X","N/A","Running"\r\n';
    expect(parseSchtasksCsv(csv)).toEqual(["\\X"]);
  });

  it("is case-insensitive about the status text", () => {
    expect(parseSchtasksCsv('"\\A","N/A","RUNNING"')).toEqual(["\\A"]);
  });

  it("matches a task name case-insensitively and despite the leading path", () => {
    const verdict = detectRiotJobs([], { runningTasks: ["\\coachbuildmatchingest"] });
    expect(verdict.busy).toBe(true);
    expect(verdict.matches[0].marker).toBe("CoachBuildMatchIngest");
  });
});
