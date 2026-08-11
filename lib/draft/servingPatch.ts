// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/servingPatch.ts — ONE definition of "which patch is /draft serving
// right now", shared by every reader of the draft tables.
//
// WHY THIS FILE EXISTS (v0.109.0). This query lived in TWO places —
// lib/draft/recommend.ts and app/api/draft/blind-pick/route.ts — as
// byte-similar copies, each with its own local SERVING_PATCH_MIN_CHAMPS, and
// the blind-pick copy's comment said "keep patch selection byte-for-byte
// aligned with /api/draft/recommend", which is a comment doing a compiler's
// job. Both copies carried the SAME defect, which is the point: they counted
// champions with NO `tier` predicate.
//
// That is not cosmetic. `tier` is a PARTITION KEY on draft_champ_stats, and
// v0.108.0 moved /draft from tier 10 to tier 15 without deleting the tier-10
// rows (see wiki/gotchas.md — the old partition is deliberately left in place,
// orphaned). So patch 16.14 carries 173 champ_ids at tier 10 whether or not it
// carries ANY at tier 15. A tier-blind count therefore reports "complete" for a
// patch whose SERVED tier is empty or half-ingested — defeating the exact guard
// SERVING_PATCH_MIN_CHAMPS exists to be.
//
// The concrete failure it permits: the tier-15 ingest is a ~42-minute batched
// walk over 173 champions with an explicit u.gg 403/429 fast-fail path. Kill it
// at champion 60 and the old code still marks 16.14 complete (173 tier-10
// champ_ids satisfy the bar), still serves it, and computeDraftRecommend reads a
// 60-champion pool — non-empty, so it never returns `pending`. The user gets a
// normal-looking ranked list computed against a third of the champions, with
// nothing on screen saying so. Counting inside the served partition makes that
// case fall through to `pending`, which is what it is.
// ─────────────────────────────────────────────────────────────────────────────

import type { getSql } from "@/lib/pro/db";
import { DIAMOND_2_PLUS_TIER } from "@/lib/draft/ugg";

type Sql = NonNullable<ReturnType<typeof getSql>>;

/** P3-1 (audit, 2026-07-21): a patch needs at least this many distinct
 *  champions present in draft_champ_stats FOR THE SERVED TIER before
 *  resolveServingPatch will treat it as "ready to serve" over an older, more
 *  complete patch — a brand-new patch mid-ingest (the cron processes ~40
 *  champs/tick, see app/api/ingest/draft/route.ts) would otherwise take over
 *  serving immediately at ~9-40 champions and show a near-empty pool for most
 *  lanes. ~173 total champions exist; 120 is comfortably past the
 *  first-few-cron-ticks partial state without waiting for a full 173/173.
 *
 *  Live check, patch 16.14 tier 15, 2026-08-11: 173/169/173/173/173 champions
 *  per role — the bar is met with room to spare on a completed walk, and is
 *  now measured against the partition actually being served. */
export const SERVING_PATCH_MIN_CHAMPS = 120;

/** The patch currently being served (plan §4: "meta from max(ingested_at) +
 *  latest patch present"; audit P3-1 refinement, 2026-07-21): prefers the
 *  most-recently-ingested patch that has ALREADY reached
 *  SERVING_PATCH_MIN_CHAMPS distinct champions IN THE SERVED TIER, so a
 *  brand-new patch mid-ingest never takes over serving from a genuinely
 *  complete older one.
 *
 *  Ordering: patches clearing the completeness bar sort first (as a group, by
 *  MAX(ingested_at) DESC among themselves); if NONE clear it yet (e.g. a fresh
 *  bootstrap, or the first hours of a new rank bucket), falls back to the
 *  newest patch present IN THIS TIER regardless of completeness — still a plain
 *  DB read, no network/patch-resolution call needed, and it can never point at
 *  a patch this tier's ingest hasn't touched AT ALL (unlike calling
 *  lib/draft/patch.ts's resolver directly, which reflects ddragon's newest
 *  release regardless of ingest progress).
 *
 *  Returns null when the served tier has no rows for any patch — callers must
 *  treat that as `pending`, never as an error. */
export async function resolveServingPatch(sql: Sql, tier: number = DIAMOND_2_PLUS_TIER): Promise<string | null> {
  const rows = (await sql`
    SELECT patch, count(DISTINCT champ_id)::int AS champs, MAX(ingested_at) AS latest
    FROM coachbuild.draft_champ_stats
    WHERE tier = ${tier}
    GROUP BY patch
    ORDER BY (count(DISTINCT champ_id) >= ${SERVING_PATCH_MIN_CHAMPS}) DESC, MAX(ingested_at) DESC
    LIMIT 1
  `) as unknown as { patch: string; champs: number; latest: string }[];
  return rows[0]?.patch ?? null;
}
