// ─────────────────────────────────────────────────────────────────────────────
// lcu.ts — League client discovery and polling, ported from companion.ps1.
//
// Two loopback services, both self-signed:
//   • the LCU proper (LeagueClientUx), port + token from the process command
//     line, with the lockfile as fallback;
//   • Live Client Data on a FIXED 127.0.0.1:2999 (in-game only) — a different
//     service that the wire contract's GET /live passes through.
//
// TLS: companion.ps1 had to install a PROCESS-GLOBAL certificate callback
// (PS 5.1 has no per-request option) and scope it by inspecting the sender's
// host — CLAUDE.md gotcha (z) flags that its real-cert path was never verified.
// Node makes the scoping structural instead of conditional: a dedicated Agent
// with rejectUnauthorized:false that is only ever attached to these two
// loopback clients. Nothing else in the process loses validation, ever.
// ─────────────────────────────────────────────────────────────────────────────
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Loopback-only. Never pass this agent to any non-127.0.0.1 request. */
const loopbackAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

export const LIVE_CLIENT_PORT = 2999;

export interface LcuCredentials {
  port: number;
  token: string;
  source: "cmdline" | "lockfile";
}

export interface LcuResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
}

const LOCKFILE_PATHS = [
  "C:\\Riot Games\\League of Legends\\lockfile",
  "C:\\Program Files\\Riot Games\\League of Legends\\lockfile",
];

/** Command line first (install-directory independent — this is why the shipped
 *  companion prefers it over the lockfile), lockfile second. Both failure paths
 *  degrade to null rather than throwing: "no client" is a normal state. */
export const discoverCredentials = async (): Promise<LcuCredentials | null> => {
  try {
    // PowerShell rather than WMIC: WMIC is removed on current Win11.
    const { stdout } = await execAsync(
      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'LeagueClientUx.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
      { windowsHide: true, timeout: 5000 },
    );
    const port = stdout.match(/--app-port=(\d+)/);
    const token = stdout.match(/--remoting-auth-token=([^"\s]+)/);
    if (port && token) {
      return { port: Number(port[1]), token: token[1], source: "cmdline" };
    }
  } catch {
    // CIM can be flaky/slow on a real machine; fall through to the lockfile.
  }

  for (const path of LOCKFILE_PATHS) {
    try {
      // Format: LeagueClient:PID:PORT:PASSWORD:https
      const fields = (await readFile(path, "utf8")).trim().split(":");
      if (fields.length >= 5) {
        return { port: Number(fields[2]), token: fields[3], source: "lockfile" };
      }
    } catch {
      // Not installed there, or the client is not running.
    }
  }

  return null;
};

/** One LCU call. Never throws: a dead socket is `{ok:false, status:0}`, which
 *  is the signal the caller uses to invalidate cached credentials — exactly the
 *  0/401 rule companion.ps1's Test-LcuCallFailure encodes. */
export const lcuRequest = async <T = unknown>(
  credentials: LcuCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<LcuResponse<T>> => {
  const auth = Buffer.from(`riot:${credentials.token}`).toString("base64");
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: credentials.port,
        path,
        method,
        agent: loopbackAgent,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: T | null = null;
          try {
            parsed = raw ? (JSON.parse(raw) as T) : null;
          } catch {
            parsed = null; // a non-JSON 200 is treated as "no body", not a crash
          }
          const status = response.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, body: parsed });
        });
      },
    );

    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ ok: false, status: 0, body: null }));
    if (payload) request.write(payload);
    request.end();
  });
};

/** Live Client Data (in-game only, fixed port, same self-signed situation).
 *  Returns null outside a game — the caller maps that to {error:'no-live'}. */
export const liveClientData = async (): Promise<unknown | null> => {
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: LIVE_CLIENT_PORT,
        path: "/liveclientdata/allgamedata",
        method: "GET",
        agent: loopbackAgent,
        timeout: 3000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end();
  });
};

// ── Champ-select reading ────────────────────────────────────────────────────

export interface ChampSelectSnapshot {
  localPlayerCellId: number;
  cellChampionId: number | null;
  pickIntent: number | null;
  actionChampionId: number | null;
  roleId: number | null;
  theirTeam: number[];
  timerPhase: string | null;
}

const POSITION_TO_ROLE: Record<string, number> = {
  top: 0,
  jungle: 1,
  middle: 2,
  bottom: 3,
  utility: 4,
};

/** The same 3-way resolution the companion uses, and it must stay the same 3
 *  ways in the same order: a pre-lock hover often is not on the cell at all on
 *  some client versions, so session.actions is a real signal, not a fallback of
 *  last resort. */
export const readChampSelect = (session: any): ChampSelectSnapshot | null => {
  if (!session) return null;
  const localCellId = Number(session.localPlayerCellId);
  const cell = (session.myTeam ?? []).find((member: any) => Number(member?.cellId) === localCellId);
  if (!cell) return null;

  const cellChampionId = Number(cell.championId) || 0;
  const pickIntent = Number(cell.championPickIntent) || 0;

  // actions is an array OF ARRAYS — flatten both levels, look only at OUR own
  // in-progress pick, and prefer an incomplete action (a live hover) over a
  // completed one.
  const candidates: Array<{ championId: number; completed: boolean }> = [];
  for (const row of session.actions ?? []) {
    for (const action of row ?? []) {
      if (!action) continue;
      if (Number(action.actorCellId) !== localCellId) continue;
      if (action.type !== "pick") continue;
      const championId = Number(action.championId) || 0;
      if (championId > 0) candidates.push({ championId, completed: Boolean(action.completed) });
    }
  }
  const inProgress = candidates.find((candidate) => !candidate.completed);
  const actionChampionId = inProgress?.championId ?? candidates[0]?.championId ?? 0;

  const theirTeam: number[] = [];
  for (const member of session.theirTeam ?? []) {
    if (!member) continue;
    const locked = Number(member.championId) || 0;
    if (locked > 0) {
      theirTeam.push(locked);
      continue;
    }
    const intent = Number(member.championPickIntent) || 0;
    if (intent > 0) theirTeam.push(intent);
  }

  const position = String(cell.assignedPosition ?? "").toLowerCase();

  return {
    localPlayerCellId: localCellId,
    cellChampionId: cellChampionId > 0 ? cellChampionId : null,
    pickIntent: pickIntent > 0 ? pickIntent : null,
    actionChampionId: actionChampionId > 0 ? actionChampionId : null,
    roleId: position in POSITION_TO_ROLE ? POSITION_TO_ROLE[position] : null,
    theirTeam,
    timerPhase: session.timer?.phase ? String(session.timer.phase) : null,
  };
};

/** cellChampionId -> pickIntent -> actionChampionId, the companion's exact
 *  priority. 0 means nothing is hovered or locked yet, in any of the three. */
export const resolveChampionId = (snapshot: ChampSelectSnapshot | null): number => {
  if (!snapshot) return 0;
  return snapshot.cellChampionId || snapshot.pickIntent || snapshot.actionChampionId || 0;
};
