// Pure gate for /draft's locked-pick handoff banner. Keeping the decision
// separate from JSX follows the live-surface convention used by deepLink.ts
// and draftLiveSync.ts, so the session/phase/lock rules stay unit-testable.

export interface DraftLockedPickBannerInput {
  phase: string | null;
  session: string | null | undefined;
  /** Only the local player's locked cell champion is eligible. Do not fall
   * back to pickIntent/actionChampionId here: those represent hover state. */
  cellChampionId: number | null | undefined;
  /** The last champion for which the user dismissed the banner. */
  dismissedChampionId: number | null;
  /** False when the phase/snapshot is no longer backed by a recent poll. */
  statusFresh?: boolean;
}

/** Returns the local player's locked champion id, or null when the banner
 * must stay hidden. A live session and ChampSelect phase are both required. */
export function resolveLockedPickChampionId(input: DraftLockedPickBannerInput): number | null {
  const championId = input.cellChampionId;
  if (input.statusFresh === false) return null;
  if (input.phase !== "ChampSelect" || !input.session) return null;
  if (championId === null || championId === undefined || !Number.isFinite(championId) || championId <= 0) return null;
  return championId;
}

/** Shows once for each locked champion and stays dismissed for that champion
 * until a different champion is locked. Poll ticks with the same lock do not
 * change this decision. */
export function shouldShowLockedPickBanner(input: DraftLockedPickBannerInput): boolean {
  const championId = resolveLockedPickChampionId(input);
  return championId !== null && championId !== input.dismissedChampionId;
}
