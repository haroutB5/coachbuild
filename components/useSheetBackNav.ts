"use client";

import { useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Shared back-gesture history integration for a page with an optional
// selectable "subject" (S — a serializable wire-shape selection, or `null`
// when a page has no selection concept) and a game-detail sheet that can be
// opened on top of it. Extracted from app/history/page.tsx's original
// (v0.20.0) inline pushState/popstate machinery so a second consumer (the
// home page's PRO BUILDS tab, v0.21.1) gets the identical back-gesture
// contract instead of a hand-rolled fork.
//
// Every pushed entry is SELF-SUFFICIENT (selection + which game's sheet is
// open, if any) rather than a delta — popstate only ever hands back a single
// state object for the entry landed on, never a diff from the previous one.
//
// Two distinct "closing a sheet" paths, deliberately NOT unified (mirrors
// GameDetailSheet's onClose vs onDismiss split):
//  - Explicit dismiss (✕ / Escape / backdrop) -> dismissGame() ->
//    history.back(), POPPING the sheet-open entry so the stack never
//    accumulates ghosts.
//  - Cross-player jump / any other programmatic close -> the caller resets
//    its own local `open` state directly (GameDetailSheet's onClose) without
//    touching history; a subsequent pushSelection (if any) resets openGameId
//    to null on top.
// ─────────────────────────────────────────────────────────────────────────────

export interface NavSheetState<S> {
  v: 1;
  selection: S | null;
  openGameId: string | null;
}

export function isNavSheetState<S>(v: unknown): v is NavSheetState<S> {
  return typeof v === "object" && v !== null && (v as { v?: unknown }).v === 1;
}

interface UseSheetBackNavOptions<S> {
  /** Repaint page state from a landed-on entry's selection — fired on
   *  mount-resume (a same-tab refresh retains history.state for the CURRENT
   *  entry) and on every popstate. The hook owns `openGameId` itself (see
   *  the returned value below); callers with no selection concept (S =
   *  `null`) can omit this entirely. */
  onApplySelection?: (selection: S | null) => void;
  /** Called once on mount, before seeding a fresh initial entry, to resolve
   *  a cross-page-handoff selection (e.g. /history's sessionStorage stash).
   *  Expected to apply its own side effects (e.g. setState) AND return the
   *  wire-shape selection to embed in the seeded entry. Return null when
   *  there's nothing to seed. Omit when the caller has no such handoff. */
  seedInitialSelection?: () => S | null;
}

export interface UseSheetBackNavResult<S> {
  openGameId: string | null;
  /** Push a brand-new SELECTION entry (player picked / champion picked /
   *  cross-player jump) — always resets openGameId to null, live and
   *  pushed, so a fresh selection made while a sheet was open starts clean. */
  pushSelection: (selection: S | null) => void;
  /** Push a SHEET-OPEN entry on top of `currentSelection` (selection itself
   *  unchanged) — pass the caller's current selection (or `null` when the
   *  caller has none) so the entry stays self-sufficient. */
  openGame: (gameId: string, currentSelection: S | null) => void;
  /** Explicit dismiss (✕ / Escape / backdrop) — pop the sheet-open entry.
   *  The resulting popstate is what actually clears `openGameId` — single
   *  source of truth, no double-update. */
  dismissGame: () => void;
  /** True while a popstate-driven restore is applying — guards push-style
   *  callers from re-entrantly pushing a NEW entry mid-restore. */
  isRestoring: () => boolean;
}

export function useSheetBackNav<S>({
  onApplySelection,
  seedInitialSelection,
}: UseSheetBackNavOptions<S> = {}): UseSheetBackNavResult<S> {
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  // True while a popstate-driven restore is applying — see isRestoring's doc.
  const restoringRef = useRef(false);

  function pushSelection(selection: S | null) {
    setOpenGameId(null);
    if (restoringRef.current) return;
    const state: NavSheetState<S> = { v: 1, selection, openGameId: null };
    window.history.pushState(state, "");
  }

  function openGame(gameId: string, currentSelection: S | null) {
    setOpenGameId(gameId);
    if (restoringRef.current) return;
    const state: NavSheetState<S> = { v: 1, selection: currentSelection, openGameId: gameId };
    window.history.pushState(state, "");
  }

  function dismissGame() {
    window.history.back();
  }

  // Mount: either resume an already-seeded entry (a same-tab refresh — the
  // browser retains history.state for the CURRENT entry across a reload) or
  // seed one fresh (optionally folding in a cross-page handoff via
  // seedInitialSelection, e.g. /history's Teams-box-tap stash) via
  // replaceState rather than a push: this is the page's starting point, not
  // a "change," so back from here correctly exits to wherever the user came
  // from (no extra entry).
  useEffect(() => {
    const existing = window.history.state;
    if (isNavSheetState<S>(existing)) {
      setOpenGameId(existing.openGameId);
      onApplySelection?.(existing.selection);
      return;
    }
    const initial = seedInitialSelection ? seedInitialSelection() : null;
    const seeded: NavSheetState<S> = { v: 1, selection: initial, openGameId: null };
    window.history.replaceState(seeded, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward: repaint from whatever entry the browser landed on.
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      restoringRef.current = true;
      const state = isNavSheetState<S>(e.state) ? e.state : null;
      setOpenGameId(state?.openGameId ?? null);
      onApplySelection?.(state?.selection ?? null);
      // Released on the next microtask — after this synchronous batch of
      // state updates has been scheduled, so a genuinely new user action
      // right after a restore is never mistaken for part of it.
      queueMicrotask(() => {
        restoringRef.current = false;
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    openGameId,
    pushSelection,
    openGame,
    dismissGame,
    isRestoring: () => restoringRef.current,
  };
}
