// ─────────────────────────────────────────────────────────────────────────────
// snowballStacks.ts — the SNOWBALL STACK item family: items you buy because a
// game is already won, not items you build to win it.
//
// ── The directive this exists to satisfy (user, 2026-07-29) ────────────────
// On BOTH consensus surfaces (Pro card and the featured one-trick card):
// "Mejai's must not count as one of the build items — put another full item in
// its place." The second half is the load-bearing half. Removing an id from a
// list that has ALREADY been truncated to six leaves a five-item build with a
// hole in it; the exclusion has to happen while the seventh-most-built item is
// still on the table, so it takes the freed slot. Every consumer below filters
// BEFORE it slices. That ordering is the whole fix.
//
// ── Why an explicit id list, not a heuristic ───────────────────────────────
// This repo already reasons about exactly this class, and the reasoning is
// worth restating because it is the justification for the list:
// itemSetBody.ts's `GEM_WINRATE_CEILING_PP` exists because Ahri's top "hidden
// gem" came back as Mejai's Soulstealer at 78.5% over 8,149 games. Huge sample,
// real winrate, and still a terrible recommendation — the winrate measures the
// games Mejai's GETS BOUGHT IN, not the effect of buying it. That guard is a
// statistical one (drop anything more than +10pp over the pool median) and it
// works for a winrate-ranked pool. It cannot help here at all: these two
// surfaces rank by BUILD RATE, and a one-trick who snowballs often genuinely
// does finish 40% of their games holding Mejai's. The number is true. It is
// just not a build slot.
//
// A "usually drops it" heuristic is worse than a list of two integers: the user
// named the item, and a statistical rule that silently keeps Mejai's on one
// champion and drops a real item on another is a bug nobody can see. So this is
// an ENUMERATION, and it carries the same warning STARTING_ITEM_ALLOWLIST
// carries — an enumeration rots (that one shipped Doran's Bow inside completed
// build lines twice). The mitigation here is that the family is closed by
// construction rather than by fashion: a snowball stack is an item whose stats
// GROW from a counter that only advances on kills/assists, and Riot has shipped
// exactly two of them for a decade. Add an id when Riot adds one; do not expect
// this list to catch a class it was never given.
//
// ── Dark Seal is on this list and is deliberately a NO-OP on both surfaces ──
// 1082 is already held out of every completed-item list upstream, twice over:
// proConsensus.ts's `STARTING_ITEM_ALLOWLIST` partitions it into the card's own
// `starters` slot (2026-07-22 hard directive), and itemSetBody.ts's `isFullItem`
// catches it structurally as a from-nothing, cheap, Lane-tagged starter. It is
// listed here because the FAMILY is "stat stacks bought off a kill counter" and
// omitting one member of a named family invites the next reader to conclude it
// was considered and rejected.
//
// It must NOT be applied to the starter partition. Dark Seal in an "Opens"
// slot is a real, useful read on how a player plays the lane (the featured card
// shows exactly that — Dun opens Dark Seal in nearly 6 games of 10) and the
// user's directive was about BUILD ITEMS, not openers. Every call site below
// therefore applies this to completed-item lists only. Applying it to
// `starters` would be a regression, not extra safety.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Items whose value is a stack counter that only advances on kills/assists.
 *
 * - `3041` **Mejai's Soulstealer** — 25 AP base, +5 AP per stack to 25 stacks,
 *   stacks gained on takedowns and lost on death. The item the directive names.
 * - `1082` **Dark Seal** — the 350g version of the same mechanic, and the item
 *   Mejai's is built from. See the header: already excluded everywhere a
 *   completed item is listed, present here for family completeness only.
 */
export const SNOWBALL_STACK_ITEM_IDS: ReadonlySet<number> = new Set<number>([3041, 1082]);

/**
 * True when `itemId` is a snowball stack — an item bought because a game is
 * already won, which a plain build-rate ranking cannot tell apart from a core
 * item.
 *
 * Apply this to COMPLETED-ITEM lists only, and apply it BEFORE the list is
 * truncated to N so the next-most-built item backfills the freed slot. Never
 * apply it to a starter/opener slot — see the module header.
 */
export function isSnowballStackItem(itemId: number): boolean {
  return SNOWBALL_STACK_ITEM_IDS.has(itemId);
}
