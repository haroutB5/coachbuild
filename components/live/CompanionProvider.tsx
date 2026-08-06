"use client";

// ─────────────────────────────────────────────────────────────────────────────
// CompanionProvider.tsx — the ONE app-wide companion status poll (plan §6c
// "CompanionProvider lift", grounding fact "ONE poller rule").
//
// Lifted out of app/page.tsx (v0.36.1 and earlier owned this poll itself)
// so /draft (and any future live-aware surface) can react to the SAME
// companion session/phase/champSelect state without a second 3s interval —
// there must only ever be one /status poll running for the whole app.
//
// Split of responsibility with app/page.tsx's own effect (see that file):
// - THIS file owns the mechanical bookkeeping every tick always does,
//   regardless of which page is mounted or what it's currently showing:
//   fetching /status, updating React state, and the two champSelectFollowState
//   singleton writes that must happen unconditionally on every tick
//   (noteCompanionPhase + the Round-B P1 markCompanionDriven fix below).
// - app/page.tsx's OWN follow effect (unchanged in spirit, just re-keyed off
//   this context instead of its own poll) still owns "given the current
//   phase/champSelect, should the PAGE navigate to a different champion/lane"
//   — that decision is page-specific (it touches champ/activeLane/sheetNav),
//   not something every consumer of this context wants.
// - /draft consumes this context READ-ONLY via useCompanion() (plan §6c) —
//   it never calls any of the champSelectFollowState setters itself.
//
// v1.5.0 addition (attached-tab-suppression fix, companion 1.5.0): every
// route mounts this provider and polls /status, but only `/` and `/draft`
// actually react to a live champ-select change (page.tsx's follow effect,
// /draft's read-only live awareness). companion.ps1's
// Test-CompanionHasAttachedTab used to treat ANY recent /status poll as
// proof a tab would live-follow, so opening champ select with e.g.
// /live-setup open silently suppressed the deep-link open. This poll now
// appends `follow=1` only when the CURRENT route is follow-capable.
//
// v1.6.0 ("two pages simultaneously" ship): the boolean became a KIND —
// `follow=builds` (`/`) or `follow=draft` (`/draft`), via followKindForRoute
// (companionClient.ts) — see the followRef below. companion.ps1 now tracks
// each page's attachment independently (Test-CompanionHasAttachedTab -Kind)
// so it can open whichever of the two is MISSING rather than treating either
// tab as proof the other doesn't need opening. This is purely about what
// query string the poll sends; it does NOT change when/whether the tick
// fires, and must not reorder anything below.
//
// Round-B P1 regression note (CRITICAL — do not simplify away): the original
// bug was "the driven-mark only fires inside the follow's target branch,"
// which loses a race on a fresh deep-link tab (mount effect's /api/champions
// resolving before the first poll tick wipes the mark and nothing
// re-establishes it). The fix is the unconditional
// `if (liveChampSelectId !== null) markCompanionDriven(liveChampSelectId)`
// below, executed on EVERY tick, in the SAME tick as noteCompanionPhase's
// entry-clear — both must stay in this one function, in this order,
// synchronously (no awaiting an intermediate fetch in between), or the exact
// race the fix closed reopens. See CHANGELOG [0.36.1] for the original
// incident.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  getStoredSession,
  setStoredSession,
  refreshStatus,
  followKindForRoute,
  detachFollow,
  COMPANION_STATUS_POLL_MS,
  type CompanionChampSelectSnapshot,
  type FollowKind,
} from "./companionClient";
import { noteCompanionPhase, markCompanionDriven, setCurrentChampSelectChampionId } from "./champSelectFollowState";
import { resolveCurrentChampSelectChampionId } from "./champSelectFollow";

export interface CompanionContextValue {
  /** Paired companion session token, read from localStorage after hydration and
   *  updatable via setSession (app/page.tsx's deep-link mount effect calls
   *  this when a fresh `?session=` arrives). Null until a session is known —
   *  the poll below doesn't start until this is non-null. */
  session: string | null;
  setSession: (session: string) => void;
  /** Null whenever there's no session, or the companion hasn't answered yet
   *  (or has stopped answering — refreshStatus degrades the same way). */
  phase: string | null;
  champSelect: CompanionChampSelectSnapshot | null;
  clientConnected: boolean;
  /** Bumped once per COMPLETED poll tick, regardless of whether phase/
   *  champSelect actually changed value. Consumers that must re-evaluate on
   *  EVERY tick (app/page.tsx's follow effect ran on every 3s tick
   *  pre-lift, unconditionally) depend on this instead of on phase/
   *  champSelect's identity, so behavior after the lift is byte-for-byte
   *  the same cadence as before — not merely "close enough." */
  tick: number;
}

const CompanionContext = createContext<CompanionContextValue>({
  session: null,
  setSession: () => {
    /* no-op default — real setter only exists once CompanionProvider mounts,
       which app/layout.tsx guarantees for every route in this app. */
  },
  phase: null,
  champSelect: null,
  clientConnected: false,
  tick: 0,
});

