// ─────────────────────────────────────────────────────────────────────────────
// skillOrderModel.ts — the RECOMMENDED ability-levelling order model.
//
// PURE. No fetch, no I/O, no clock. lib/opgg.ts owns the network half and
// hands the already-parsed source values in here; this module owns every
// judgement call about what those values MEAN and, crucially, what we are
// NOT entitled to conclude from them.
//
// ── NOT to be confused with the per-game skill order ────────────────────────
// `lib/pro/extract.ts`'s buildSkillOrder + `components/skillOrderGrid.ts`
// render ONE PRO GAME's actual levelling path, extracted from that game's
// Riot timeline. That is a measured fact about a single game. THIS module is
// an AGGREGATE RECOMMENDATION across many ranked games. Different thing,
// different provenance, deliberately separate code.
//
// ── House rule: never present judgement as measured ─────────────────────────
// (Repo CLAUDE.md hard rule #4, and the same posture proConsensus.ts's header
// documents for its denominators.) The upstream source publishes only levels
// 1-15. Levels 16-18 are therefore NOT measured — they are DERIVED, or they
// are absent. There is no third option and there is no padding:
//   * `completed: true`  — 16-18 were derived by completeSkillOrder's
//                          arithmetic below, from this champion's own
//                          published rank caps plus a max-priority order.
//   * `completed: false` — the derivation refused. `order` then carries ONLY
//                          the 15 levels the source actually reported, and
//                          the UI must render nothing beyond level 15.
// A caller MUST NOT treat a 15-long order as "18 with three unknowns to fill
// in" — the whole point is that we do not know them.
//
// ── DERIVED IS NOT MEASURED, AND THE MODEL NOW SAYS WHICH IS WHICH ──────────
// `completed: true` used to be the only signal that a tail existed, which left
// every consumer free to render all 18 levels as if the source had published
// them. It had not. Two fields close that:
//   * `observedLevels`  — how many LEADING entries of `order` came verbatim
//                         from the source. Everything at a higher index is
//                         OURS. Read it through `observedLevelCount()` /
//                         `isDerivedLevel()`, never raw (see those helpers for
//                         the back-compat case).
//   * `completionBasis` — WHICH priority resolved the tail: op.gg's own
//                         published max order (`"published"`, measured over a
//                         far larger sample than the order itself) or one
//                         inferred from the observed path (`"derived"`).
// The Builds card and the desktop overlay both render the derived tail
// differently from the source levels. That is a requirement, not a nicety: a
// tail presented as measured is exactly the fabrication hard rule #4 forbids.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ability, ChampionKit, SkillOrderModel } from "./types";
import {
  STANDARD_KIT,
  TOTAL_LEVELS,
  ULTIMATE_LEVELS,
  isUltimateRankLegal,
  purchasableUltimateRanks,
  tailUltimateRanks,
} from "./championKit";

export type { Ability, ChampionKit, SkillOrderModel };
export { STANDARD_KIT, TOTAL_LEVELS, ULTIMATE_LEVELS };

/** The three basic abilities, in Riot's canonical slot order. Used as the
 *  last-resort tie-break so the output is deterministic, never arbitrary. */
export const BASIC_ABILITIES: readonly Ability[] = ["Q", "W", "E"] as const;

/** League's standard rank model — 5/5/5/3, correct for 166 of 173 champions.
 *
 *  NO LONGER THE ONLY MODEL. It is now the DEFAULT kit, not a universal
 *  truth: the real caps are published per champion by Data Dragon and are
 *  threaded in as `kit` (see lib/championKit.ts's header for the seven
 *  champions this is wrong for, and the evidence behind each). Retained as an
 *  export because it is still the honest fallback when no kit is supplied,
 *  and because tests and callers legitimately reference the standard caps. */
export const MAX_RANKS: Readonly<Record<Ability, number>> = STANDARD_KIT.maxRanks;

/** What the upstream source actually publishes: levels 1-15 only. */
export const SOURCE_LEVELS = 15;

const ABILITY_SET = new Set<string>(["Q", "W", "E", "R"]);

export function isAbility(v: unknown): v is Ability {
  return typeof v === "string" && ABILITY_SET.has(v);
}

/** Rank count per ability across a (partial) levelling path. */
export function countRanks(order: readonly Ability[]): Record<Ability, number> {
  const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
  for (const a of order) counts[a] += 1;
  return counts;
}

/** Level numbers (1-based) at which each ability is ranked up.
 *  Index 0 of `order` is level 1. Abilities never ranked get an empty array —
 *  never a fabricated placeholder. */
export function levelsByAbility(order: readonly Ability[]): Record<Ability, number[]> {
  const levels: Record<Ability, number[]> = { Q: [], W: [], E: [], R: [] };
  order.forEach((a, i) => {
    levels[a].push(i + 1);
  });
  return levels;
}

/**
 * Derive the max-priority order of the BASIC abilities from an observed path,
 * used only when the source doesn't supply its own priority (or supplies one
 * we can't validate).
 *
 * The rule that actually matches how players talk about priority: the ability
 * you MAX FIRST is the highest priority. So rank by the level at which each
 * ability reaches its 5th point, ascending; an ability that never reaches 5
 * sorts after every ability that does. Ties break on first-point level, then
 * on canonical Q/W/E order so the result is fully deterministic.
 *
 * NOTE this is deliberately NOT "sort by total rank count, descending" — that
 * naive rule gets Ahri wrong. Ahri's observed 15 has Q:5 and W:5 (a tie on
 * count) but Q hits its 5th point at level 9 and W not until level 13, so the
 * real priority is Q>W>E. A count-based sort would tie and then fall back to
 * first-appearance, where W (level 1) precedes Q (level 2), yielding W>Q>E —
 * backwards. Verified against Ahri mid, 2026-07-27.
 *
 * "Maxed" is now read PER ABILITY off the kit rather than off one shared
 * basic cap. That matters for Yuumi, whose Q caps at 6 while W and E cap at 5:
 * a shared cap of 5 would call her Q "maxed" at its 5th point and rank her
 * priority off a level she has not actually reached yet.
 */
