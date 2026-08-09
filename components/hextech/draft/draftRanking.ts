export interface OriginalDraftRankedRow<T> {
  play: T;
  rank: number;
}

/** Filter a recommendation feed without changing its server-assigned rank. */
export function preserveOriginalDraftRanks<T extends { personalOverall: { games: number } }>(
  plays: T[],
  comfortOnly: boolean
): OriginalDraftRankedRow<T>[] {
  return plays
    .map((play, index) => ({ play, rank: index + 1 }))
    .filter((row) => !comfortOnly || row.play.personalOverall.games > 0);
}
