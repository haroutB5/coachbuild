// ─────────────────────────────────────────────────────────────────────────────
// components/live/mystatsAccount.ts — the browser half of My Stats
// account detection.
//
// WHY THE BROWSER IS IN THIS LOOP AT ALL. The League client listens on
// 127.0.0.1; a Vercel function cannot reach it. So the only process that can
// see BOTH the companion and the backend is the user's browser, and the flow is
// necessarily: browser reads GET /me off the companion -> browser POSTs that
// identity to /api/mystats/accounts -> server resolves the region and activates
// the account. Nothing here decides anything about the data itself; the server
// owns account state, this module just carries a message between two things only
// the browser can talk to at once.
//
// THE SECRET. That POST is a write on a publicly-reachable URL (this app has no
// user auth), and it repoints every My Stats surface plus can spend the shared
// Riot key — so it is gated by a shared secret the user enters ONCE and which
// lives in localStorage from then on. See lib/mystats/accountAuth.ts for the
// server side and why there is no unauthenticated fallback. A missing secret
// here means detection is simply INERT: no request is made, nothing breaks, and
// the active account stays exactly as it was.
//
// NO UI IN THIS FILE, on purpose. The account picker is a separate, frontend-
// owned surface; everything it needs is the contract in HANDOFF-engy.md plus the
// functions below. Keeping the data path free of JSX also keeps it testable —
// this repo has no JSX rendering harness (CLAUDE.md, Test conventions).
// ─────────────────────────────────────────────────────────────────────────────

import { getMe, type CompanionIdentity, type CompanionPort, type CompanionClientDeps } from "./companionClient";

/** Same localStorage convention as every other key in companionClient.ts. */
const ACCOUNT_SECRET_STORAGE_KEY = "coachbuild:mystats:accountSecret";

/** Must match lib/mystats/accountAuth.ts's ACCOUNT_SECRET_HEADER. Duplicated
 *  rather than imported because that module imports node:crypto and must never
 *  be pulled into a client bundle. The pair is pinned by a test that asserts
 *  the two constants are equal. */
export const ACCOUNT_SECRET_HEADER = "x-coachbuild-account-secret";

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // storage disabled (private mode, policy)
  }
}