export function derivePriority(
  order: readonly Ability[],
  kit: ChampionKit = STANDARD_KIT
): Ability[] {
  const seenAt: Record<Ability, number[]> = levelsByAbility(order);

  return [...BASIC_ABILITIES].sort((a, b) => {
    const la = seenAt[a];
    const lb = seenAt[b];
    // Level at which the ability was maxed; Infinity when it never was.
    const capA = kit.maxRanks[a];
    const capB = kit.maxRanks[b];
    const maxedA = la.length >= capA ? la[capA - 1] : Infinity;
    const maxedB = lb.length >= capB ? lb[capB - 1] : Infinity;
    if (maxedA !== maxedB) return maxedA - maxedB;
    const firstA = la.length ? la[0] : Infinity;
    const firstB = lb.length ? lb[0] : Infinity;
    if (firstA !== firstB) return firstA - firstB;
    return BASIC_ABILITIES.indexOf(a) - BASIC_ABILITIES.indexOf(b);
  });
}

/** Why a completion was refused. Diagnostic only — never rendered as data,
 *  but logged/asserted in tests so a refusal is explainable, not mysterious. */
export type CompletionRefusal =
  | "already-complete"
  | "unexpected-length"
  | "bad-token"
  | "rank-over-cap"
  | "ultimate-remainder"
  | "tail-mismatch"
  /** The champion's purchasable ranks total FEWER than the 18 points a game
   *  grants, so no complete 18-level path exists for them at all — there is
   *  nothing left to spend the last points on.
   *
   *  NARROWED 2026-07-27. This used to fire for `purchasableTotal !== 18`,
   *  i.e. for the SURPLUS champions too (Yuumi 19, Aphelios 21, Udyr 24), on
   *  the reasoning that a champion who must skip a point makes the tail
   *  undecidable. That reasoning was one step short: the source publishes a
   *  max-priority order (`skill_masteries.ids`) over a LARGER sample than the
   *  order itself, and walking it under the champion's own caps decides which
   *  point is skipped without inventing anything. Surplus kits now complete
   *  when that walk lands exactly 18 legal points, and refuse as
   *  `priority-exhausted` when it does not.
   *
   *  TWO triggers, and the second is the load-bearing one:
   *    (a) `purchasableTotal < 18` — a kit that cannot fill 18 points at all.
   *        No champion on the current roster is like this; it is asserted in
   *        tests rather than assumed absent.
   *    (b) a SURPLUS kit with no well-formed PUBLISHED priority. A derived
   *        priority cannot rank R (see (3c) in `completeSkillOrder`), so for
   *        a surplus kit it is not a weaker signal — it is a blind one, and
   *        completing from it would invent the very choice this module exists
   *        to refuse. Reachable in principle whenever op.gg omits or reshapes
   *        `skill_masteries`; not reached by any live payload probed to date. */
  | "kit-not-derivable"
  /** Walking the max-priority order ran out of abilities still under their
   *  cap before all 18 points were placed. The tail is then genuinely
   *  unresolved — the priority we hold does not name anything left to spend
   *  on — so the observed 15 are returned untouched.
   *
   *  REACHABLE, unlike the two "can't happen" refusals below and above it. A
   *  DERIVED priority never names R, so a surplus champion whose spare ranks
   *  sit mostly in the R slot can exhaust its three basics; that is precisely
   *  the case a published `ids` list rescues. Not hit by any champion's live
   *  order today, but the difference between "not hit today" and "cannot
   *  happen" is the whole reason this is a named refusal rather than an
   *  assertion. */
  | "priority-exhausted"
  /** A derived tail entry would rank the ultimate at a level this champion's
   *  own schedule does not allow. Distinct from lib/nextSkill.ts's
   *  `ultimate-illegal`, which judges a LIVE instruction; this one judges a
   *  level we ourselves chose, so it firing would mean the allocator, not the
   *  source, produced an illegal path. See the check for why it is currently
   *  unreachable by arithmetic and tested anyway. */
  | "ultimate-illegal-tail";

/** Which priority resolved a derived tail. `"published"` is op.gg's own
 *  `skill_masteries.ids`; `"derived"` is `derivePriority`'s reading of the
 *  observed path. Published is preferred wherever it is well-formed — it is
 *  measured over a far larger sample (Udyr: 17,186 games vs the order's
 *  9,670) and it is the only source that ranks the R slot at all. */
export type PriorityBasis = "published" | "derived";

export interface CompletionResult {
  order: Ability[];
  completed: boolean;
  /** Present only when `completed` is false. */
  refusedBecause?: CompletionRefusal;
  /** How many LEADING entries of `order` came verbatim from the source.
   *  Equals `order.length` on every refusal (nothing was derived) and
   *  `SOURCE_LEVELS` on every successful completion. */
  observedLevels: number;
  /** Which priority resolved the tail. Present only when `completed`. */
  basis?: PriorityBasis;
}

