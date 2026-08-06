"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AccountPicker — which linked Riot account /mystats is showing, and how to
// change it. Backend contract: HANDOFF-engy.md §1 (migration 0020).
//
// The DOM half only. Every decision — keyboard destinations, what a row says,
// whether to offer a detected account, and the re-fetch-on-switch invariant —
// lives in accountPickerModel.ts as pure, unit-tested functions, because this repo
// has no JSX render harness (CLAUDE.md, Test conventions).
//
// THREE THINGS, ONE SURFACE:
//
//  1. THE LIST. Renders per `pickerModeFor`: a plain labelled line for one
//     account (a menu with one unclickable row is a broken control — see that
//     function's doc comment), a real menu for two or more, and a link
//     invitation when nothing is linked yet.
//  2. DETECTION. One read of the companion's GET /me per page load, no polling.
//     It OFFERS; it never switches. Silently repointing every number on the page
//     because a different client happened to be open is the surprise this app
//     avoids, and it is worse than a stale label because the numbers stay
//     confident while their meaning changes underneath.
//  3. THE SECRET. POST /api/mystats/accounts fails closed without it (it is a
//     write on a URL with no user auth), so the browser has to carry it. Entered
//     once, kept in localStorage, and treated as the bearer token it is: never
//     logged, never in a URL or query string, never rendered back after entry
//     (the field is write-only — it is not pre-filled from storage, and there is
//     no reveal). Missing or rejected makes the picker VISIBLY read-only rather
//     than throwing on click.
//
// A11Y. The list is a menu of commands (`menuitemradio` — each row both reports
// and sets which account is active), with a roving tab stop so the whole control
// is ONE stop in the page tab order; arrows move, Home/End jump, both wrapping;
// Escape closes and returns focus to the trigger. This matches the standard
// v0.81.0 set for the tab strip (HextechTabs.tsx + tabKeyboard.ts) with ONE
// deliberate inversion: activation is MANUAL, not automatic. The tab strip can
// select-on-focus because revealing a panel is instantaneous and free; arrowing
// across THIS control would fire a write per key.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { useCompanion } from "@/components/live/CompanionProvider";
import { getMe, getStoredPort } from "@/components/live/companionClient";
import {
  detectAndReportAccount,
  hasAccountSecret,
  selectAccount,
  setAccountSecret,
  clearAccountSecret,
  type AccountSummary,
} from "@/components/live/mystatsAccount";
import {
  buildAccountRows,
  failureNeedsSecret,
  isMenuNavigationKey,
  linkDetectedAccount,
  pickerFailureMessage,
  pickerModeFor,
  resolveDetectPrompt,
  resolveMenuKeydown,
  switchAccount,
  type AccountMutationDeps,
  type AccountMutationResult,
  type DetectPrompt,
} from "./accountPickerModel";

export interface AccountPickerProps {
  /** `summary.accounts` — active first. Shipped on the summary response on
   *  purpose, so this costs no extra round trip and can never disagree with the
   *  stats beside it (HANDOFF-engy.md §1b). */
  accounts: AccountSummary[];
  /** `summary.riotId` — the ACTIVE account's tag, null when unresolved. */
  activeRiotId: string | null;
  /** `summary.accountId`. */
  activeId: number | null;
  /**
   * Called when the active account CHANGED. The page must re-fetch
   * /api/mystats/summary AND stop rendering the old figures — every number on
   * the page is account-scoped and has just changed meaning. This is passed
   * straight to `switchAccount`'s `refetchSummary`, which calls it if and only
   * if the server reported `switched: true`.
   */
  onSwitched: (riotId: string | null) => void;
  /**
   * The Riot ID the League client is actually signed in as, reported once per
   * page load, or null when we could not tell (no companion, a pre-1.10.0
   * companion's 404, a closed client).
   *
   * WHY THE PAGE NEEDS THIS AND NOT JUST THIS COMPONENT. The hero's `LIVE` ring
   * and "In a game now." are driven by the companion's gameflow phase, which
   * says only that THE CLIENT is in a game — never whose. With two linked
   * accounts those are different questions, and v0.84.x painted a live K1ayer
   * game onto MunsterHunter's hero: a true fact attached to the wrong subject,
   * which is the same defect class as an unscoped number. This component
   * already performs the one `/me` read per load, so it reports the answer
   * upward rather than the page duplicating a call the shared Riot-adjacent
   * budget does not need.
   */
  onIdentityDetected?: (riotId: string | null) => void;
  /**
   * Render as a bare prompt instead of a full panel (2026-07-30 user directive:
   * "the linked accounts bar remove it and just make it into a small link next
   * to the accounts").
   *
   * WHAT COLLAPSED STILL RENDERS, AND WHY IT IS NOT NOTHING. The routine job of
   * this panel — pick a different linked account — moved onto the account CARDS,
   * which have done it through the same `switchAccount` since v0.85.0. What did
   * NOT move are the two things the cards cannot do:
   *
   *   · THE MISMATCH PROMPT ("your client is signed in as X, not the account
   *     shown"). This is the only surface in the app that says it — v0.84.3
   *     deliberately made the hero silent about client identity — and it is
   *     news, arriving unprompted, about a state the user did not choose. Hiding
   *     news behind a disclosure is how it stops being news, so it renders
   *     INLINE and always, collapsed or not.
   *   · THE SECRET. Occasional and user-initiated, so it lives behind the
   *     disclosure — except when a blocked prompt needs it, which is why
   *     `onRequestExpand` exists.
   *
   * The component stays MOUNTED while collapsed. That is load-bearing: the
   * once-per-load `/me` detection read, `onIdentityDetected` (which the hero's
   * live-attribution rule depends on) and the secret state all live here, and
   * unmounting to "save" a panel would silently switch the detection off.
   */
  collapsed?: boolean;
  /** Called when a COLLAPSED picker needs its full surface — i.e. the user hit
   *  something that requires the secret field. The page opens the disclosure;
   *  this component opens the field inside it. */
  onRequestExpand?: () => void;
}

