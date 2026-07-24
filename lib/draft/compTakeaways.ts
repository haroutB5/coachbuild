// ─────────────────────────────────────────────────────────────────────────────
// compTakeaways.ts — pure editorial one-liners derived from an AggregatedComp
// (lib/draft/compRatings.ts), v0.51 redesign wave A (draft page mockup's
// "Comp takeaways" bullet list under the radar). Same editorial-classification
// posture as compRatings.ts itself (see that file's header) -- these are
// curated readings of the 0-3 axis vectors, not measured game data, and the
// UI must present them alongside the radar's existing "curated kit ratings"
// disclosure, never as a statistical claim.
// ─────────────────────────────────────────────────────────────────────────────

import type { AggregatedComp } from "./compRatings";

const CC_HEAVY_FLOOR = 2.2;
const FRONT_TO_BACK_TANKINESS_FLOOR = 2.2;
const FRONT_TO_BACK_DAMAGE_FLOOR = 2.0;
const LOW_MOBILITY_CEILING = 1.2;
const STRONG_ENGAGE_FLOOR = 2.4;
const HIGH_UTILITY_FLOOR = 2.4;

const MAX_TAKEAWAYS = 3;

/** Priority order when multiple signals fire at once -- strongest/most
 *  actionable first: CC (item/summoner counter-play is immediate), engage
 *  (positioning), front-to-back (itemization), mobility (poke safety),
 *  utility (expect peel). Capped at 3 so the list stays skimmable even when
 *  a comp trips every threshold at once. */
export function deriveTakeaways(comp: AggregatedComp): string[] {
  const out: string[] = [];

  if (comp.cc >= CC_HEAVY_FLOOR) {
    out.push("Heavy CC — consider Cleanse or Tenacity");
  }
  if (comp.engage >= STRONG_ENGAGE_FLOOR) {
    out.push("Strong engage — respect all-ins");
  }
  if (comp.tankiness >= FRONT_TO_BACK_TANKINESS_FLOOR && comp.damage >= FRONT_TO_BACK_DAMAGE_FLOOR) {
    out.push("Front-to-back comp — anti-tank shred values up");
  }
  if (comp.mobility <= LOW_MOBILITY_CEILING) {
    out.push("Low mobility — long-range poke is safe");
  }
  if (comp.utility >= HIGH_UTILITY_FLOOR) {
    out.push("High utility — expect peel and disengage");
  }

  return out.slice(0, MAX_TAKEAWAYS);
}