/**
 * Complete a 15-level observed path to the full 18 levels — BY DERIVATION,
 * NEVER BY GUESSING.
 *
 * ── The derivation, case 1: the caps DETERMINE the tail (170 champions) ─────
 * A champion has exactly 18 ability points. So given a first 15 levels that
 * provably fit THIS CHAMPION'S OWN caps, and a champion whose purchasable
 * ranks total exactly 18, the remaining 3 points are fully DETERMINED by
 * subtraction — there is nothing to guess. Ahri mid, for example, has Q:5 W:5
 * E:3 R:2 across levels 1-15, leaving exactly R×1 and E×2. The ultimate takes
 * level 16 (6/11/16 are the only ultimate levels), and the two E points fall
 * at 17 and 18. That is arithmetic, not opinion, and it reproduces U.GG's
 * published Ahri path exactly (cross-checked 2026-07-27).
 *
 * ── The derivation, case 2: the PRIORITY resolves it (Udyr/Yuumi/Aphelios) ──
 * Three champions have MORE purchasable ranks than the 18 points a game grants
 * — Yuumi 19, Aphelios 21, Udyr 24 — so subtraction alone leaves the tail
 * ambiguous and this function used to refuse them outright. It no longer has
 * to, because the source publishes the missing fact IN THE SAME RESPONSE:
 * `skill_masteries.ids` is op.gg's max-priority order, the sequence in which
 * players actually max abilities, measured over a LARGER sample than the
 * levelling order itself. lib/opgg.ts parses it into `priorityIds`.
 *
 * Udyr jungle is the worked example, and it is the report this change answers.
 * His published 15 is Q6 W2 E6 R1 against caps of 6/6/6/6, so Q and E are
 * already maxed at level 15 and the last 3 points could legally go to W or to
 * R in several distributions. His published priority is ["Q","E","W","R"]
 * (17,186 games): Q maxed, E maxed, W next and 4 ranks under its cap, so the
 * three points are W's. Final: Q6 W5 E6 R1 = 18. Derived, not invented — and
 * `completionBasis: "published"` says exactly which datum decided it.
 *
 * The allocator is deliberately the same one in both cases: walk the priority,
 * give each ability as many of the remaining points as its own cap allows,
 * stop at 18. For a case-1 champion the caps leave exactly 3 points and the
 * walk therefore places precisely what subtraction already determined — which
 * is why this generalisation changed no standard champion's output.
 *
 * ── The caps are now the CHAMPION'S, not a constant ────────────────────────
 * This used to hardcode 5/5/5/3 and therefore refused four popular champions
 * outright. The caps arrive as `kit` (lib/championKit.ts, sourced from
 * ddragon); omitting it falls back to STANDARD_KIT, which is what every
 * caller got before. Two consequences worth stating, because both are
 * champions that USED to be refused and now complete cleanly:
 *
 *   * JAYCE (6/6/6/1) — his basics alone total 18 and his Transform is free
 *     at level 1, so his tail is three BASIC points and no ultimate at all.
 *     `tailUltimateRanks` returns 0 for him, straight off his own legality
 *     schedule, so the "exactly one R at level 16" rule generalises instead
 *     of being special-cased.
 *   * KARMA / ELISE / NIDALEE (5/5/5/4) — one free R rank at level 1 plus
 *     three purchased, so they have 18 purchasable ranks and behave exactly
 *     like a standard champion from this function's point of view.
 *
 * Yuumi, Aphelios and Udyr still refuse, but for the HONEST reason now
 * (`kit-not-derivable`: more purchasable ranks than points, so the player
 * must skip something and we cannot know what) rather than because their
 * ranks broke a cap that was never theirs.
 *
 * ── The refusals (this is the important half) ──────────────────────────────
 * Every one of these returns the observed 15 with `completed: false` rather
 * than emitting a wrong 18-level path:
 *
 *  (1) `unexpected-length` — not exactly 15 observed levels. An already-18
 *      path is reported separately as `already-complete`: it is returned
 *      untouched and STILL flags `completed: false`, because `completed`
 *      means "we derived 16-18", and there we derived nothing.
 *  (2) `bad-token`        — something that isn't Q/W/E/R.
 *  (3) `rank-over-cap`    — an ability already exceeds ITS OWN cap by level
 *      15, so the subtraction would go negative. Still arithmetic on the
 *      champion's own data, never a hardcoded blocklist — but the number it
 *      compares against is now that champion's real published cap, so a Jayce
 *      ranking Q six times is correct rather than a refusal.
 *  (3b) `kit-not-derivable` — the champion's purchasable ranks exceed the 18
 *      points a game grants (Yuumi/Aphelios/Udyr), so the tail depends on
 *      which point the player chooses to skip. Checked BEFORE the cap check
 *      so these three report why they are really undecidable.
 *  (4) `ultimate-remainder` — CASE-1 KITS ONLY. The tail needs a different
 *      number of ultimate ranks than the champion's own legality schedule
 *      leaves room for in levels 16-18. For every gated kit that room is
 *      exactly one (level 16); for Jayce, whose only R rank is free at level
 *      1, it is zero. A surplus kit cannot be judged this way — it has spare
 *      ranks everywhere by construction — so the allocator's own
 *      `priority-exhausted`/`ultimate-illegal-tail` checks cover it instead.
 *  (5) `tail-mismatch`    — belt-and-braces: the computed remainder doesn't
 *      total 3. Unreachable if (1)+(3) hold, and asserted in tests precisely
 *      because "can't happen" is a claim worth testing rather than trusting.
 *  (6) `priority-exhausted` — the abilities NAMED by the priority have fewer
 *      ranks left between them than the tail needs. Not reached by any
 *      champion's published order on the current roster (checked against the
 *      live 15 of all three surplus kits), but NOT unreachable in principle,
 *      and the sweep test finds it: a Yuumi-shaped kit whose observed 15
 *      spends no point on R leaves only ONE basic rank under a cap while the
 *      tail needs two, and a DERIVED priority — which never names R — cannot
 *      place the rest. A published priority naming R resolves that same
 *      input, which is the clearest available statement of what the ids buy.
 *      Refusing is mandatory: the alternative is a short order flagged
 *      `completed`, the one outcome this module exists to prevent.
 *  (7) `ultimate-illegal-tail` — a tail entry would rank R at a level the
 *      champion's own schedule forbids. Unreachable by arithmetic on real
 *      data (no published schedule gates a rank past level 16, and the tail
 *      is levels 16-18), and proven to fire against a synthetic later-gated
 *      kit in the tests rather than assumed to be wired up.
 *
 * ── NON-STANDARD CHAMPIONS — MEASURED, not guessed ─────────────────────────
 * Sweep against live op.gg data, each champion on its primary lane
 * (2026-07-27), re-read against ddragon's published caps (see
 * lib/championKit.ts). Behaviour WITH per-champion caps threaded in:
 *
 *   most  complete cleanly — the standard 5/5/5/3 majority, PLUS JAYCE,
 *         KARMA, ELISE and NIDALEE, which the old hardcoded 5/5/5/3 refused
 *         outright.
 *      7  complete, but their published order ranks R at level 12 (see below).
 *      3  complete via the PUBLISHED max-priority order — UDYR, YUUMI,
 *         APHELIOS. These were `kit-not-derivable` refusals until the surplus
 *         path landed; their orders and `skill_masteries.ids` were re-probed
 *         live on 2026-07-27 to confirm. They REFUSE again, deliberately, if
 *         that publication is ever absent or malformed — see (3c) below.
 *      1  refused, `bad-token` — KHAZIX (his `R-Q`/`R-W` evolution tokens).
 *
 * DELIBERATELY NOT GIVING EXACT PER-BUCKET COUNTS. This block previously read
 * "172-champion sweep / 164 + 7 + 3 + 1", which sums to 175 against a 173-champion
 * roster, and the buckets overlap ambiguously (do the seven R-at-12 champions sit
 * inside "complete cleanly" or beside it?). An audit caught it 2026-07-27. Rather
 * than reshuffle the numbers until they add up — which would read as measured
 * while being reconstructed — the counts that were not re-verified are stated as
 * shapes. The per-champion facts below WERE re-probed live and are exact.
 * Re-running the full sweep is the only way to restore honest totals.
 *
 *  * UDYR    — four basics, no true ultimate; 6/6/6/6 = 24 purchasable ranks
 *              against 18 points. His published order ranks "R" at LEVEL 2,
 *              which is legal for him and is no longer refused as an illegal
 *              ultimate. ids ["Q","E","W","R"] → tail WWW → Q6 W5 E6 R1.
 *  * APHELIOS— 6/6/6/3 = 21 purchasable ranks against 18 points, so he must
 *              skip three. ids ["Q","E","W"] → tail R@16,W,W → Q6 W3 E6 R3.
 *              (This line used to claim "W is a fixed 1-rank mechanic", which
 *              contradicted both the 6-rank W cap on the same line and the W3
 *              final count on the next one. His W is rankable like any basic;
 *              it simply ends at 3 because Q and E out-rank it in the order.)
 *  * YUUMI   — 6/5/5/3 = 19 purchasable; she skips exactly one point.
 *              ids ["Q","E","W"] → tail R@16,W,W → Q6 W4 E5 R3.
 *  * JAYCE   — 6/6/6/1. Now COMPLETES: his Transform is granted free at level
 *              1, leaving 6+6+6 = 18 purchasable basics, so his tail is E,E,E
 *              at 16/17/18 with no ultimate. Previously refused outright,
 *              which is the bug a real user reported.
 *  * KARMA / ELISE / NIDALEE — 5/5/5/4, one free R rank at level 1. Now
 *              complete cleanly. These three were NOT in the original sweep's
 *              refusal list because their observed 15 fit the standard caps;
 *              they were instead mishandled LIVE (see lib/nextSkill.ts).
 *  * KHAZIX  — the one nobody would have predicted: his ultimate ranks carry
 *              EVOLUTION suffixes, so the order contains the literal tokens
 *              "R-Q" and "R-W" rather than "R". lib/opgg.ts rejects the whole
 *              payload on that (→ no card) rather than normalising a token
 *              grammar we have exactly one example of. Mapping "R-Q"→"R" would
 *              complete him to a clean 5/5/5/3 and look perfectly right, while
 *              silently discarding WHICH ability he evolves — the part a
 *              Kha'Zix player actually reads. Deliberately left as no-card;
 *              see HANDOFF-engy.md if it's ever worth doing properly.
 *  * KAYN    — flagged as a "form swapper" risk up front, but the data says
 *              his ranks ARE standard 5/5/5/3, so he completes normally. The
 *              arithmetic decides, never a reputation-based blocklist.
 *
 * ── Why the OBSERVED path gets no ultimate-level legality check ────────────
 * (The DERIVED tail does — check (7). The distinction is the whole point: we
 * are not entitled to correct the source's aggregate, but we are absolutely
 * responsible for the three levels we choose ourselves.)
 *
 * An earlier draft was going to refuse any observed path ranking R outside
 * League's legal 6/11/16. The sweep killed that idea: SEVEN champions — JINX,
 * ZED, KASSADIN, SIVIR, CORKI, ZERI, QIYANA — publish R at levels 6 and *12*.
 * Level 12 is not a legal ultimate level, which tells us something useful:
 * the published order is a PER-LEVEL MODAL AGGREGATE across many games, not a
 * single legal levelling path. That does not harm the derivation one bit —
 * the tail depends only on the rank COUNTS, which are standard for all seven
 * — so the check would have refused seven popular champions to buy nothing.
 * Their observed 15 is passed through exactly as published, unaltered.
 * ───────────────────────────────────────────────────────────────────────────
 */
