// Pure data helper for the Build tab's >=lg 2-column composition (plan §3c):
// which cards live in the left vs. right grid column. Kept as data (not
// inlined JSX ordering) so the split is unit-testable and fronty's markup
// just maps over it. No JSX here — plain .ts, vitest-importable.
export type BuildCardId = "runes" | "core" | "starting" | "proConsensus" | "situational";

export interface BuildTabLayout {
  left: BuildCardId[];
  right: BuildCardId[];
}

export const BUILD_TAB_LAYOUT: BuildTabLayout = {
  // lg:col-span-7 — RunesSummonersCard, CoreBuildOrderCard
  left: ["runes", "core"],
  // lg:col-span-5 — StartingCard, ProConsensusCard, SituationalCard
  right: ["starting", "proConsensus", "situational"],
};
