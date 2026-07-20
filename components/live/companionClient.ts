// ─────────────────────────────────────────────────────────────────────────────
// companionClient.ts — browser-side wire client for the companion.ps1 bridge
// (engy owns the .ps1 + the wire contract's server side; this file is the
// contract's CLIENT side — see live-companion-plan.md §5 "WIRE CONTRACT").
//
// Contract (agreed in the plan, mirrored in companion.ps1's own header
// comment): ports [48291,48292,48293]; `?session=<token>` on every
// non-OPTIONS request; exact Origin https://coachbuild.vercel.app (enforced
// server-side, nothing to do here); shapes:
//   GET  /status       -> {version, port, phase, clientConnected}
//   GET  /live         -> raw allgamedata passthrough | {error:'no-live'}
//   POST /apply-runes  -> {ok:true} | {ok:false, reason, hint?}
//
// Every network call here is fail-soft (never throws to the caller) and
// takes an injectable `deps.fetchImpl` so companionClient.test.ts can drive
// it with a mocked fetch instead of a real loopback server (the bridge is
// fundamentally untestable off a real gaming PC — see plan §5's
// "Untestable off gaming PC" note).
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANION_PORTS = [48291, 48292, 48293] as const;
export type CompanionPort = (typeof COMPANION_PORTS)[number];

/** Page-level "is there a live game" status poll cadence — deliberately much
 *  slower than the in-game /live poll (LIVE_POLL_MS below); this only needs
 *  to catch a ChampSelect->InProgress transition, not track anything
 *  frame-accurate. */
export const COMPANION_STATUS_POLL_MS = 3000;
/** In-game live-client-data poll cadence — matches the plan's "1s" spec and
 *  the community-established Live Client Data polling norm (research §B). */
export const LIVE_POLL_MS = 1000;

const SESSION_STORAGE_KEY = "coachbuild:companion:session";
const PORT_STORAGE_KEY = "coachbuild:companion:port";

export interface CompanionStatus {
  version: string;
  port: number;
  phase: string;
  clientConnected: boolean;
}

/** Result of an apply-runes call — mirrors the wire contract's own
 *  discriminated shape verbatim (no local reinterpretation) so a `reason`/
 *  `hint` string from the companion (e.g. bug #1013's delete-failed path)
 *  reaches the UI unchanged. */
export type ApplyRunesResult = { ok: true } | { ok: false; reason: string; hint?: string };

/** Raw Live Client Data passthrough (allgamedata) — deliberately typed as an
 *  open record; components/live/livePanelModel.ts is the ONLY place that
 *  reads specific fields off this, and it reads at most
 *  championName/team/position (see that file's compliance note) — never
 *  hold onto or forward this value beyond that one narrow read. */
export type LiveDataRaw = Record<string, unknown>;
export type LiveResult = LiveDataRaw | { error: string };

export function isLiveError(result: LiveResult): result is { error: string } {
  return typeof (result as { error?: unknown }).error === "string";
}

/** Which failure mode a probe hit. Chrome's Local Network Access block and a
 *  genuine "nothing listening on this port" both surface as the same
 *  `TypeError: Failed to fetch` to JS (by design — the browser doesn't leak
 *  which one it was, see research §E). We can't distinguish them from the
 *  error alone, so the caller's INTENT disambiguates: a `trigger:
 *  "user-click"` probe (the deliberate LNA-prompt moment — /live-setup's
 *  Test Connection button) that still fails is reported as `lna-denied`
 *  (the user just triggered the permission dialog, so a continued failure
 *  most likely means they denied it or it's still pending); a `"passive"`
 *  background probe (e.g. app/page.tsx's periodic phase poll, which never
 *  wants to surface its own permission prompt UX) reports the same failure
 *  as the quieter `no-companion`. This is a heuristic, not a real signal —
 *  documented here so it's never mistaken for one. */
export type ProbeState =
  | { kind: "no-companion" }
  | { kind: "lna-denied" }
  | { kind: "connected"; port: CompanionPort; status: CompanionStatus };

export type ProbeTrigger = "passive" | "user-click";

export interface CompanionClientDeps {
  fetchImpl?: typeof fetch;
}

// ── Persistence (localStorage: coachbuild:companion:session / :port) ───────

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // storage disabled (private mode, policy, etc.)
  }
}

export function getStoredSession(): string | null {
  return safeLocalStorage()?.getItem(SESSION_STORAGE_KEY) ?? null;
}

export function setStoredSession(session: string): void {
  try {
    safeLocalStorage()?.setItem(SESSION_STORAGE_KEY, session);
  } catch {
    /* quota/policy failure — session just won't persist across reloads */
  }
}

export function getStoredPort(): CompanionPort | null {
  const raw = safeLocalStorage()?.getItem(PORT_STORAGE_KEY);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return (COMPANION_PORTS as readonly number[]).includes(n) ? (n as CompanionPort) : null;
}