export function completeSkillOrder(
  observed: readonly Ability[],
  priority?: readonly Ability[],
  kit: ChampionKit = STANDARD_KIT
): CompletionResult {
  const refuse = (because: CompletionRefusal): CompletionResult => ({
    order: [...observed],
    completed: false,
    refusedBecause: because,
    observedLevels: observed.length,
  });

  // (2) token validity first — everything below assumes real abilities.
  if (!observed.every(isAbility)) return refuse("bad-token");

  // (1) length.
  if (observed.length === TOTAL_LEVELS) return refuse("already-complete");
  if (observed.length !== SOURCE_LEVELS) return refuse("unexpected-length");

  // (3b) A kit whose purchasable ranks total FEWER than 18 has no complete
  // path at all — there would be nothing left to spend the last points on.
  // A kit with MORE than 18 (Yuumi/Aphelios/Udyr) is fine and is resolved by
  // the priority walk below; see this function's "case 2".
  if (kit.purchasableTotal < TOTAL_LEVELS) return refuse("kit-not-derivable");

  const counts = countRanks(observed);

  // (3) cap check, against THIS CHAMPION'S caps. The `order` counts points
  // SPENT, so the R slot is compared against purchasable ranks — a free
  // level-1 form-swap rank never appears in the order and must not be
  // budgeted for here (Jayce's purchasable R is 0, not 1).
  const caps: Record<Ability, number> = {
    Q: kit.maxRanks.Q,
    W: kit.maxRanks.W,
    E: kit.maxRanks.E,
    R: purchasableUltimateRanks(kit),
  };
  for (const ability of ["Q", "W", "E", "R"] as const) {
    if (counts[ability] > caps[ability]) return refuse("rank-over-cap");
  }

  const remaining: Record<Ability, number> = {
    Q: caps.Q - counts.Q,
    W: caps.W - counts.W,
    E: caps.E - counts.E,
    R: caps.R - counts.R,
  };

  const tailSlots = TOTAL_LEVELS - SOURCE_LEVELS;
  // Case 1 vs case 2 (see this function's header). A kit whose purchasable
  // ranks total exactly 18 has a tail FULLY DETERMINED by subtraction, and the
  // two checks below are what make that determinacy a checked property rather
  // than a hope. A surplus kit has spare ranks by construction, so neither
  // check means anything for it and applying them would refuse three
  // champions whose tails the priority can in fact resolve.
  const determinate = kit.purchasableTotal === TOTAL_LEVELS;

  // (3c) A SURPLUS kit may only be completed from a PUBLISHED priority.
  //
  // This is the gate that makes "data-backed, not invented" true rather than
  // merely intended, and it is subtle enough to be worth the paragraph.
  // `derivePriority` sorts `BASIC_ABILITIES` — Q/W/E — so it can NEVER rank R.
  // For a determinate kit that is harmless: subtraction has already fixed the
  // multiset, and the priority only ORDERS points that were forced anyway.
  // For a surplus kit it is decisive, because the spare ranks are exactly what
  // the walk has to choose between.
  //
  // Udyr is the worked example. `kitFromMaxRanks([6,6,6,6])` yields
  // `ultimateLevels: null`, so `tailUltimateRanks` is 0 — there is no forced
  // level-16 R, and all three tail slots are genuinely contested between W
  // (4 spare) and R (5 spare). A derived priority yields `WWW`; a published
  // `["Q","E","R","W"]` yields `RRR`. The derived answer is not W-beats-R, it
  // is R-was-never-on-the-ballot — so when it happens to agree with the
  // published order that is agreement by blindness, not corroboration.
  //
  // `priority-exhausted` below does NOT cover this. It fires only when the
  // walk runs out of abilities under their cap; Udyr's derived W has 4 spare
  // for 3 slots, so it never exhausts — it silently completes, wrongly.
  // Compounding it, `determinate` has just switched OFF both `ultimate-
  // remainder` and `tail-mismatch`, so this path would run with every other
  // structural guard already disabled.
  //
  // Refusing costs nothing real: op.gg publishes `skill_masteries.ids` for all
  // three surplus champions (probed live 2026-07-27, samples 1.8-4.3x larger
  // than the levelling order). This fires only when that publication is
  // ABSENT or malformed — i.e. exactly when we would otherwise be guessing.
  if (!determinate && !isWellFormedPriority(priority)) return refuse("kit-not-derivable");

  // (4) The tail must need exactly as many ultimate ranks as this champion's
  // OWN legality schedule leaves room for in levels 16-18 — one (level 16)
  // for every gated kit, zero for Jayce whose single R rank is free at level
  // 1. Derived from the schedule, not assumed to be 1.
  const tailUlts = tailUltimateRanks(kit, SOURCE_LEVELS);
  if (determinate && remaining.R !== tailUlts) return refuse("ultimate-remainder");

  // (5) unreachable given (1)+(3), asserted anyway.
  if (determinate && remaining.Q + remaining.W + remaining.E + remaining.R !== tailSlots) {
    return refuse("tail-mismatch");
  }

  // Any ultimate rank the schedule opens up inside 16-18 is taken FIRST, i.e.
  // at level 16 — conventionally, and for a determinate kit necessarily, since
  // 16 is the only ultimate level in the tail and the rank has to go
  // somewhere. Bounded by what R actually has left so a surplus kit whose
  // published order already spent every R rank cannot be handed a 4th.
  const forcedUlts = Math.min(tailUlts, remaining.R);

  // ── The allocator ────────────────────────────────────────────────────────
  // Walk the max-priority order, giving each ability as many of the remaining
  // points as ITS OWN cap allows, until all 18 are placed. For a determinate
  // kit this places exactly what subtraction already fixed (the caps leave
  // precisely `tailSlots` points), so standard champions are unaffected; for a
  // surplus kit it is the step that decides which point gets skipped, and it
  // decides it from published data rather than from taste.
  const { priority: allocationPriority, basis } = resolveAllocationPriority(priority, observed, kit);
  const spare: Record<Ability, number> = { ...remaining, R: remaining.R - forcedUlts };
  const tail: Ability[] = Array<Ability>(forcedUlts).fill("R");
  for (const ability of allocationPriority) {
    while (spare[ability] > 0 && tail.length < tailSlots) {
      tail.push(ability);
      spare[ability] -= 1;
    }
    if (tail.length >= tailSlots) break;
  }

  // (6) The priority named nothing left to spend on. A short "completed" order
  // is the one outcome this module exists to prevent, so refuse instead.
  if (tail.length !== tailSlots) return refuse("priority-exhausted");

  // (7) Ultimate legality across the levels WE chose. `isUltimateRankLegal`
  // wants the rank the game would report, so the champion's free level-1 rank
  // is added back in — `counts` only ever holds ranks that cost a point.
  const running: Record<Ability, number> = { ...counts };
  for (let i = 0; i < tail.length; i += 1) {
    const ability = tail[i];
    running[ability] += 1;
    if (ability !== "R") continue;
    if (!isUltimateRankLegal(running.R + kit.freeRanks.R, SOURCE_LEVELS + 1 + i, kit)) {
      return refuse("ultimate-illegal-tail");
    }
  }

  const order: Ability[] = [...observed, ...tail];

  // Final structural guarantee before we dare set completed: true.
  if (order.length !== TOTAL_LEVELS) return refuse("tail-mismatch");

  return { order, completed: true, observedLevels: observed.length, basis };
}

