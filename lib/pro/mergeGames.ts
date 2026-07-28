// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/mergeGames.ts — the soloq + prostage merge used by GET /api/pros.
//
// WHY THIS EXISTS (2026-07-28, user bug report: "for viktor it says only 4 out
// of 100 are pro games"). The merge used to be a plain recency sort + slice.
// That silently starves pro play out of any mixed sample, because the two
// sources have wildly different CADENCE, not different volume:
//
//   * a tracked pro plays solo queue most days -> soloq rows are dense and
//     always the newest rows in the window;
//   * official matches happen on match days -> prostage rows are sparse and
//     almost always older than the newest ~100 soloq rows.
//
// Measured live on Viktor mid, 90-day fresh window (2026-07-28):
//   94 prostage rows and 318 soloq rows exist in the DB, and a plain
//   recency-sorted top-100 returned 4 prostage / 96 soloq — the 96th-newest
//   soloq game was only ~1 day older than the newest pro-play game. So the
//   Pro Consensus card was ~96% solo queue while claiming to be a pro sample.
//
// The fix reserves a FLOOR of slots for the scarcer source. It invents
// nothing: every returned row is a real row, the result is still recency
// ordered, the floor is capped by how many prostage rows actually exist, and
// a floor can never shrink the total below what a plain merge would return
// (short side backfills from the other source).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProGame } from "./types";

function byRecencyDesc(a: ProGame, b: ProGame): number {
  return new Date(b.gameCreation).getTime() - new Date(a.gameCreation).getTime();
}

/** Merges the two per-source result sets into one recency-sorted list of at
 *  most `limit` games.
 *
 *  `proFloor` guarantees pro-play (prostage) rows at least that many slots
 *  WHEN THAT MANY EXIST — it is a floor, never a quota that pads with
 *  nothing and never a cap on how many prostage rows may appear (if soloq
 *  runs short, prostage backfills past the floor, and vice versa).
 *  `proFloor = 0` (the default) reproduces the original plain-merge
 *  behaviour byte for byte, which is what every caller that wants a pure
 *  "most recent games" list (the /history page) still passes. */
export function mergeProGames(
  soloq: ProGame[],
  prostage: ProGame[],
  limit: number,
  proFloor = 0
): ProGame[] {
  if (limit <= 0) return [];
  if (proFloor <= 0) {
    return [...soloq, ...prostage].sort(byRecencyDesc).slice(0, limit);
  }

  // Both arrays arrive pre-sorted from SQL (ORDER BY ... DESC), but sorting
  // here keeps this function correct on its own terms rather than dependent
  // on a caller's ORDER BY clause staying put.
  const pro = [...prostage].sort(byRecencyDesc);
  const solo = [...soloq].sort(byRecencyDesc);

  const reserved = Math.min(proFloor, pro.length, limit);
  const proTake = pro.slice(0, reserved);
  const soloTake = solo.slice(0, limit - reserved);

  // Backfill: if the non-reserved source came up short, spend the leftover
  // slots on whatever the reserved source still has. Without this, a floor
  // would make a sparse-soloq champion return FEWER games than before.
  const leftover = limit - reserved - soloTake.length;
  const proBackfill = leftover > 0 ? pro.slice(reserved, reserved + leftover) : [];

  return [...proTake, ...soloTake, ...proBackfill].sort(byRecencyDesc);
}
