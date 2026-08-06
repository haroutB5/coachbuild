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
  /** Owner namespace — raw history.state is global, so every consumer must
   *  reject entries written by another page before touching its payload. */
  namespace: string;
  selection: S | null;
  openGameId: string | null;
}

export const HOME_NAV_NAMESPACE = "home";
export const HISTORY_NAV_NAMESPACE = "history";

export function isNavSheetState<S>(v: unknown, namespace: string): v is NavSheetState<S> {
  if (typeof v !== "object" || v === null) return false;
  const state = v as { v?: unknown; namespace?: unknown; openGameId?: unknown };
  return (
    state.v === 1 &&
    state.namespace === namespace &&
    (state.openGameId === null || typeof state.openGameId === "string")
  );
}

/** The restore gate is kept as a tiny pure seam so its failure behavior is
 *  testable without a DOM/React rendering harness. The microtask release is
 *  intentional: it preserves the existing contract that the synchronous
 *  state-update batch is still considered a restore, while `finally` makes a
 *  throwing callback unable to leave the page permanently inert. */
export function runNavRestore(restoringRef: { current: boolean }, restore: () => void): void {
  restoringRef.current = true;
  try {
    restore();
  } catch (error) {
    console.error("useSheetBackNav restore failed", error);
  } finally {
    queueMicrotask(() => {
      restoringRef.current = false;
    });
  }
}

interface UseSheetBackNavOptions<S> {
  /** Namespace owned by this page. It is written into every entry and is
   *  required when validating an entry on mount or popstate. */
  namespace: string;
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
  /** Replace the CURRENT top-of-stack entry's selection in place — no push,
   *  no navigation, no popstate. For a sub-state change that shouldn't count
   *  as its own back-gesture step (e.g. the home page's BUILD/PRO BUILDS tab,
   *  v0.23.0: switching tabs doesn't change "which page" you're on, so it
   *  updates the existing entry rather than adding one). Only call this while
   *  no sheet is open (openGameId === null) — it does not touch openGameId,
   *  so replacing over a sheet-open entry would silently strip its sheet.
   *  Callers that need to change selection AND close an open sheet at once
   *  should dismissGame() first (a real back()) and let the resulting
   *  popstate drive the restore instead. */
  replaceSelection: (selection: S | null) => void;
  /** Explicit dismiss (✕ / Escape / backdrop) — pop the sheet-open entry.
   *  The resulting popstate is what actually clears `openGameId` — single
   *  source of truth, no double-update. */
  dismissGame: () => void;
  /** True while a popstate-driven restore is applying — guards push-style
   *  callers from re-entrantly pushing a NEW entry mid-restore. */
  isRestoring: () => boolean;
}

export function useSheetBackNav<S>({
  namespace,
  onApplySelection,
  seedInitialSelection,
}: UseSheetBackNavOptions<S>): UseSheetBackNavResult<S> {
  // Snapshot `window.history.state` ONCE, synchronously, at the very first
  // render — before the mount effect below (or any effect) has run. Reading
  // it fresh INSIDE that effect is what used to happen, and it is not safe:
  // under React 18 StrictMode (dev only), React double-invokes mount effects
  // against the SAME render (no re-render in between) to catch exactly this
  // class of non-idempotent effect. The mount effect's own FIRST invoke calls
  // `window.history.replaceState` for a fresh seed — a REAL browser mutation
  // that StrictMode's replay does NOT roll back (only React state/refs are
  // reset via cleanup; raw Web APIs are not). So the SECOND invoke, reading
  // `window.history.state` live, would see its own just-written seed and
  // wrongly conclude "this is a resume of an existing entry," replaying
  // `onApplySelection` with that seed's value — clobbering whatever a
  // sibling effect (e.g. a page's own session-restore effect) set in the
  // interim. Capturing once at render makes both StrictMode invokes agree:
  // either both take the resume branch or both take the fresh-seed branch,
  // never a mismatch. A lazy state initializer retains that immutable snapshot
  // without accessing a ref during render.
  const [existingHistoryState] = useState<unknown>(() =>
    typeof window !== "undefined" ? window.history.state : null
  );
  const [openGameId, setOpenGameId] = useState<string | null>(() =>
    isNavSheetState<S>(existingHistoryState, namespace) ? existingHistoryState.openGameId : null
  );
  const restoringRef = useRef(false);

  function pushSelection(selection: S | null) {
    setOpenGameId(null);
    if (restoringRef.current) return;
    const state: NavSheetState<S> = { v: 1, namespace, selection, openGameId: null };
    window.history.pushState(state, "");
  }

  function openGame(gameId: string, currentSelection: S | null) {
    setOpenGameId(gameId);
    if (restoringRef.current) return;
    const state: NavSheetState<S> = { v: 1, namespace, selection: currentSelection, openGameId: gameId };
    window.history.pushState(state, "");
  }

  function dismissGame() {
    window.history.back();
  }

  function replaceSelection(selection: S | null) {
    if (restoringRef.current) return;
    const state: NavSheetState<S> = { v: 1, namespace, selection, openGameId: null };
    window.history.replaceState(state, "");
  }

  function applySelectionSafely(selection: S | null) {
    try {
      onApplySelection?.(selection);
    } catch (error) {
      console.error("useSheetBackNav mount restore failed", error);
    }
  }

  // Mount: either resume an already-seeded entry (a same-tab refresh — the
  // browser retains history.state for the CURRENT entry across a reload) or
  // seed one fresh (optionally folding in a cross-page handoff via
  // seedInitialSelection, e.g. /history's Teams-box-tap stash) via
  // replaceState rather than a push: this is the page's starting point, not
  // a "change," so back from here correctly exits to wherever the user came
  // from (no extra entry).
  useEffect(() => {
    if (isNavSheetState<S>(existingHistoryState, namespace)) {
      applySelectionSafely(existingHistoryState.selection);
      return;
    }
    const initial = seedInitialSelection ? seedInitialSelection() : null;
    const seeded: NavSheetState<S> = { v: 1, namespace, selection: initial, openGameId: null };
    window.history.replaceState(seeded, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back/forward: repaint from whatever entry the browser landed on.
  useEffect(() => {
    function onPopState(e: PopStateEvent) {
      runNavRestore(restoringRef, () => {
        const state = isNavSheetState<S>(e.state, namespace) ? e.state : null;
        setOpenGameId(state?.openGameId ?? null);
        applySelectionSafely(state?.selection ?? null);
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
    replaceSelection,
    isRestoring: () => restoringRef.current,
  };
}