/**
 * Fill the levels `completeSkillOrder` REFUSED to derive, from the champion's
 * max-priority order — a GUESS, named as one, and never mixed into `order`.
 *
 * ── Why this exists, and why it is not a softening of the refusals ──────────
 * User directive 2026-07-29: the recommended skill order must always read as a
 * full 18 levels, "as all websites I see do that." That is a real ask — a grid
 * that stops at 15 looks broken next to every reference site — and it is
 * COMPATIBLE with this module's honesty rule, but only if the two are kept
 * structurally apart. So:
 *
 *   * `order`, `levels`, `completed`, `observedLevels` and `completionBasis`
 *     are UNTOUCHED by this function. Every existing consumer — most
 *     importantly lib/nextSkill.ts, which drives a LIVE in-game instruction and
 *     deliberately goes silent past level 15 on an incomplete order — sees
 *     exactly what it saw before. Inferred data is fine on a reference grid the
 *     player reads at their own pace; it is not obviously fine as live
 *     instruction, and that call is not this function's to make.
 *   * the guess is carried in its OWN field (`inferredTail`) so a consumer has
 *     to opt into it, and any consumer that renders it must render it as
 *     visibly inferred (SkillOrderCard: dashed chips + a plain caption).
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * The same allocator `completeSkillOrder` uses, minus every structural guard
 * that would refuse: walk the max-priority order, give each ability as many of
 * the remaining points as ITS OWN cap allows, stopping when the 18 levels are
 * filled. Any ultimate rank the champion's schedule opens up in the tail is
 * taken first, exactly as in the derivation.
 *
 * Two refusals SURVIVE, because both would make the guess actively wrong
 * rather than merely unproven:
 *
 *   1. `kit === null` at the call site (see `buildSkillOrderModel`) — the
 *      champion is known non-standard and ddragon did not resolve, so the caps
 *      this walk needs are precisely what is missing. Guessing under
 *      STANDARD_KIT there reintroduces the blank-Jayce bug's wrong arithmetic.
 *   2. a bad token (Kha'Zix's `R-Q`/`R-W`) — lib/opgg.ts already rejects that
 *      payload upstream, so this is a belt-and-braces guard rather than a live
 *      path.
 *
 * A SHORT tail is returned rather than padded: if the priority names nothing
 * left under a cap, those levels stay empty in the grid. Filling them by
 * ignoring the champion's own rank caps would emit a path the game does not
 * allow, which is worse than a gap.
 *
 * Returns `null` when there is nothing to infer (already 18 levels, no valid
 * order, or the walk placed nothing) — never an empty-array "success".
 */
