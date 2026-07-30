// ─────────────────────────────────────────────────────────────────────────────
// components/hextech/mystats/accountPicker.ts — every DECISION the My Stats
// account picker makes, as pure functions.
//
// The component (AccountPicker.tsx) owns the DOM half only: focus, class names,
// preventDefault. Same split, and for the same reason, as
// HextechTabs.tsx/tabKeyboard.ts — this repo has no JSX render harness (see
// CLAUDE.md's Test conventions), so a rule written inline in a component is
// testable only through a browser. Everything below is therefore unit-tested,
// including the one behaviour that actually matters:
//
//   ON `switched: true`, THE SUMMARY MUST BE RE-FETCHED.
//
// `switchAccount`/`linkDetectedAccount` own that, not the component, so the
// invariant is asserted by a test rather than by reading JSX. Every number on
// /mystats is scoped to the active account (my_matches is keyed by puuid,
// migration 0020), so a switch does not change the numbers — it changes what
// they MEAN. Patching the active flag locally and leaving the old figures on
// screen would produce exactly the failure the backend change exists to
// prevent: a confident, plausible, wrong number belonging to a different
// player (see HANDOFF-engy.md §5c — scoped adherence returns null and renders
// "—", unscoped returns a confident 0.0%).
//
// NO PUUID, ANYWHERE IN HERE. The picker switches by the opaque local `id` the
// account table already holds. The one flow that carries a puuid — linking a
// newly-detected account — delegates to detectAndReportAccount, which re-reads
// GET /me itself; so the identifier never lands in React state or in any type
// this module declares. See HANDOFF-engy.md §1a.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountSummary, AccountsCallOutcome } from "@/components/live/mystatsAccount";