/**
 * Detection is once per PAGE LOAD, module-scoped rather than per-mount.
 *
 * A ref would re-run on every client-side nav back to /mystats, and remount is
 * not new information — the answer to "who is logged into the client" cannot
 * have usefully changed in the seconds a route change takes. Explicitly NOT a
 * poll: /me is one LCU read per call and this feature does not need a live feed.
 */
let detectRanThisLoad = false;

/** Test-only reset. Not called by app code. */
export function __resetDetectionForTests(): void {
  detectRanThisLoad = false;
}

type SecretState = "unknown" | "missing" | "present" | "rejected";

export default function AccountPicker({
  accounts,
  activeRiotId,
  activeId,
  onSwitched,
  onIdentityDetected,
  collapsed = false,
  onRequestExpand,
}: AccountPickerProps) {
  const { session } = useCompanion();

  // Seeded from the summary, then owned locally so a successful write can show
  // the new active row immediately — the LIST's truth arrives with the POST
  // response. The STATS' truth arrives with the summary re-fetch, and the page
  // blanks them until it does; the two are never rendered from different
  // generations.
  const [rows, setRows] = useState<AccountSummary[]>(accounts);
  const [rowsSource, setRowsSource] = useState(accounts);
  if (accounts !== rowsSource) {
    setRowsSource(accounts);
    setRows(accounts);
  }

  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<DetectPrompt>({ kind: "none" });
  const [promptDismissed, setPromptDismissed] = useState(false);

  // "unknown" on the first paint, on both server and client: reading
  // localStorage during render is a hydration mismatch, which is a live failure
  // mode in this app. It resolves in the effect below, before any interaction.
  const [secretState, setSecretState] = useState<SecretState>("unknown");
  const [secretOpen, setSecretOpen] = useState(false);
  const [secretDraft, setSecretDraft] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const secretInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Account-secret storage is intentionally read after hydration to preserve SSR markup.
    setSecretState(hasAccountSecret() ? "present" : "missing");
  }, []);

  const canWrite = secretState === "present" || secretState === "unknown";
  const mode = pickerModeFor(rows);
  // A stable clock per render pass, so every row's "seen 3h ago" is measured
  // from the same instant. `Date.now()` in the map would drift between rows and
  // re-read on every keystroke.
  const [nowMs] = useState(() => Date.now());
  const views = buildAccountRows(rows, nowMs);
  const activeView = views.find((v) => v.active) ?? null;

  // ── The mutation deps: ONE construction site, so no path can lose the
  //    re-fetch. `refetchSummary` is called by switchAccount/linkDetectedAccount
  //    exactly when the server said `switched: true`.
  const mutationDeps = useCallback(
    (nextRiotIdRef: { current: string | null }): AccountMutationDeps => ({
      select: (id) => selectAccount(id),
      refetchSummary: () => onSwitched(nextRiotIdRef.current),
    }),
    [onSwitched]
  );

  function applyResult(result: AccountMutationResult): void {
    if (result.status === "failed") {
      setError(pickerFailureMessage(result.reason));
      if (failureNeedsSecret(result.reason)) {
        if (result.reason === "unauthorized") {
          // A rejected secret is worse than no secret: it will keep being
          // rejected. Drop it so the picker's read-only state is honest and the
          // field comes back empty rather than pre-filled with a bad value.
          clearAccountSecret();
          setSecretState("rejected");
        }
        setSecretOpen(true);
      }
      return;
    }
    setError(null);
    setRows(result.accounts);
    setSecretState("present"); // a 200 proves the stored secret is accepted
    if (result.switched) setPrompt({ kind: "none" });
  }

  async function runSwitch(id: number, riotId: string | null): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const ref = { current: riotId };
      applyResult(await switchAccount(id, mutationDeps(ref)));
    } finally {
      setBusy(false);
    }
  }

  async function runLink(riotId: string): Promise<void> {
    if (busy || !session) return;
    const port = getStoredPort();
    if (!port) return;
    setBusy(true);
    try {
      const ref = { current: riotId };
      // detectAndReportAccount re-reads GET /me and POSTs the detect body, so
      // the puuid never enters this component's state. `activeRiotId: null`
      // forces the report — the user just asked for it explicitly.
      const result = await linkDetectedAccount({
        ...mutationDeps(ref),
        link: () => detectAndReportAccount(port, session, null),
      });
      applyResult(result);
      if (result.status === "ok") setPrompt({ kind: "none" });
    } finally {
      setBusy(false);
    }
  }

  // ── Companion detection: one read, no poll, offer only ─────────────────────
  //
  // Read through refs rather than captured props so the once-per-load read
  // always resolves against the CURRENT list, whatever order the summary and the
  // companion session happen to arrive in.
  const accountsRef = useRef(accounts);
  const activeRiotIdRef = useRef(activeRiotId);
  // Ref, not a dependency: the detection effect is keyed on `session` alone so
  // it fires exactly once per load, and taking the callback as a dep would
  // re-run the /me read every time the page re-renders with a new closure.
  const onIdentityDetectedRef = useRef(onIdentityDetected);
  useEffect(() => {
    accountsRef.current = accounts;
    activeRiotIdRef.current = activeRiotId;
    onIdentityDetectedRef.current = onIdentityDetected;
  }, [accounts, activeRiotId, onIdentityDetected]);
  // NOT a per-effect `cancelled` closure, and this is load-bearing. React
  // StrictMode double-invokes effects in dev (mount -> cleanup -> mount): the
  // module-level once-per-load guard makes the second run a no-op, and a
  // `cancelled` flag set by the FIRST run's cleanup would then discard the only
  // in-flight read, so the prompt never appeared at all. Verified in a browser,
  // not reasoned about — it is exactly the trap MyStatsRefresher.tsx documents,
  // and this component fell into it. mountedRef flips back to true on the real
  // mount, so the discarded render's read still lands; it stays false only on a
  // genuine unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    if (!detectRanThisLoad && session) {
      const port = getStoredPort();
      if (port) {
        detectRanThisLoad = true;
        // getMe returns null for EVERY non-identity outcome — no companion, a
        // pre-1.10.0 companion's 404, a closed client, a malformed body. All of
        // them mean "nothing to offer", so there is no error path to render
        // here. This feature only refines which account is shown; it must never
        // be the reason My Stats shows an error banner.
        void getMe(port, session).then((identity) => {
          if (!mountedRef.current) return;
          // Reported on BOTH branches, and null is a real answer meaning "we
          // could not tell". The hero uses it to decide whether a live game
          // belongs to the account on screen, and "unknown" must not read as
          // "matches" — see onIdentityDetected's doc comment.
          onIdentityDetectedRef.current?.(
            identity ? `${identity.gameName}#${identity.tagLine}` : null
          );
          if (!identity) return;
          setPrompt(
            resolveDetectPrompt(
              { gameName: identity.gameName, tagLine: identity.tagLine },
              accountsRef.current,
              activeRiotIdRef.current
            )
          );
        });
      }
    }
    return () => {
      mountedRef.current = false;
    };
    // Keyed on `session` only: one read on the first tick where a session
    // exists. Re-running on every summary change would be the poll this
    // deliberately is not.
  }, [session]);

  // ── Menu open/close plumbing ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    rowRefs.current[focusIndex]?.focus();
    // focusIndex is set at open time and by the arrow handler; both want focus
    // moved, so one effect covers both.
  }, [open, focusIndex]);

  function openMenu(): void {
    const activeIdx = views.findIndex((v) => v.active);
    setFocusIndex(activeIdx >= 0 ? activeIdx : 0);
    setOpen(true);
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (!isMenuNavigationKey(e.key)) return;
    const next = resolveMenuKeydown(e.key, index, views.length);
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
  }

  function submitSecret(e: React.FormEvent): void {
    e.preventDefault();
    const value = secretDraft.trim();
    if (value.length === 0) return;
    setAccountSecret(value);
    setSecretDraft(""); // never held in state longer than the submit
    setSecretState("present");
    setSecretOpen(false);
    setError(null);
    // Verify it, if there is a harmless way to: re-selecting the account that is
    // ALREADY active is a write that changes nothing (the server answers
    // switched:false, so no re-fetch fires) but does exercise the exact auth
    // path. A wrong secret therefore surfaces here instead of on the user's
    // next real switch.
    if (activeId !== null) {
      void (async () => {
        const ref = { current: activeRiotId };
        applyResult(await switchAccount(activeId, mutationDeps(ref)));
      })();
    }
  }

  // ── Shared bits ────────────────────────────────────────────────────────────

  // Only in `menu` mode. With one linked account (or none) there is nothing to
  // switch BETWEEN, so "switching is read-only" would be a warning about a
  // capability the surface isn't offering — noise on the most common state. The
  // secret entry itself stays available, because linking a second account needs
  // it.
  // …and not while the field is open: the red failure line above plus a visible
  // input already say it. Two sentences saying "rejected" is the same fact twice.
  const readOnlyNote = !canWrite && mode === "menu" && !secretOpen ? (
    <p className="text-[11px] text-mut">
      {secretState === "rejected"
        ? "That account secret was rejected — switching is read-only until it's re-entered."
        : "Switching is read-only until you enter your account secret."}
    </p>
  ) : null;

  const secretForm = secretOpen ? (
    <form onSubmit={submitSecret} className="mt-2.5 flex flex-wrap items-center gap-2">
      <label htmlFor="mystats-account-secret" className="sr-only">
        Account secret
      </label>
      <input
        ref={secretInputRef}
        id="mystats-account-secret"
        name="mystats-account-secret"
        type="password"
        value={secretDraft}
        onChange={(e) => setSecretDraft(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="Account secret"
        className="min-h-[44px] flex-1 min-w-0 sm:min-w-[220px] rounded-lg bg-black/30 border border-line px-3 text-[13px] text-txt placeholder:text-mut focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      />
      <button
        type="submit"
        disabled={secretDraft.trim().length === 0}
        className="min-h-[44px] px-3.5 rounded-lg border border-line-gold bg-panel2 text-[12px] font-semibold uppercase tracking-[0.06em] text-teal transition-colors motion-reduce:transition-none hover:bg-panel2/70 active:scale-[0.97] motion-reduce:active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          setSecretDraft("");
          setSecretOpen(false);
        }}
        className="min-h-[44px] px-3 rounded-lg text-[12px] font-medium text-mut hover:text-txt transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Cancel
      </button>
      <p className="basis-full text-[10.5px] text-mut">
        Stored in this browser only, and never shown again after you save it. It&apos;s the value of{" "}
        <code className="text-txt/80">MYSTATS_ACCOUNT_SECRET</code> on the server.
      </p>
    </form>
  ) : null;

  /** Open the secret field, expanding the panel first if it is collapsed. ONE
   *  entry point, so no path can open the field into a hidden panel. */
  function openSecret(): void {
    onRequestExpand?.();
    setSecretOpen(true);
    // Focus after paint — the input does not exist yet on this tick, and when
    // the panel was collapsed neither did its container.
    requestAnimationFrame(() => secretInputRef.current?.focus());
  }

  const secretLink =
    !secretOpen && (mode !== "empty" || prompt.kind !== "none") ? (
      <button
        type="button"
        onClick={openSecret}
        className="min-h-[44px] -my-2 text-left text-[11px] font-medium text-teal/90 hover:text-teal underline decoration-dotted underline-offset-2 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
      >
        {canWrite ? "Change account secret" : "Enter account secret"}
      </button>
    ) : null;

  // ── The detection prompt ───────────────────────────────────────────────────
  const promptBlock =
    prompt.kind !== "none" && !promptDismissed ? (
      // `mt-0` when collapsed: there is no panel above it to sit under, it IS
      // the surface. The page's own `space-y` handles the gap there.
      <div
        data-testid="mystats-detect-prompt"
        className={`${collapsed ? "" : "mt-2.5 "}flex flex-wrap items-center gap-2 rounded-lg border border-line-gold/70 bg-panel2/60 px-3 py-2`}
      >
        <p className="basis-full sm:basis-auto sm:flex-1 text-[11.5px] text-txt">
          Your League client is signed in as{" "}
          <span className="font-semibold tabular-nums">{prompt.riotId}</span>
          {prompt.kind === "link" ? " — not linked yet." : " — not the account shown."}
        </p>
        <button
          type="button"
          disabled={busy || !canWrite}
          onClick={() => (prompt.kind === "switch" ? runSwitch(prompt.id, prompt.riotId) : runLink(prompt.riotId))}
          className="min-h-[44px] px-3 rounded-lg border border-line-gold bg-panel2 text-[12px] font-semibold uppercase tracking-[0.06em] text-teal transition-colors motion-reduce:transition-none hover:bg-panel2/70 active:scale-[0.97] motion-reduce:active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {prompt.kind === "switch" ? "Switch to it" : "Link it"}
        </button>
        <button
          type="button"
          onClick={() => setPromptDismissed(true)}
          className="min-h-[44px] px-2.5 rounded-lg text-[12px] font-medium text-mut hover:text-txt transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Not now
        </button>
        {/* A prompt whose only button is disabled is a dead end, and with the
            panel collapsed the secret field it needs is off screen. So the
            reason and the way out ship WITH the prompt rather than in a note
            somewhere below it. Only when there is genuinely no secret — when
            `canWrite`, this row does not render at all. */}
        {!canWrite && (
          <div className="basis-full flex flex-wrap items-center gap-x-2">
            <span className="text-[10.5px] text-mut">
              {secretState === "rejected"
                ? "That account secret was rejected, so this can't run yet."
                : "This needs your account secret."}
            </span>
            {/* A real 44px target, not an inline text link inside the sentence:
                the sentence is 10.5px and a tap target that size fails on a
                phone, which is where this prompt is least expected. */}
            <button
              type="button"
              onClick={openSecret}
              className="min-h-[44px] -my-2 text-[11px] font-semibold text-teal/90 hover:text-teal underline decoration-dotted underline-offset-2 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
            >
              Enter account secret
            </button>
          </div>
        )}
      </div>
    ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  // COLLAPSED: the prompt, the two lines that report what a prompt action did,
  // and nothing else. `null` when there is nothing to say — an empty bordered
  // box announcing that everything is fine is the panel this directive removed.
  //
  // The secret FORM is still rendered here when it has been opened, because
  // `openSecret` calls `onRequestExpand` first and the page un-collapses on the
  // same tick — but rendering it in this branch too means a page that ignores
  // `onRequestExpand` still gets a reachable field rather than a button that
  // does nothing. Defensive on purpose: an unreachable secret entry is the one
  // outcome this refactor was told not to produce.
  if (collapsed) {
    if (!promptBlock && !busy && !error && !secretForm) return null;
    return (
      <div ref={containerRef} className="space-y-2" data-testid="mystats-account-picker-collapsed">
        {promptBlock}
        {busy && (
          <p role="status" aria-live="polite" className="text-[11px] text-mut">
            Switching account…
          </p>
        )}
        {error && (
          <p role="status" aria-live="polite" className="text-[11px] text-bad">
            {error}
          </p>
        )}
        {secretForm}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="bg-panel border border-line rounded-xl px-4 sm:px-5 py-3"
      data-testid="mystats-account-picker"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[10px] tracking-[0.13em] uppercase text-mut font-semibold">
          {mode === "menu" ? "Linked accounts" : "Linked account"}
        </p>
        {mode === "menu" && <span className="text-[10px] text-mut/85 tabular-nums">{views.length} linked</span>}
      </div>

      {/* ONE account: a labelled line, not a menu. See pickerModeFor. */}
      {mode === "single" && views[0] && (
        <div className="mt-1.5">
          <p className="text-[14px] font-semibold text-txt tracking-[-0.01em]">{views[0].riotId}</p>
          <p className="text-[11px] text-mut tabular-nums mt-0.5" title="Games stored for this account">
            {views[0].meta}
          </p>
        </div>
      )}

      {mode === "empty" && (
        <p className="mt-1.5 text-[12px] text-mut">
          No Riot account is linked yet. Open the League client with the companion running and it will offer to link the
          account you&apos;re signed in as.
        </p>
      )}

      {mode === "menu" && (
        /* Width-capped on purpose: a Riot ID plus one meta line does not need
           1000px of trigger, and a full-bleed two-row menu at desktop width
           reads as a slab rather than a control. */
        <div className="relative mt-1.5 w-full max-w-[420px]">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls="mystats-account-menu"
            // aria-disabled, never the `disabled` attribute: a disabled button
            // is not focusable, so toggling it mid-interaction would silently
            // throw a keyboard user's focus to the document body.
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              open ? setOpen(false) : openMenu();
            }}
            className={`w-full min-h-[44px] flex items-center gap-2 rounded-lg border border-line bg-black/20 px-3 text-left transition-colors motion-reduce:transition-none hover:border-line-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              busy ? "opacity-60" : ""
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-txt truncate tracking-[-0.01em]">
                {activeView?.riotId ?? activeRiotId ?? "No account active"}
              </span>
              {activeView && <span className="block text-[10.5px] text-mut tabular-nums truncate">{activeView.meta}</span>}
            </span>
            {/* An SVG, not the `&#9662;` glyph the older rows use: in this app's
                display font that character falls back to a 3px dash, which reads
                as a hyphen rather than a disclosure affordance. Rotation is
                transform-only and disabled under prefers-reduced-motion. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 12 12"
              className={`w-3 h-3 flex-shrink-0 text-mut transition-transform duration-150 motion-reduce:transition-none ${
                open ? "rotate-180" : ""
              }`}
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {open && (
            <div
              id="mystats-account-menu"
              role="menu"
              aria-label="Linked accounts"
              className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 rounded-lg border border-line bg-panel shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_8px_24px_-8px_rgba(0,0,0,0.7),0_2px_8px_-2px_rgba(0,0,0,0.5)] overflow-hidden"
            >
              {views.map((v, i) => (
                <button
                  key={v.id}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={v.active}
                  aria-label={v.srLabel}
                  // Roving tab stop, same standard as HextechTabs.tsx: the
                  // control is ONE stop in the page tab order, the arrows do the
                  // rest.
                  tabIndex={i === focusIndex ? 0 : -1}
                  // aria-disabled rather than `disabled`, deliberately: a
                  // disabled button is removed from the focus order, so a
                  // read-only picker (no secret) would become a menu a keyboard
                  // user cannot even read, and the ACTIVE row — which is where
                  // focus lands when the menu opens — would refuse focus and
                  // dump it on the body. Both stay focusable and announce their
                  // state; the click handler is what refuses.
                  aria-disabled={busy || !canWrite || v.active}
                  onKeyDown={(e) => onRowKeyDown(e, i)}
                  onClick={() => {
                    if (busy || !canWrite) return; // read-only, never throws
                    if (v.active) {
                      // Re-picking the current account is a no-op by definition.
                      // Close, don't spend a write to be told nothing changed.
                      setOpen(false);
                      triggerRef.current?.focus();
                      return;
                    }
                    void runSwitch(v.id, v.riotId);
                  }}
                  className={`w-full min-h-[44px] flex items-center gap-2.5 px-3 py-2 text-left border-b border-line last:border-b-0 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal ${
                    v.active
                      ? "bg-panel2/40 cursor-default"
                      : !canWrite
                        ? "opacity-55 cursor-not-allowed"
                        : "hover:bg-panel2/70"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${v.active ? "bg-teal" : "bg-transparent"}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-txt truncate tracking-[-0.01em]">{v.riotId}</span>
                    <span className="block text-[10.5px] text-mut tabular-nums truncate">{v.meta}</span>
                  </span>
                  {v.active && (
                    <span className="text-[9px] tracking-[0.06em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-teal border border-line-gold flex-shrink-0">
                      Active
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {promptBlock}

      {busy && (
        <p role="status" aria-live="polite" className="mt-2 text-[11px] text-mut">
          Switching account…
        </p>
      )}

      {error && (
        <p role="status" aria-live="polite" className="mt-2 text-[11px] text-bad">
          {error}
        </p>
      )}

      {(readOnlyNote || secretLink) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {readOnlyNote}
          {secretLink}
        </div>
      )}
      {secretForm}
    </div>
  );
}