export function inferSkillOrderTail(
  observed: readonly Ability[],
  priority?: readonly Ability[],
  kit: ChampionKit = STANDARD_KIT
): { tail: Ability[]; basis: PriorityBasis } | null {
  if (!Array.isArray(observed) || !observed.length) return null;
  if (!observed.every(isAbility)) return null;
  const slots = TOTAL_LEVELS - observed.length;
  if (slots <= 0) return null;

  const counts = countRanks(observed);
  const caps: Record<Ability, number> = {
    Q: kit.maxRanks.Q,
    W: kit.maxRanks.W,
    E: kit.maxRanks.E,
    R: purchasableUltimateRanks(kit),
  };
  // `Math.max(0, …)` rather than a refusal: an observed path that already
  // breaks a cap (the `rank-over-cap` case) is exactly one of the situations
  // this function exists to still answer for. That ability simply has nothing
  // left to give.
  const spare: Record<Ability, number> = {
    Q: Math.max(0, caps.Q - counts.Q),
    W: Math.max(0, caps.W - counts.W),
    E: Math.max(0, caps.E - counts.E),
    R: Math.max(0, caps.R - counts.R),
  };

  const forcedUlts = Math.min(tailUltimateRanks(kit, observed.length), spare.R, slots);
  const tail: Ability[] = Array<Ability>(forcedUlts).fill("R");
  spare.R -= forcedUlts;

  const { priority: allocationPriority, basis } = resolveAllocationPriority(priority, observed, kit);
  for (const ability of allocationPriority) {
    while (spare[ability] > 0 && tail.length < slots) {
      tail.push(ability);
      spare[ability] -= 1;
    }
    if (tail.length >= slots) break;
  }

  return tail.length ? { tail, basis } : null;
}

