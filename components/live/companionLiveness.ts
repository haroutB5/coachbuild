import { COMPANION_STATUS_POLL_MS } from "./companionClient";

/** A companion-derived state is trusted for three status-poll intervals only. */
export const COMPANION_STATUS_STALE_AFTER_MS = COMPANION_STATUS_POLL_MS * 3;

/**
 * Returns whether the browser has heard a successful /status response recently
 * enough to render companion-derived state. A missing or invalid timestamp is
 * never considered live.
 */
export function isCompanionStatusFresh(lastSuccessfulPollAt: number | null, now = Date.now()): boolean {
  if (!Number.isFinite(lastSuccessfulPollAt) || !Number.isFinite(now)) return false;
  return now - (lastSuccessfulPollAt as number) < COMPANION_STATUS_STALE_AFTER_MS;
}
