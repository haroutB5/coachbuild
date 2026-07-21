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

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  getStoredSession,
  setStoredSession,
  refreshStatus,
  COMPANION_STATUS_POLL_MS,
  type CompanionChampSelectSnapshot,
} from "./companionClient";
import { noteCompanionPhase, markCompanionDriven, setCurrentChampSelectChampionId } from "./champSelectFollowState";
import { resolveCurrentChampSelectChampionId } from "./champSelectFollow";

export interface CompanionContextValue {
  /** Paired companion session token, hydrated from localStorage on mount and
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

export function useCompanion(): CompanionContextValue {
  return useContext(CompanionContext);
}

export default function CompanionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [champSelect, setChampSelect] = useState<CompanionChampSelectSnapshot | null>(null);
  const [clientConnected, setClientConnected] = useState(false);
  const [tick, setTick] = useState(0);

  // Hydrate any previously-paired session on mount. A companion-opened deep
  // link's OWN `?session=` (app/page.tsx's mount effect) calls setSession
  // directly and wins regardless of ordering against this effect — both
  // paths converge on the same localStorage-backed value.
  useEffect(() => {
    const stored = getStoredSession();
    if (stored) setSessionState(stored);
  }, []);

  function setSession(next: string): void {
    setStoredSession(next);
    setSessionState(next);
  }

  useEffect(() => {
    if (!session) {
      setPhase(null);
      setChampSelect(null);
      setClientConnected(false);
      return;
    }
    let cancelled = false;

    async function poll() {
      const state = await refreshStatus(session as string);
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
