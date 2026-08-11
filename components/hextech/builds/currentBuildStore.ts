// ─────────────────────────────────────────────────────────────────────────────
// currentBuildStore.ts — the Builds page's fetched build, published for the
// ONE sibling that needs it and cannot see it: ChampionHero.
//
// WHY A STORE AND NOT PROPS. app/page.tsx renders <ChampionHero> and
// <BuildTabContent> as siblings, and BuildTabContent owns the /api/build fetch
// (with a carefully-guarded out-of-order-response cancellation — see its own
// `load` comment, which documents a live prod bug). The hero's action buttons
// need that same build to do anything real. The two alternatives were both
// worse:
//
//   · Lift the fetch into app/page.tsx — moves the stale-response guard, the
//     rankHydrated gate and the altKeystone resolution out of the component
//     they were debugged in, for the benefit of two buttons.
//   · Give the hero its own /api/build fetch — a SECOND call site for the
//     rank query param (see lib/rankBrackets.ts's rankQueryParam note on why
//     five duplicated call sites was the bug), a second in-flight request per
//     champion change, and two components that can disagree about what the
//     current build is.
//
// So the fetch keeps exactly one owner and publishes its outcome. This mirrors
// championSearchBus.ts's reason for existing (reaching a component outside the
// prop tree) with a snapshot store rather than an event, because the hero needs
// the CURRENT value on mount, not a moment when it changed.
//
// STALENESS IS THE HERO'S PROBLEM TO CHECK, AND IT IS CHECKED. Every snapshot
// carries the request key it belongs to. A consumer passes the key it expects
// and gets `loading` back on any mismatch, so the half-frame where the store
// still holds Viktor MID while the hero already renders Viktor SUPPORT can
// never arm a button with the wrong lane's build.
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";

/** The identity of one /api/build request. Shared by the publisher and every
 *  consumer so the two cannot drift into disagreeing about what "the same
 *  build" means — BuildTabContent used to build this string inline. `champ.key`
 *  is in it because a ChampionRef can change key without changing id during a
 *  patch/version swap, and that is a different response. */
export function buildRequestKey(champ: ChampionRef, lane: LaneId, rankBracket: string): string {
  return `${champ.id}:${champ.key}:${lane}:${rankBracket}`;
}

export type CurrentBuildSnapshot =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; champ: ChampionRef; lane: LaneId; build: BuildResponse }
  /** The request finished and there is nothing to act on: /api/build 404'd for
   *  this lane (Viktor SUPPORT), or the request failed. Deliberately ONE state
   *  — a consumer's only question is "can I act", and the reason the user needs
   *  is already rendered by BuildTabContent's own panel. */
  | { key: string; status: "unavailable" };

/** Identity-stable so useSyncExternalStore's getServerSnapshot never returns a
 *  fresh object (that is an infinite render loop, not a warning). */
const EMPTY: CurrentBuildSnapshot = { key: "", status: "loading" };

let snapshot: CurrentBuildSnapshot = EMPTY;
const listeners = new Set<() => void>();

export function getCurrentBuildSnapshot(): CurrentBuildSnapshot {
  return snapshot;
}

/** Server render + SSR hydration: nothing has been fetched, so nothing is
 *  actionable. Always the same object — see EMPTY. */
export function getServerCurrentBuildSnapshot(): CurrentBuildSnapshot {
  return EMPTY;
}

export function subscribeCurrentBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishCurrentBuild(next: CurrentBuildSnapshot): void {
  if (snapshot === next) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** Called from BuildTabContent's unmount cleanup. Without it, navigating away
 *  from the Builds page would leave the last champion's build armed in the
 *  store for whatever mounts next. */
export function resetCurrentBuild(): void {
  publishCurrentBuild(EMPTY);
}

/** Read a snapshot only if it belongs to `expectedKey`; anything else reads as
 *  "not resolved yet". Pure, so the staleness rule is testable without React. */
export function snapshotForKey(current: CurrentBuildSnapshot, expectedKey: string): CurrentBuildSnapshot {
  if (current.key !== expectedKey) return { key: expectedKey, status: "loading" };
  return current;
}
