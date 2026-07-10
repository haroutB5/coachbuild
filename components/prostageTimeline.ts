"use client";

// ─────────────────────────────────────────────────────────────────────────────
// prostageTimeline.ts — client fetch for GET /api/prostage/timeline, the
// pro-play item build order timeline. Mirrors itemDetail.ts's module-level
// cache + in-flight dedup pattern.
//
// Contract (engy, in-flight — see HANDOFF-fronty.md for the exact shape this
// was built against):
//   200 {"status":"ok","purchaseOrder":[...]}          — same element shape
//     as soloq `purchaseOrder` (ProGamePurchase[]; ts in SECONDS)
//   200 {"status":"pending"}                            — compute in progress,
//     retry after ~2s, capped
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
  /** Gave up after MAX_PENDING_RETRIES straight "pending" responses — not a
   *  permanent unavailable (the compute may still land later), so callers
   *  should render "try again later" copy rather than the flat unavailable
   *  note. */
  | { status: "pending-timeout" }
  /** Network failure / non-2xx / malformed body — transient, never cached,
   *  so a manual retry re-hits the network. */
  | { status: "error" };

const PENDING_RETRY_MS = 2000;
const MAX_PENDING_RETRIES = 3;

type FetchResult =
  | { kind: "ok"; purchaseOrder: ProGamePurchase[] }
  | { kind: "pending" }
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
    if (json?.status === "pending") return { kind: "pending" };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveTimeline(gameId: string, playerLink: string): Promise<ProstageTimelineState> {
  for (let attempt = 0; ; attempt++) {
    const result = await fetchOnce(gameId, playerLink);
    if (result.kind === "ok") return { status: "ok", purchaseOrder: result.purchaseOrder };
    if (result.kind === "unavailable") return { status: "unavailable", reason: result.reason };
    if (result.kind === "error") return { status: "error" };
    // "pending" — retry up to MAX_PENDING_RETRIES more times, ~2s apart.
    if (attempt >= MAX_PENDING_RETRIES) return { status: "pending-timeout" };
    await sleep(PENDING_RETRY_MS);
  }
}

// Keyed by `${gameId}::${playerLink}`. Only TERMINAL, non-transient results
// are cached (ok / unavailable / pending-timeout) so reopening the sheet for
// the same game doesn't refetch or re-spam the retry-poll loop. A network
// "error" is deliberately never cached — a later manual retry should hit the
// network again once connectivity/backend recovers, not stay stuck.
const resultCache = new Map<string, ProstageTimelineState>();
const inFlight = new Map<string, Promise<ProstageTimelineState>>();

async function loadProstageTimeline(gameId: string, playerLink: string): Promise<ProstageTimelineState> {
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
 * Fetches (and retry-polls while `status: "pending"`) a pro-play game's item
 * build order timeline. `playerLink` is required by the route contract but
 * may be absent on today's actual `/api/pros` response (see
 * proGames.types.ts's `ProGame.playerLink` comment) — when missing, this
 * resolves straight to `unavailable` with no network call, never throws.
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
