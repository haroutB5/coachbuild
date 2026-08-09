export interface OriginalDraftRankedRow<T> {
  play: T;
  rank: number;
}

/** Flatten recommendation feeds, then filter without changing merged order. */
export function preserveOriginalDraftRanks<T extends { personalOverall: { games: number } }>(
  feeds: readonly (readonly T[])[],
  comfortOnly: boolean
): OriginalDraftRankedRow<T>[] {
  const mergedPlays = feeds.reduce<T[]>((merged, feed) => merged.concat(feed), []);
  return mergedPlays
    .map((play, index) => ({ play, rank: index + 1 }))
    .filter((row) => !comfortOnly || row.play.personalOverall.games > 0);
}
