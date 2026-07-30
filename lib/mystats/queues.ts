// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/queues.ts — WHICH QUEUES COUNT AS A STAT. One constant, one
// place, imported by every read of coachbuild.my_matches.
//
// THE USER DIRECTIVE (2026-07-30): "dont count non SoloQ ranked games into the
// match performance or any other stat." Flex (440), normal draft (400),
// quickplay (480), swiftplay (2450), ARAM (450) and everything else are
// DIFFERENT GAMES — different queue, different meta, frequently a different
// role and a different intent — and averaging them into one win rate, one
// champion pool, one CS/min or one adherence figure produces a confident number
// that describes nobody's solo-queue performance. HARD RULE 4.
//
// READ-TIME, NOT INGEST-TIME. lib/mystats/ingest.ts deliberately stores EVERY
// queue with its real queue_id (one paginated match-id stream instead of four
// interleaved per-queue ones, and no game silently discarded before it is even
// looked at). Its header asserted that "filtering by queue happens at READ
// time" — and until this file existed, NOTHING filtered by queue at any read
// path. The comment described a contract with only one half built; this module
// is the other half. The non-420 rows stay in the table: they cost nothing,
// the one-stream ingest rationale still holds, and a future flex-queue view
// would want them.
//
// WHY A SET AND NOT A BARE `= 420`. The question "which queues count" has
// exactly one answer for the whole app, and this app has already been bitten
// four times by a cap/filter living in two places and drifting (the
// LIMIT 5 / LIMIT 20 split in app/api/mystats/summary/route.ts is the most
// recent). A named array also makes a future "count flex too" toggle a
// one-line change here rather than a grep-and-hope across six queries.
//
// HOW TO USE IT.
//   SQL  ->  AND queue_id = ANY(${COUNTED_QUEUE_IDS}::int[])
//   TS   ->  rows.filter((r) => isCountedQueue(r.queueId))
// Do not inline the number 420 anywhere else. lib/__tests__/mystats-queue-
// invariant.test.ts asserts structurally that every my_matches read binds this
// array, so a new query that forgets it fails the suite rather than shipping a
// quietly wrong average.
// ─────────────────────────────────────────────────────────────────────────────

/** Riot's queue id for ranked solo/duo — the ONLY queue My Stats counts.
 *  (440 = ranked flex, 400 = normal draft, 480 = quickplay, 450 = ARAM,
 *  2450 = swiftplay; all stored, none counted.) */
export const RANKED_SOLO_QUEUE_ID = 420;

/** THE queue set every My Stats figure is computed over. Exported as an array
 *  (not a Set) because its primary consumer is a Postgres `= ANY($1::int[])`
 *  bind, and a Set would have to be spread at every call site. */
export const COUNTED_QUEUE_IDS: readonly number[] = [RANKED_SOLO_QUEUE_ID];

/** Same decision as the SQL predicate, for rows already in memory. A null/
 *  undefined queue id is NOT counted: an unknown queue cannot be asserted to be
 *  solo/duo, and defaulting it in is exactly how an uncounted game becomes a
 *  counted one. */
export function isCountedQueue(queueId: number | null | undefined): boolean {
  return queueId != null && COUNTED_QUEUE_IDS.includes(queueId);
}

/** Human label for the scope, for anywhere a UI or a log needs to say what the
 *  numbers cover. Kept here so the wording cannot drift from the filter. */
export const COUNTED_QUEUE_LABEL = "Ranked Solo/Duo";
