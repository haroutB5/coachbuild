// bridgeLog.ts — forwards web-side decision lines to the companion's own
// log (POST /client-log), so they survive the WebView2 window teardown at
// game start that destroys the browser console with them.
//
// The funnel is recordAutoExportDecision (champSelectFollowState.ts), which
// already fires only on real changes and writes — never per-tick noise — so
// this module adds only a consecutive-duplicate guard and the 404 feature
// probe. An older bridge answers 404 (unknown route); that is remembered per
// session and forwarding pauses for it, exactly like the situational-wire
// tolerance: no version gate, no toast, console-only as before.
//
// Pure module with injectable transport — no React, no DOM — so it is
// testable in this repo's node-environment vitest setup. Never throws: a
// logging call that breaks an export would be worse than no logging.

export interface BridgeLogDeps {
  fetchImpl?: typeof fetch;
}

const CLIENT_LOG_PATH = "/client-log";

let lastForwarded: string | null = null;
let unsupportedSession: string | null = null;

function clientLogUrl(port: number, session: string): string {
  return `http://127.0.0.1:${port}${CLIENT_LOG_PATH}?session=${encodeURIComponent(session)}`;
}

/** Forward one decision line to the bridge log. Fire-and-forget by design:
 *  the caller never awaits this and it never rejects. */
export function forwardDecisionToBridge(
  line: string,
  session: string | null,
  port: number | null,
  deps: BridgeLogDeps = {}
): void {
  if (!line || session === null || session === "" || port === null) return;
  if (line === lastForwarded) return;
  if (unsupportedSession === session) return;
  lastForwarded = line;

  const f = deps.fetchImpl ?? fetch;
  void (async () => {
    try {
      const res = await f(clientLogUrl(port, session), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: [line] }),
      });
      // An older bridge (or the PowerShell one) has no such route: stay
      // console-only for the rest of this session rather than 404ing every
      // decision. Any other outcome — including a throttled or invalid
      // answer — keeps trying, because those are transient, not structural.
      if (res.status === 404) unsupportedSession = session;
    } catch {
      /* unreachable bridge, LNA block, aborted tab — console already has it */
    }
  })();
}

/** Test-only reset — module-level dedupe state would otherwise leak between
 *  cases in the same vitest worker. */
export function __resetBridgeLogForTests(): void {
  lastForwarded = null;
  unsupportedSession = null;
}
