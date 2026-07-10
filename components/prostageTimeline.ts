"use client";

// ─────────────────────────────────────────────────────────────────────────────
// prostageTimeline.ts — client fetch for GET /api/prostage/timeline, the
// pro-play item build order timeline. Mirrors itemDetail.ts's module-level
// cache + in-flight dedup pattern.
//
// Contract (engy — see HANDOFF-fronty.md for the exact shape this was built
// against; server route computes synchronously and never returns "pending",
// so this module no longer has a retry-poll branch for it — see 2026-07-11
// P3 fix, removed rather than kept as unreachable forward-compat):
//   200 {"status":"ok","purchaseOrder":[...]}          — same element shape
//     as soloq `purchaseOrder` (ProGamePurchase[]; ts in SECONDS)
//   200 {"status":"unavailable","reason":...}            — permanent, show a
//     muted note
//   network / non-2xx / unexpected body                 — transient, offer a
//     quiet manual retry, never crash
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ProGamePurchase } from "./proGames.types";

export type ProstageTimelineState =
  | { status: "loading" }
  | { status: "ok"; purchaseOrder: ProGamePurchase[] }
  | { status: "unavailable"; reason?: string }
  /** Network failure / non-2xx / malformed body — transient, never cached,
   *  so a manual retry re-hits the network. */
  | { status: "error" };

type FetchResult =
  | { kind: "ok"; purchaseOrder: ProGamePurchase[] }
  | { kind: "unavailable"; reason?: string }
  | { kind: "error" };

async function fetchOnce(gameId: string, playerLink: string): Promise<FetchResult> {
  try {
    const res = await fetch(
      `/api/prostage/timeline?gameId=${encodeURIComponent(gameId)}&player=${encodeURIComponent(playerLink)}`
    );
    if (!res.ok) return { kind: "error" };
    const json = (await res.json()) as { status?: string; purchaseOrder?: unknown; reason?: unknown };
    if (json?.status === "ok" && Array.isArray(json.purchaseOrder)) {
      return { kind: "ok", purchaseOrder: json.purchaseOrder as ProGamePurchase[] };
    }
    if (json?.status === "unavailable") {
      return { kind: "unavailable", reason: typeof json.reason === "string" ? json.reason : undefined };
    }
    // Unrecognized 2xx body shape — treat like a transient failure rather
    // than silently rendering nothing.
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

async function resolveTimeline(gameId: string, playerLink: string): Promise<ProstageTimelineState> {
  const result = await fetchOnce(gameId, playerLink);
  if (result.kind === "ok") return { status: "ok", purchaseOrder: result.purchaseOrder };
  if (result.kind === "unavailable") return { status: "unavailable", reason: result.reason };
  return { status: "error" };
}

// Keyed by `${gameId}::${playerLink}`. Only TERMINAL, non-transient results
// are cached (ok / unavailable) so reopening the sheet for the same game
// doesn't refetch. A network "error" is deliberately never cached — a later
// manual retry should hit the network again once connectivity/backend
// recovers, not stay stuck.
const resultCache = new Map<string, ProstageTimelineState>();
const inFlight = new Map<string, Promise<ProstageTimelineState>>();

/**
 * Resolves (and caches) one gameId+playerLink's timeline fetch. Exported —
 * not just `useProstageTimeline` — so the fetch/cache/dedup logic itself is
 * directly unit-testable (mock `fetch`, no React/jsdom needed), same
 * convention as itemDetail.ts's `getItemDetail` / runeDetail.ts's
 * `getRuneDetail`.
 */
export async function loadProstageTimeline(gameId: string, playerLink: string): Promise<ProstageTimelineState> {
  const key = `${gameId}::${playerLink}`;
  const cached = resultCache.get(key);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = resolveTimeline(gameId, playerLink);
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    if (result.status !== "error") resultCache.set(key, result);
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Fetches a pro-play game's item build order timeline. `playerLink` is
 * required by the route contract but may be absent on today's actual
 * `/api/pros` response (see proGames.types.ts's `ProGame.playerLink`
 * comment) — when missing, this resolves straight to `unavailable` with no
 * network call, never throws.
 */
export function useProstageTimeline(
  gameId: string,
  playerLink: string | undefined
): { state: ProstageTimelineState; retry: () => void } {
  const [state, setState] = useState<ProstageTimelineState>({ status: "loading" });
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!playerLink) {
      setState({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadProstageTimeline(gameId, playerLink).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [gameId, playerLink, retryTick]);

  return { state, retry: () => setRetryTick((t) => t + 1) };
}