export function setStoredPort(port: CompanionPort): void {
  try {
    safeLocalStorage()?.setItem(PORT_STORAGE_KEY, String(port));
  } catch {
    /* ignore */
  }
}

/** Whether ANY session is currently paired — the sole gate the
 *  Apply-runes button (RunesSummonersCard) uses to decide whether to render
 *  at all. Deliberately does not verify the companion is actually reachable
 *  right now (that's what Test Connection / the status poll are for) — a
 *  stored session with a since-closed companion still shows the button, and
 *  the click itself will surface the failure via applyRunes' own result. */
export function hasSession(): boolean {
  return getStoredSession() !== null;
}

// ── Wire calls ──────────────────────────────────────────────────────────────

function bridgeUrl(port: number, path: string, session: string): string {
  return `http://127.0.0.1:${port}${path}?session=${encodeURIComponent(session)}`;
}

export async function getStatus(
  port: CompanionPort,
  session: string,
  deps: CompanionClientDeps = {}
): Promise<CompanionStatus | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(bridgeUrl(port, "/status", session), { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<CompanionStatus>;
    if (
      typeof data.version !== "string" ||
      typeof data.phase !== "string" ||
      typeof data.clientConnected !== "boolean"
    ) {
      return null; // malformed — treat exactly like unreachable
    }
    return { version: data.version, port, phase: data.phase, clientConnected: data.clientConnected };
  } catch {
    return null;
  }
}

/** Walks COMPANION_PORTS (trying a previously-known-good port first, if any)
 *  looking for a live /status response. See ProbeState's doc comment for how
 *  `trigger` affects failure classification. */
export async function probeCompanion(
  session: string,
  trigger: ProbeTrigger,
  deps: CompanionClientDeps = {}
): Promise<ProbeState> {
  const f = deps.fetchImpl ?? fetch;
  const known = getStoredPort();
  const ports: CompanionPort[] = known
    ? [known, ...COMPANION_PORTS.filter((p) => p !== known)]
    : [...COMPANION_PORTS];

  let sawTypeError = false;
  for (const port of ports) {
    try {
      const res = await f(bridgeUrl(port, "/status", session), { method: "GET" });
      if (!res.ok) continue;
      const data = (await res.json()) as Partial<CompanionStatus>;
      if (
        typeof data.version !== "string" ||
        typeof data.phase !== "string" ||
        typeof data.clientConnected !== "boolean"
      ) {
        continue;
      }
      setStoredPort(port);
      return { kind: "connected", port, status: { version: data.version, port, phase: data.phase, clientConnected: data.clientConnected } };
    } catch (err) {
      if (err instanceof TypeError) sawTypeError = true;
      // Any other thrown shape (e.g. a JSON parse error on a non-JSON 200)
      // is treated the same as "this port didn't answer" — keep walking.
    }
  }

  if (sawTypeError && trigger === "user-click") return { kind: "lna-denied" };
  return { kind: "no-companion" };
}

/** One status refresh, reusing the last-known-good port when we have one
 *  (cheap — no 3-port walk) and falling back to a full probeCompanion when
 *  that port no longer answers (companion restarted on a different port, or
 *  was closed). Always a "passive" probe — page-level polling must never
 *  itself trigger a fresh LNA prompt UX; that's Test Connection's job. */
export async function refreshStatus(session: string, deps: CompanionClientDeps = {}): Promise<ProbeState> {
  const port = getStoredPort();
  if (port != null) {
    const status = await getStatus(port, session, deps);
    if (status) return { kind: "connected", port, status };
  }
  return probeCompanion(session, "passive", deps);
}

/** Raw allgamedata passthrough (or {error:'no-live'} outside a live game).
 *  Returns null on any transport failure (port closed, session rotated,
 *  malformed response) — callers treat null exactly like {error:'no-live'}:
 *  no live panel to show, never a thrown error surfaced to the user. */
export async function getLive(
  port: CompanionPort,
  session: string,
  deps: CompanionClientDeps = {}
): Promise<LiveResult | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(bridgeUrl(port, "/live", session), { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as LiveResult;
  } catch {
    return null;
  }
}

/** POSTs a rune-page apply request. STRICTLY meant to be called from a
 *  user-clicked handler (compliance guardrail, plan §3) — this function
 *  itself has no gating opinion on that; RunesSummonersCard.tsx is
 *  responsible for only ever invoking it from an onClick. */
export async function applyRunes(
  port: CompanionPort,
  session: string,
  body: { name: string; primaryStyleId: number; subStyleId: number; selectedPerkIds: number[]; current: true },
  deps: CompanionClientDeps = {}
): Promise<ApplyRunesResult> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(bridgeUrl(port, "/apply-runes", session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean") {
      return data as ApplyRunesResult;
    }
    return { ok: false, reason: res.ok ? "malformed-response" : `http-${res.status}` };
  } catch {
    return {
      ok: false,
      reason: "network-error",
      hint: "Check the companion is still running and try again.",
    };
  }
}