/**
 * Is a supplied priority list well-formed enough to be preferred over a
 * derived one?
 *
 * Non-empty, every entry a real ability, no repeats. Deliberately NOT "a full
 * permutation of Q/W/E/R": op.gg publishes THREE ids for almost every champion
 * (the basics — Ahri mid is `["Q","W","E"]`) and four only where the R slot is
 * a fourth basic rather than an ultimate (Udyr: `["Q","E","W","R"]`). Both
 * were probed live 2026-07-27. Demanding four would throw away the signal for
 * the entire roster to satisfy a shape the source does not publish.
 *
 * A repeat is treated as malformed rather than deduped: the ids are supposed
 * to be a ranking, and a ranking that names an ability twice is a payload we
 * do not understand. Falling back to the derived priority there is the honest
 * degrade — it costs the R-slot ranking and nothing else.
 */
export function isWellFormedPriority(supplied: unknown): supplied is Ability[] {
  if (!Array.isArray(supplied) || !supplied.length) return false;
  if (!supplied.every(isAbility)) return false;
  return new Set(supplied).size === supplied.length;
}

/**
 * The priority used to ALLOCATE a derived tail — deliberately a different
 * function from `resolvePriority`, which produces the basics-only "Q › W › E"
 * string the UI displays.
 *
 * Two differences, and both are load-bearing:
 *
 *  1. R IS KEPT. `resolvePriority` strips it, correctly, because the display
 *     string is about maxing basics. But for a champion whose R slot is a
 *     fourth basic (Udyr) the R entry is a real ranking of a real ability, and
 *     dropping it would mean R could never receive a derived point no matter
 *     what the source says.
 *  2. IT REPORTS WHICH SOURCE IT USED. The published ids win whenever they are
 *     well-formed; `derivePriority`'s reading of the observed path is the
 *     fallback. Callers surface that distinction rather than presenting both
 *     as equally grounded.
 *
 * Missing basics are appended in derived order, so no remaining point can
 * become unplaceable just because the source ranked fewer abilities than the
 * champion has.
 */
export function resolveAllocationPriority(
  supplied: readonly Ability[] | undefined,
  observed: readonly Ability[],
  kit: ChampionKit = STANDARD_KIT
): { priority: Ability[]; basis: PriorityBasis } {
  const derived = derivePriority(observed, kit);
  if (!isWellFormedPriority(supplied)) return { priority: derived, basis: "derived" };

  const out: Ability[] = [];
  for (const a of supplied) if (!out.includes(a)) out.push(a);
  for (const a of derived) if (!out.includes(a)) out.push(a);
  return { priority: out, basis: "published" };
}

/**
 * How many leading entries of a model's `order` came verbatim from the source.
 *
 * Read provenance through this rather than off the raw field: `observedLevels`
 * is optional on the wire so that a payload cached before it existed (or a
 * hand-built fixture) still type-checks, and the fallback below reproduces
 * exactly what such a payload meant — a completed order was completed from
 * SOURCE_LEVELS, and an uncompleted one is entirely source.
 */
export function observedLevelCount(
  model: Pick<SkillOrderModel, "order" | "completed"> & { observedLevels?: number }
): number {
  const len = Array.isArray(model.order) ? model.order.length : 0;
  const raw = model.observedLevels;
  if (Number.isInteger(raw) && (raw as number) >= 0) return Math.min(raw as number, len);
  return model.completed ? Math.min(SOURCE_LEVELS, len) : len;
}

/** Was this 1-based level DERIVED by the completion rule rather than published
 *  by the source? False for anything outside the order entirely — an absent
 *  level is not a derived one, and a UI must not render it as either. */
export function isDerivedLevel(
  model: Pick<SkillOrderModel, "order" | "completed"> & { observedLevels?: number },
  level: number
): boolean {
  if (!Number.isInteger(level) || level < 1) return false;
  const len = Array.isArray(model.order) ? model.order.length : 0;
  if (level > len) return false;
  return level > observedLevelCount(model);
}

/** Use the source's own priority when it is a usable permutation of the basic
 *  abilities; otherwise derive one from the observed path. A supplied
 *  priority that omits a basic still works — the missing ones are appended in
 *  derived order, so no remaining point is ever silently dropped. */
