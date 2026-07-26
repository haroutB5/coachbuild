// ─────────────────────────────────────────────────────────────────────────────
// bridge.ts — the companion wire contract, hosted by the shell.
//
// Byte-for-byte the same contract companion.ps1 serves, because that is what
// lets the web app run UNCHANGED inside the shell: components/live/
// companionClient.ts cannot tell which process answered, so live-follow,
// auto-export and Apply Runes work on day one with zero web-side branching.
//
//   GET  /status?session=&follow=builds|draft[&detach=1]
//   GET  /live
//   POST /apply-runes
//   POST /apply-itemsets
//
// `follow` / `detach` are ACCEPTED AND IGNORED. They exist to model a browser
// tab we do not own; the shell owns its window and navigates it directly. The
// params must keep being accepted because the unchanged web app still sends
// them — and they must keep working for browser users on companion.ps1.
//
// One additive field: `host: "desktop"`. Older bridges omit it and the web app
// normalizes it to null, which is exactly the degrade rule every other v1.x
// field follows. It is what lets /live-setup show "you're in the desktop app"
// instead of a PowerShell install command, without any desktop-only code.
// ─────────────────────────────────────────────────────────────────────────────
import http from "node:http";
import { applyItemSets, applyRunes } from "./apply";
import type { LcuCredentials, ChampSelectSnapshot } from "./lcu";
import { liveClientData } from "./lcu";

export const BRIDGE_PORTS = [48291, 48292, 48293] as const;
export const APP_ORIGIN = "https://coachbuild.vercel.app";

export interface BridgeState {
  version: string;
  session: string;
  phase: string;
  credentials: LcuCredentials | null;
  champSelect: ChampSelectSnapshot | null;
  lastOpen: { championId: number; roleId: number | null; at: string } | null;
  lastPollAt: string | null;
  lastError: string | null;
}

const readBody = (request: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
  });

const sendJson = (response: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  response.end(payload);
};

/** Probes the ports for an already-bound companion bridge. Any answer at all —
 *  including the 403 a foreign session correctly gets — means something is
 *  listening, which in practice means the PowerShell tray app is running. Two
 *  companions on one machine both auto-apply (racing whole-object PUTs on the
 *  item-sets endpoint) and the tray app still opens browser tabs on champ
 *  select, which is the tab-spam experience reborn by another route. */
export const detectForeignBridge = (): Promise<number | null> =>
  new Promise((resolve) => {
    let remaining = BRIDGE_PORTS.length;
    let found: number | null = null;

    for (const port of BRIDGE_PORTS) {
      const request = http.request(
        { host: "127.0.0.1", port, path: "/status", method: "GET", timeout: 700, headers: { Origin: APP_ORIGIN } },
        () => {
          found = found ?? port;
          if (--remaining === 0) resolve(found);
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () => {
        if (--remaining === 0) resolve(found);
      });
      request.end();
    }
  });

export interface Bridge {
  port: number;
  close: () => void;
}

export const startBridge = async (state: BridgeState): Promise<Bridge> => {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1`);
    const origin = request.headers.origin;

    response.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    // Exact origin, never a wildcard and never a prefix match.
    if (origin !== APP_ORIGIN) {
      sendJson(response, 403, { error: "bad-origin" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.searchParams.get("session") !== state.session) {
      sendJson(response, 403, { error: "bad-session" });
      return;
    }

    const path = url.pathname;

    if (path === "/status" && request.method === "GET") {
      // follow / detach are read and deliberately dropped on the floor here.
      sendJson(response, 200, {
        version: state.version,
        port: bridgePort,
        host: "desktop",
        phase: state.phase,
        clientConnected: Boolean(state.credentials),
        lastOpen: state.lastOpen,
        champSelect: state.phase === "ChampSelect" ? state.champSelect : null,
        lastPollAt: state.lastPollAt,
        lastError: state.lastError,
      });
      return;
    }

    if (path === "/live" && request.method === "GET") {
      const live = await liveClientData();
      sendJson(response, 200, live ?? { error: "no-live" });
      return;
    }

    if (path === "/apply-runes" && request.method === "POST") {
      if (!state.credentials) {
        sendJson(response, 200, { ok: false, reason: "no-client", hint: "League client not detected — open the client and try again" });
        return;
      }
      const body = (await readBody(request)) as (Record<string, unknown> & { mode?: unknown }) | null;
      if (!body) {
        sendJson(response, 200, { ok: false, reason: "bad-payload" });
        return;
      }
      // Anything that is not the literal 'auto' degrades to 'manual'. Keep this
      // direction exactly: a garbage value must never accidentally GRANT auto
      // mode's different (stricter) rules — and manual is the back-compat
      // default an older web build relies on.
      const mode = body.mode === "auto" ? "auto" : "manual";
      const result = await applyRunes(state.credentials, body as never, mode);
      sendJson(response, 200, result);
      return;
    }

    if (path === "/apply-itemsets" && request.method === "POST") {
      if (!state.credentials) {
        sendJson(response, 200, { ok: false, reason: "no-client", hint: "League client not detected — open the client and try again" });
        return;
      }
      const body = (await readBody(request)) as
        | { championId?: number; sets?: unknown[]; replacePrefix?: string | null }
        | null;
      if (!body) {
        sendJson(response, 200, { ok: false, reason: "bad-payload" });
        return;
      }
      const result = await applyItemSets(
        state.credentials,
        Number(body.championId) || 0,
        (body.sets ?? []) as never,
        body.replacePrefix ?? null,
      );
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: "not-found" });
  });

  let bridgePort = 0;
  for (const port of BRIDGE_PORTS) {
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) {
      bridgePort = port;
      break;
    }
  }

  if (!bridgePort) {
    throw new Error(`No free bridge port in ${BRIDGE_PORTS.join(", ")}`);
  }

  return { port: bridgePort, close: () => server.close() };
};