// ── Keyboard: a VERTICAL menu, sibling to tabKeyboard.ts's horizontal tablist ──
//
// Deliberately a sibling rather than a reuse. tabKeyboard.ts owns
// ArrowLeft/ArrowRight and documents excluding the vertical arrows on purpose
// (swallowing them would break scrolling for the keyboard user it exists for) —
// this control needs exactly the arrows that one refuses. The shared parts (wrap
// at both ends, an out-of-range index resolving to a valid destination rather
// than NaN, and `isMenuNavigationKey` existing so the resolver and the
// component's preventDefault can never disagree about which keys the control
// owns) are matched deliberately, so the two behave the same everywhere they
// overlap.
//
// The OTHER half of the standard is inverted here, and that is the point:
// HextechTabs uses automatic activation (selection follows focus) because
// revealing a tab panel is instantaneous and free. Activating a row here fires a
// write that repoints every number on the page. So this menu uses MANUAL
// activation: the arrows move focus only, Enter/Space commits. WAI-ARIA
// prescribes exactly that split.
const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** The index focus should move to, or null to let the key through untouched. */
export function resolveMenuKeydown(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (!MENU_KEYS.has(key)) return null;
  const safe = index >= 0 && index < count ? index : 0;
  switch (key) {
    case "ArrowDown":
      return (safe + 1) % count;
    case "ArrowUp":
      return (safe - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Whether `resolveMenuKeydown` will act on this key — the component's
 *  `preventDefault` gate, so the two cannot disagree. */
export function isMenuNavigationKey(key: string): boolean {
  return MENU_KEYS.has(key);
}

// ── What the picker renders at all ───────────────────────────────────────────

/**
 * `single` is a deliberate, distinct mode, not a degenerate `menu`.
 *
 * A control whose only option is the option already selected is a dead control:
 * it opens, shows one row, and the row can do nothing. That reads as a broken
 * menu, and it invites a click that cannot have an effect. So with one linked
 * account the picker renders a plain labelled line instead — no trigger, no
 * chevron, nothing to open. The INFORMATION still earns its place (region and
 * stored game count are not on the page anywhere else), the affordance does not.
 * It upgrades to `menu` the moment a second account is linked, which detection
 * does on its own.
 */
export type PickerMode = "empty" | "single" | "menu";

export function pickerModeFor(accounts: readonly AccountSummary[]): PickerMode {
  if (accounts.length === 0) return "empty";
  return accounts.length === 1 ? "single" : "menu";
}

// ── Row shaping ──────────────────────────────────────────────────────────────

/**
 * Relative "last seen", or null when there is nothing honest to say.
 *
 * null covers a never-seen account (`lastSeenAt: null`, e.g. one seeded from
 * MY_RIOT_ID before the companion ever reported it) AND an unparseable value.
 * The caller omits the segment entirely rather than printing "never" —
 * "never seen" is a fact about our own detection plumbing, not about the
 * account, and it would read as a warning about the account.
 *
 * A future timestamp (clock skew between the user's machine and the server) is
 * clamped to "just now" rather than rendered as a negative age.
 */
export function formatLastSeen(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const deltaMs = nowMs - t;
  if (deltaMs < 60_000) return "just now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

export interface AccountRowView {
  id: number;
  riotId: string;
  active: boolean;
  /** Region · N games · seen Xh ago — only the segments that say something. */
  meta: string;
  /** Screen-reader sentence for the row. The visual meta line is a middot-
   *  separated fragment, which a screen reader reads as one run-on string. */
  srLabel: string;
}

/**
 * One row's display fields.
 *
 * `games` is the STORED match count for the account, not a career total —
 * CoachBuild has already shipped a bug from two denominators drifting (v0.73.1),
 * so the word "stored" is in the accessible label and the tooltip. It is worth
 * showing regardless: it is the one number that tells the user whether the
 * account they are about to switch to has anything ingested yet, which is
 * exactly the question a fresh account raises.
 */
export function buildAccountRow(a: AccountSummary, nowMs: number): AccountRowView {
  const seen = formatLastSeen(a.lastSeenAt, nowMs);
  const games = `${a.games} ${a.games === 1 ? "game" : "games"}`;
  const parts = [a.region, games];
  if (seen) parts.push(`seen ${seen}`);
  const srParts = [`region ${a.region}`, `${games} stored`];
  if (seen) srParts.push(`last seen ${seen}`);
  return {
    id: a.id,
    riotId: a.riotId,
    active: a.active,
    meta: parts.join(" · "),
    srLabel: `${a.riotId}, ${srParts.join(", ")}${a.active ? ", currently active" : ""}`,
  };
}

export function buildAccountRows(accounts: readonly AccountSummary[], nowMs: number): AccountRowView[] {
  // No re-sort: the server already returns active-first, then lastSeenAt desc,
  // then id (HANDOFF-engy.md §1b). Re-ordering here would drift from that.
  return accounts.map((a) => buildAccountRow(a, nowMs));
}

// ── The companion-detection prompt ───────────────────────────────────────────

/** Just the display half of an identity read off GET /me. The puuid is
 *  deliberately not carried — see this file's header. */
export interface DetectedIdentity {
  gameName: string;
  tagLine: string;
}

export type DetectPrompt =
  | { kind: "none" }
  /** The client's account IS linked but is not the active one — a switch, by
   *  opaque id, no Riot call and no puuid. */
  | { kind: "switch"; id: number; riotId: string }
  /** Not linked yet — needs the detect POST, which carries the puuid and may
   *  spend one Riot call to resolve the region. */
  | { kind: "link"; riotId: string };

/**
 * What to OFFER after reading the League client's identity. It never decides to
 * act.
 *
 * The user's account is never switched for them. Silently repointing every
 * number on the page because a different client happened to be open is exactly
 * the surprise this app avoids — and it would be worse than a stale label,
 * because the numbers stay confident while their meaning changes underneath.
 *
 * Returns `none` when there is nothing to offer: no identity read (no companion,
 * a pre-1.10.0 companion, a closed client, a malformed payload — getMe collapses
 * all of those to null), or the client already matches the active account.
 */
export function resolveDetectPrompt(
  detected: DetectedIdentity | null,
  accounts: readonly AccountSummary[],
  activeRiotId: string | null
): DetectPrompt {
  if (!detected) return { kind: "none" };
  const riotId = `${detected.gameName}#${detected.tagLine}`;
  if (activeRiotId !== null && riotId === activeRiotId) return { kind: "none" };
  const linked = accounts.find((a) => a.riotId === riotId);
  if (linked) {
    // Guard against a list that disagrees with `activeRiotId` (a summary
    // response mid-flight): offering a "switch" to the row already flagged
    // active would be a no-op button.
    if (linked.active) return { kind: "none" };
    return { kind: "switch", id: linked.id, riotId };
  }
  return { kind: "link", riotId };
}

// ── Failure messages ─────────────────────────────────────────────────────────

/**
 * The user-facing sentence for a failed write. Honest about which of the three
 * genuinely different things went wrong, because the fix differs: a rejected
 * secret needs re-entry, an unset server secret needs a deploy, and a Riot-side
 * failure just needs retrying.
 *
 * Never echoes the secret, and never a raw status code — an unrecognised reason
 * gets generic text plus the reason token, which is enough to report without
 * pretending to diagnose.
 */
export function pickerFailureMessage(reason: string): string {
  switch (reason) {
    case "no-secret":
      return "Enter your account secret to switch accounts.";
    case "unauthorized":
      return "That account secret was rejected. Re-enter it to switch accounts.";
    case "not-configured":
      return "The server has no account secret set, so switching is disabled.";
    case "no-such-account":
      return "That account is no longer linked. Reload to see the current list.";
    case "region-unresolved":
      return "Riot didn't say which server that account plays on, so it wasn't linked. Nothing changed — try again.";
    case "riot-unavailable":
      return "Riot's API didn't answer, so the account wasn't linked. Nothing changed — try again.";
    case "network-error":
      return "Couldn't reach the server. Nothing changed — try again.";
    case "malformed-response":
      return "The server's answer couldn't be read. Nothing changed — try again.";
    default:
      return `Couldn't switch accounts (${reason}).`;
  }
}

/** A rejected or absent secret is the one failure class the user can fix from
 *  the picker, so it re-opens the secret field rather than only printing a
 *  message. */
export function failureNeedsSecret(reason: string): boolean {
  return reason === "no-secret" || reason === "unauthorized";
}

// ── The mutation orchestrators (where the re-fetch invariant lives) ──────────

export interface AccountMutationDeps {
  /** Injected so the invariant below is testable without a network or a DOM. */
  select: (id: number) => Promise<AccountsCallOutcome>;
  /** Called EXACTLY when the active account changed, i.e. when every number on
   *  /mystats has just changed meaning. Must re-fetch /api/mystats/summary. */
  refetchSummary: () => void;
}

export type AccountMutationResult =
  | {
      status: "ok";
      accounts: AccountSummary[];
      activeId: number | null;
      riotId: string | null;
      /** True exactly when refetchSummary was called. */
      switched: boolean;
      created: boolean;
    }
  | { status: "failed"; reason: string };

/**
 * The shared tail of every write: hand back the fresh list, and — if and only if
 * the active account actually changed — trigger the summary re-fetch.
 *
 * The returned `accounts` array is safe to render immediately: it is the LIST's
 * truth (which account is active), which is a different question from the
 * STATS' truth (what the numbers mean). The caller must not render the two from
 * different generations, so on `switched: true` it puts the stats panels back
 * into their loading state until the re-fetch lands. Showing the new name beside
 * the old account's win rate is the precise confidently-wrong-numbers failure
 * this whole change exists to prevent.
 */
function applyOutcome(outcome: AccountsCallOutcome, deps: AccountMutationDeps): AccountMutationResult {
  if (!outcome.ok) return { status: "failed", reason: outcome.reason };
  const { accounts, activeId, riotId, switched, created } = outcome.result;
  if (switched) deps.refetchSummary();
  return { status: "ok", accounts, activeId, riotId, switched, created };
}

/** Switch to an already-linked account by its opaque id. Never touches the
 *  companion, never spends a Riot call, never sees a puuid. */
export async function switchAccount(id: number, deps: AccountMutationDeps): Promise<AccountMutationResult> {
  return applyOutcome(await deps.select(id), deps);
}

export interface LinkMutationDeps extends AccountMutationDeps {
  /** Re-reads GET /me and POSTs the detect body. Injected for the same reason
   *  as `select`, and kept as a callback so the puuid it carries stays inside
   *  detectAndReportAccount instead of crossing into component state. */
  link: () => Promise<AccountsCallOutcome | { ok: false; reason: string }>;
}

/**
 * Link (and activate) the account the League client is logged into. Only ever
 * called from a real click — see resolveDetectPrompt's doc comment.
 *
 * `nothing-to-report` is a real outcome, not an error: between rendering the
 * prompt and the click, the client may have closed or the identity may have
 * come to match the active account. It reports as a failure with that reason so
 * the caller can clear the prompt without claiming success.
 */
export async function linkDetectedAccount(deps: LinkMutationDeps): Promise<AccountMutationResult> {
  const outcome = await deps.link();
  if (!outcome.ok) return { status: "failed", reason: outcome.reason };
  return applyOutcome(outcome as AccountsCallOutcome, deps);
}
