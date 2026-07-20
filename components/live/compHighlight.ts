// ─────────────────────────────────────────────────────────────────────────────
// compHighlight.ts — pure "comp-aware" highlight selection for the live
// situational-item panel (plan §2d / §3 compliance guardrail: "REORDERS
// flattenSituational output only — never invents recos").
//
// HONEST LIMITATION (flag this in review): this repo has NO per-champion
// damage-type/tag classification anywhere (lib/types.ts's ChampionRef is just
// {id,key,name,icon}), and matchup conditioning is the only real signal that
// could legitimately justify "this item is good against THIS comp" —
// lib/types.ts's Pick.matchupConditioned exists for exactly that, but per
// plan §0, BuildResponse.matchup.supported is ALWAYS false today (coachless
// 403s every matchup-conditioned request). Rather than fabricate a
// plausible-but-fictional "counters this champion" heuristic from static item
// names or a hand-rolled tag map (exactly the kind of pseudo-intelligent
// feature the compliance guardrail exists to prevent), this function only
// ever promotes picks the BACKEND has already flagged as matchup-conditioned.
// Today that means it always returns [] in practice (no live signal exists
// yet) — an honest empty state, not a fake one — and it activates for free,
// with zero code change here, the moment upstream matchup data goes live
// (per §0's own note: "the conditioning machinery... will activate
// automatically if upstream ever supports it").
// ─────────────────────────────────────────────────────────────────────────────

import type { Pick as PickType } from "@/lib/types";

/** Given the full (unsliced) flattenSituational() list and the currently
 *  known enemy champion ids, returns the ids (a SUBSET of `situational`'s own
 *  ids — never a fabricated id) that should render highlighted, in the order
 *  they should be prioritized. Returns [] when there's no live enemy comp
 *  known yet, or when no situational pick carries a real matchup-conditioned
 *  flag. */
export function selectCompAwareHighlights(situational: PickType[], enemyChampionIds: number[]): number[] {
  if (!enemyChampionIds || enemyChampionIds.length === 0) return [];
  return situational.filter((p) => p.matchupConditioned === true).map((p) => p.id);
}