export function resolvePriority(
  supplied: readonly Ability[] | undefined,
  observed: readonly Ability[],
  kit: ChampionKit = STANDARD_KIT
): Ability[] {
  const derived = derivePriority(observed, kit);
  if (!supplied || !supplied.length || !supplied.every(isAbility)) return derived;

  const out: Ability[] = [];
  for (const a of supplied) {
    if (a !== "R" && !out.includes(a)) out.push(a);
  }
  for (const a of derived) if (!out.includes(a)) out.push(a);
  return out;
}

/** Raw values as parsed off the upstream feed — the only thing lib/opgg.ts is
 *  allowed to hand in. Everything interpretive happens in buildSkillOrderModel. */
export interface SkillOrderSource {
  order: Ability[];
  /** Source's own max-priority list, when it supplied one. */
  priorityIds?: Ability[];
  /** Games behind this order. */
  play: number;
  /** WIN COUNT — not a rate. See buildSkillOrderModel for why that matters. */
  win: number;
  /** Source's own share-of-games figure, already 0..1. */
  pickRate: number | null;
}

/**
 * Assemble the wire model from raw source values.
 *
 * ── Field meanings, confirmed against the source's OWN class definitions ────
 * The feed self-describes as `class Skills: order,play,win,pick_rate` and
 * `class SkillMasteries: ids,play,win,pick_rate,builds`. So:
 *   * `play`      is a GAME COUNT.
 *   * `win`       is a WIN COUNT, not a rate. Ahri mid: 41408 of 71667.
 *                 Read positionally as a rate it would be a nonsense 41408.
 *   * `pick_rate` is a SHARE of games, not the win rate. The win rate has to
 *                 be derived as win/play (0.578 for Ahri mid), and that is
 *                 exactly what this function does — it is never read off the
 *                 feed, because the feed does not publish it.
 * `sampleSize` therefore carries the real denominator through untouched, so a
 * 77-game Ahri-support order can be banded honestly by the UI instead of
 * looking as authoritative as a 71,667-game Ahri-mid one.
 *
 * `share` is passed through verbatim rather than recomputed: the source's own
 * denominator for it is not published and our probes could only bound it
 * (~126k for Ahri mid, which is neither the position's game count nor the
 * skill-mastery group's), so inventing a denominator to "verify" it would be
 * exactly the fabrication this codebase forbids. Passing the source's number
 * through as the source's number is the honest option.
 */
export function buildSkillOrderModel(
  src: SkillOrderSource,
  /** This champion's real rank rules. `undefined` falls back to STANDARD_KIT
   *  (pre-existing behaviour); `null` means "could not resolve, and this
   *  champion is known non-standard" and is carried through to the model so
   *  live consumers refuse rather than assume 5/5/5/3 — see the `kit` field
   *  on SkillOrderModel. */
  kit?: ChampionKit | null
): SkillOrderModel | null {
  if (!Array.isArray(src.order) || !src.order.length || !src.order.every(isAbility)) return null;
  if (!Number.isFinite(src.play) || src.play <= 0) return null;

  // A null kit cannot complete an order either — the caps it would need are
  // exactly what is missing. It degrades to the observed 15 with
  // `completed:false`, which is the honest "the source's 15 are all we know".
  const effectiveKit = kit ?? STANDARD_KIT;
  const completion: CompletionResult =
    kit === null
      ? { order: [...src.order], completed: false, observedLevels: src.order.length }
      : completeSkillOrder(src.order, src.priorityIds, effectiveKit);
  const { order, completed, observedLevels, basis } = completion;

  // The INFERRED tail — levels the derivation refused, filled from the
  // max-priority order so the recommendation grid can read as a full 18 (user
  // directive 2026-07-29). Deliberately a SEPARATE field, never merged into
  // `order`: see `inferSkillOrderTail`'s header for why, and note the two
  // conditions below.
  //
  //   * only when the derivation actually refused — a completed order has no
  //     tail to infer and attaching an empty/duplicate one would invite a
  //     consumer to render three chips twice.
  //   * NEVER when `kit === null`. That state means "known non-standard
  //     champion, ddragon unresolved", and the caps the walk needs are the very
  //     thing missing. Guessing under STANDARD_KIT is the one degrade this
  //     module has already measured to be worse than silence.
  const inference =
    !completed && kit !== null ? inferSkillOrderTail(order, src.priorityIds, effectiveKit) : null;

  // Win rate is DERIVED, and only when the counts can actually support it.
  const winRate =
    Number.isFinite(src.win) && src.win >= 0 && src.play > 0
      ? clamp01(src.win / src.play)
      : null;

  const share =
    src.pickRate != null && Number.isFinite(src.pickRate) ? clamp01(src.pickRate) : null;

  return {
    priority: resolvePriority(src.priorityIds, src.order, effectiveKit),
    levels: levelsByAbility(order),
    order,
    completed,
    // Provenance. `observedLevels` is always emitted; `completionBasis` only
    // when something was actually derived, because naming a priority that
    // decided nothing would imply a derivation that did not happen.
    observedLevels,
    ...(basis ? { completionBasis: basis } : {}),
    // Provenance for the guess, same discipline as `completionBasis` for the
    // derivation: attached only when something was actually inferred.
    ...(inference ? { inferredTail: inference.tail, inferredBasis: inference.basis } : {}),
    sampleSize: src.play,
    winRate,
    share,
    // Only attach when the caller actually resolved something (including an
    // explicit null "known non-standard, unresolved"). Omitting it entirely
    // when undefined keeps a pre-existing model byte-identical to before.
    ...(kit !== undefined ? { kit } : {}),
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