const subscribeToStoredSession = () => () => {};

export function useCompanion(): CompanionContextValue {
  return useContext(CompanionContext);
}

export default function CompanionProvider({ children }: { children: ReactNode }) {
  const [sessionOverride, setSessionState] = useState<string | null>(null);
  const storedSession = useSyncExternalStore(subscribeToStoredSession, getStoredSession, () => null);
  const session = sessionOverride ?? storedSession;
  const [phase, setPhase] = useState<string | null>(null);
  const [champSelect, setChampSelect] = useState<CompanionChampSelectSnapshot | null>(null);
  const [clientConnected, setClientConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const [previousSession, setPreviousSession] = useState(session);
  if (session !== previousSession) {
    setPreviousSession(session);
    if (!session) {
      setPhase(null);
      setChampSelect(null);
      setClientConnected(false);
    }
  }

  // v1.5.0 (attached-tab fix), widened to page IDENTITY in v1.6.0 (see
  // companionClient.ts's followKindForRoute): which route is current, read
  // fresh by every poll tick via a ref rather than added to the poll
  // effect's own dependency array below — a client nav between two
  // follow-capable-or-not routes must NOT restart the poll interval (that
  // would perturb the tick cadence the Round-B P1 fix and /draft's
  // live-sync both depend on), it only needs the NEXT tick to send the
  // correct `follow` kind.
  const pathname = usePathname();
  const followRef = useRef<FollowKind>(followKindForRoute(pathname));
  useEffect(() => {
    const next = followKindForRoute(pathname);
    const prev = followRef.current;
    followRef.current = next;
    // v0.59.0 / companion 1.7.0 — a client-side nav OFF a follow-capable route
    // (Builds -> /mystats, or Builds -> /draft) leaves the companion believing
    // the page it just left is still attached and listening for champ-select,
    // for the full 150s attach window. It isn't: only `/` and `/draft` react to
    // a champ-select change at all. Tell the companion the moment it stops
    // being true, so its next open decision is made on the truth.
    if (prev && prev !== next && session) detachFollow(prev, session);
  }, [pathname, session]);

  // v0.59.0 / companion 1.7.0 — THE fix for "the browser wasn't open, so the
  // pages never opened" (live-reported 2026-07-26). Closing the browser stopped
  // this tab's /status poll silently, and a stopped poll is indistinguishable
  // from a poll throttled by Chrome behind a fullscreen game — so the companion
  // kept suppressing the opens for up to 150s, which is most of a champ-select.
  // `pagehide` is where the page gets to say which one it is. See
  // detachFollow's own doc comment for why pagehide + keepalive specifically.
  //
  // Deliberately NOT wired to `visibilitychange`: a hidden tab is the NORMAL
  // state for this feature (it lives behind a fullscreen game) and is still
  // following. Detaching on hide would re-open a tab on every single hover,
  // which is exactly the v1.6.4 tab-spam bug this must not resurrect.
  useEffect(() => {
    if (!session) return;
    function handlePageHide(): void {
      const kind = followRef.current;
      if (kind) detachFollow(kind, session as string);
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [session]);

  // The external-store snapshot hydrates any previously-paired session. A companion-opened deep
  // link's OWN `?session=` (app/page.tsx's mount effect) calls setSession
  // directly and wins regardless of ordering against this effect — both
  // paths converge on the same localStorage-backed value.
  function setSession(next: string): void {
    setStoredSession(next);
    setSessionState(next);
  }

  useEffect(() => {
    if (!session) {
      return;
    }
    let cancelled = false;

    async function poll() {
      const state = await refreshStatus(session as string, {}, followRef.current);
      if (cancelled) return;

      const nextPhase = state.kind === "connected" ? state.status.phase : null;
      const nextChampSelect = state.kind === "connected" ? state.status.champSelect : null;
      setPhase(nextPhase);
      setChampSelect(nextChampSelect);
      setClientConnected(state.kind === "connected" ? state.status.clientConnected : false);

      if (nextPhase) noteCompanionPhase(nextPhase);

      const liveChampSelectId =
        nextPhase === "ChampSelect" ? resolveCurrentChampSelectChampionId(nextChampSelect) : null;
      setCurrentChampSelectChampionId(liveChampSelectId);
      // Round-B audit P1 (see this file's header comment) — must stay
      // unconditional and in this exact position (same tick, right after
      // setCurrentChampSelectChampionId, before anything async).
      if (liveChampSelectId !== null) markCompanionDriven(liveChampSelectId);

      setTick((t) => t + 1);
    }

    poll();
    const id = setInterval(poll, COMPANION_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session]);

  return (
    <CompanionContext.Provider value={{ session, setSession, phase, champSelect, clientConnected, tick }}>
      {children}
    </CompanionContext.Provider>
  );
}