export function getAccountSecret(): string | null {
  const raw = safeLocalStorage()?.getItem(ACCOUNT_SECRET_STORAGE_KEY) ?? null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function setAccountSecret(secret: string): void {
  try {
    safeLocalStorage()?.setItem(ACCOUNT_SECRET_STORAGE_KEY, secret.trim());
  } catch {
    /* quota/policy failure -- detection just stays inert until re-entered */
  }
}

export function clearAccountSecret(): void {
  try {
    safeLocalStorage()?.removeItem(ACCOUNT_SECRET_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function hasAccountSecret(): boolean {
  return getAccountSecret() !== null;
}

/** One entry in the picker list — mirrors lib/mystats/account.ts's
 *  MyAccountSummary exactly (the server's shape is the contract; this is the
 *  client's view of the same fields). Deliberately carries no puuid. */
export interface AccountSummary {
  id: number;
  riotId: string;
  gameName: string;
  tagLine: string;
  region: string;
  active: boolean;
  lastSeenAt: string | null;
  games: number;

  // ── Ranked solo/duo standing (2026-07-30, engy — HANDOFF-engy.md §1a) ─────
  // Mirrors lib/mystats/rank.ts's AccountRank exactly. Solo queue only; flex is
  // not fetched, not stored, and would arrive under separate `flex*` names.
  //
  // READ `rankUnknown` FIRST — it is the discriminator, and the whole reason
  // these are seven fields rather than three:
  //   rankUnknown === false -> tier/division/lp are the truth, and a NULL tier
  //                            means GENUINELY UNRANKED. Render "Unranked".
  //   rankUnknown === true  -> every field below is null and means NOTHING.
  //                            Render a placeholder, never an unranked badge.
  // Rendering a blank tier badge on rankUnknown is the confidently-wrong-blank
  // this pair exists to prevent.
  /** "IRON".."CHALLENGER", uppercase, as Riot spells it. */
  tier: string | null;
  /** "I".."IV". Riot sends "I" for MASTER/GRANDMASTER/CHALLENGER where it means
   *  nothing — forwarded verbatim, and the UI declines to render it there. */
  division: string | null;
  lp: number | null;
  rankWins: number | null;
  rankLosses: number | null;
  rankUnknown: boolean;
  /** ISO of the last SUCCESSFUL read from Riot, null when there has never been
   *  one. Lets a surface say "as of 14:05" instead of implying it is live. */
  rankCheckedAt: string | null;
}

export interface AccountsMutationResult {
  accounts: AccountSummary[];
  activeId: number | null;
  riotId: string | null;
  created: boolean;
  /** The active account actually CHANGED. A caller seeing this must re-fetch
   *  /api/mystats/summary — every number on it is account-scoped and has just
   *  changed meaning. */
  switched: boolean;
}

export type AccountsCallOutcome =
  | { ok: true; result: AccountsMutationResult }
  /** No secret stored — detection is inert, NOT failed. Distinct from
   *  `unauthorized` (a wrong secret) so a UI can prompt for entry rather than
   *  report an error the user cannot act on. */
  | { ok: false; reason: "no-secret" }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "not-configured" }
  | { ok: false; reason: "no-such-account" }
  | { ok: false; reason: "region-unresolved" }
  | { ok: false; reason: "network-error" }
  | { ok: false; reason: string };

async function postAccounts(body: unknown, deps: CompanionClientDeps = {}): Promise<AccountsCallOutcome> {
  const secret = getAccountSecret();
  if (!secret) return { ok: false, reason: "no-secret" };
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f("/api/mystats/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACCOUNT_SECRET_HEADER]: secret },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "network-error" };
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const reason = typeof data?.error === "string" ? data.error : `http-${res.status}`;
    return { ok: false, reason };
  }
  if (!data || !Array.isArray(data.accounts)) return { ok: false, reason: "malformed-response" };
  return {
    ok: true,
    result: {
      accounts: data.accounts as AccountSummary[],
      activeId: typeof data.activeId === "number" ? data.activeId : null,
      riotId: typeof data.riotId === "string" ? data.riotId : null,
      created: data.created === true,
      switched: data.switched === true,
    },
  };
}

/** PURE. Whether an identity read off the companion is worth POSTing.
 *
 *  The point is to avoid a pointless write on every single page view. `activeRiotId`
 *  is what /api/mystats/summary already reported, so when the companion agrees with
 *  it there is nothing to change and the request is skipped entirely.
 *
 *  NOTE what this does NOT try to be: a correctness guard. A skipped report can
 *  only ever mean "the active account already displays this name", and the server
 *  is idempotent for a re-report anyway (an already-linked puuid costs zero Riot
 *  calls). The one case it deliberately does NOT skip is a name it has not seen —
 *  including a RENAME of the active account, which must reach the server so the
 *  stored riot_id is refreshed. */
export function shouldReportIdentity(
  detected: CompanionIdentity | null,
  activeRiotId: string | null
): boolean {
  if (!detected) return false;
  if (!activeRiotId) return true; // nothing active yet -- always worth linking
  return `${detected.gameName}#${detected.tagLine}` !== activeRiotId;
}

/**
 * Reads the identity off the companion and reports it, linking + activating that
 * account server-side.
 *
 * Every no-op path is silent by design — no companion, a companion older than
 * 1.10.0, a closed League client, no stored secret, or an identity that already
 * matches the active account all return without a request and without an error.
 * This feature only ever REFINES which account is shown; it must never be the
 * reason My Stats shows an error banner.
 *
 * Pass `activeRiotId` (from /api/mystats/summary's `riotId`) to get the skip
 * behaviour; pass null to force a report.
 */
export async function detectAndReportAccount(
  port: CompanionPort,
  session: string,
  activeRiotId: string | null,
  deps: CompanionClientDeps = {}
): Promise<AccountsCallOutcome | { ok: false; reason: "nothing-to-report" }> {
  const identity = await getMe(port, session, deps);
  if (!shouldReportIdentity(identity, activeRiotId)) return { ok: false, reason: "nothing-to-report" };
  return postAccounts(
    // No puuid. The one GET /me hands back is the LCU's 36-char local UUID,
    // which Riot rejects; the server re-resolves from the Riot ID instead.
    { mode: "detect", gameName: identity!.gameName, tagLine: identity!.tagLine },
    deps
  );
}

/** Switches to an already-linked account by its local id. Never touches the
 *  companion and never spends a Riot call. */
export async function selectAccount(
  id: number,
  deps: CompanionClientDeps = {}
): Promise<AccountsCallOutcome> {
  return postAccounts({ mode: "select", id }, deps);
}

/** The picker's read. Open (not secret-gated) — same exposure class as
 *  /api/mystats/summary, which has always served this user's own history
 *  openly; see lib/mystats/accountAuth.ts's header for the read/write
 *  asymmetry. Returns null on any failure rather than throwing. */
export async function fetchAccounts(
  deps: CompanionClientDeps = {}
): Promise<{ accounts: AccountSummary[]; activeId: number | null } | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f("/api/mystats/accounts", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (!Array.isArray(data.accounts)) return null;
    return {
      accounts: data.accounts as AccountSummary[],
      activeId: typeof data.activeId === "number" ? data.activeId : null,
    };
  } catch {
    return null;
  }
}
