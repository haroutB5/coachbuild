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
//                          arithmetic below, from a champion that provably
//                          fits League's standard 5/5/5/3 rank model.
//   * `completed: false` — the derivation refused. `order` then carries ONLY
//                          the 15 levels the source actually reported, and
//                          the UI must render nothing beyond level 15.
// A caller MUST NOT treat a 15-long order as "18 with three unknowns to fill
// in" — the whole point is that we do not know them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ability, SkillOrderModel } from "./types";

export type { Ability, SkillOrderModel };

/** The three basic abilities, in Riot's canonical slot order. Used as the
 *  last-resort tie-break so the output is deterministic, never arbitrary. */
export const BASIC_ABILITIES: readonly Ability[] = ["Q", "W", "E"] as const;

/** League's standard rank model. A basic ability caps at 5 ranks, the
 *  ultimate at 3 — 5+5+5+3 = 18 = exactly the 18 levels of a game. Champions
 *  that do NOT obey this (see NON-STANDARD CHAMPIONS below) are precisely the
 *  ones completeSkillOrder must refuse rather than guess at. */
export const MAX_RANKS: Readonly<Record<Ability, number>> = Object.freeze({
  Q: 5,
  W: 5,
  E: 5,
  R: 3,
});

export const TOTAL_LEVELS = 18;
/** What the upstream source actually publishes: levels 1-15 only. */
export const SOURCE_LEVELS = 15;
/** The only levels at which an ultimate may be ranked in a real game. Levels
 *  16-18 contain exactly ONE of them (16), which is why a derivation that
 *  needs to place two or more ultimate ranks in the tail is impossible and
 *  is refused rather than fudged. */
export const ULTIMATE_LEVELS: readonly number[] = [6, 11, 16] as const;

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
 */
export function derivePriority(order: readonly Ability[]): Ability[] {
  const seenAt: Record<Ability, number[]> = levelsByAbility(order);
  const maxRank = MAX_RANKS.Q; // basics all share the same cap in the standard model

  return [...BASIC_ABILITIES].sort((a, b) => {
    const la = seenAt[a];
    const lb = seenAt[b];
    // Level at which the ability was maxed; Infinity when it never was.
    const maxedA = la.length >= maxRank ? la[maxRank - 1] : Infinity;
    const maxedB = lb.length >= maxRank ? lb[maxRank - 1] : Infinity;
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
  | "tail-mismatch";

export interface CompletionResult {
  order: Ability[];
  completed: boolean;
  /** Present only when `completed` is false. */
  refusedBecause?: CompletionRefusal;
}

/**
 * Complete a 15-level observed path to the full 18 levels — BY DERIVATION,
 * NEVER BY GUESSING.
 *
 * ── The derivation ─────────────────────────────────────────────────────────
 * Under League's standard model a champion has exactly 18 ability points and
 * caps at Q5/W5/E5/R3. So given a provably-standard first 15 levels, the
 * remaining 3 points are fully DETERMINED by subtraction — there is nothing
 * to guess. Ahri mid, for example, has Q:5 W:5 E:3 R:2 across levels 1-15,
 * leaving exactly R×1 and E×2. The ultimate takes level 16 (6/11/16 are the
 * only ultimate levels), and the two E points fall at 17 and 18. That is
 * arithmetic, not opinion, and it reproduces U.GG's published Ahri path
 * exactly (cross-checked 2026-07-27).
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
 *  (3) `rank-over-cap`    — an ability already exceeds its standard cap by
 *      level 15, so the champion is not on the 5/5/5/3 model at all and the
 *      subtraction would go negative. This is the check that catches the
 *      genuinely non-standard kits (see below) — and it catches them by
 *      ARITHMETIC, from their own data, not from a hardcoded champion
 *      blocklist that would rot the moment Riot reworks someone.
 *  (4) `ultimate-remainder` — the tail would need a number of ultimate ranks
 *      other than exactly 1. Levels 16-18 contain exactly one ultimate level
 *      (16), so needing 0 or 2+ means the observed path is not a legal
 *      standard path and its tail is not derivable.
 *  (5) `tail-mismatch`    — belt-and-braces: the computed remainder doesn't
 *      total 3. Unreachable if (1)+(3) hold, and asserted in tests precisely
 *      because "can't happen" is a claim worth testing rather than trusting.
 *
 * ── NON-STANDARD CHAMPIONS — MEASURED, not guessed ─────────────────────────
 * Full 172-champion sweep against live op.gg data, each on its primary lane
 * (2026-07-27). Exhaustive result:
 *
 *   160  complete cleanly
 *     7  complete, but their published order ranks R at level 12 (see below)
 *     4  refused, `rank-over-cap`   — UDYR, JAYCE, YUUMI, APHELIOS
 *     1  refused, `bad-token`       — KHAZIX
 *
 *  * UDYR    — four basics, no true ultimate; Q:6 E:6 W:2 and "R" ranked at
 *              LEVEL 2. Caught by the cap check (Q=6 > 5).
 *  * APHELIOS— W is a fixed 1-rank mechanic, so Q and E reach 6.
 *  * JAYCE   — transform kit; Q:6 W:6 and R never ranked in the published 15.
 *  * YUUMI   — Q:6.
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
 * ── Why there is NO ultimate-level legality check ──────────────────────────
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
  priority?: readonly Ability[]
): CompletionResult {
  // (2) token validity first — everything below assumes real abilities.
  if (!observed.every(isAbility)) {
    return { order: [...observed], completed: false, refusedBecause: "bad-token" };
  }

  // (1) length.
  if (observed.length === TOTAL_LEVELS) {
    return { order: [...observed], completed: false, refusedBecause: "already-complete" };
  }
  if (observed.length !== SOURCE_LEVELS) {
    return { order: [...observed], completed: false, refusedBecause: "unexpected-length" };
  }

  const counts = countRanks(observed);

  // (3) standard-model cap check — the real non-standard-champion detector.
  for (const ability of ["Q", "W", "E", "R"] as const) {
    if (counts[ability] > MAX_RANKS[ability]) {
      return { order: [...observed], completed: false, refusedBecause: "rank-over-cap" };
    }
  }

  const remaining: Record<Ability, number> = {
    Q: MAX_RANKS.Q - counts.Q,
    W: MAX_RANKS.W - counts.W,
    E: MAX_RANKS.E - counts.E,
    R: MAX_RANKS.R - counts.R,
  };

  // (4) exactly one ultimate rank must be left for level 16.
  if (remaining.R !== 1) {
    return { order: [...observed], completed: false, refusedBecause: "ultimate-remainder" };
  }

  const basicsRemaining = remaining.Q + remaining.W + remaining.E;
  // (5) unreachable given the above, asserted anyway.
  if (basicsRemaining + remaining.R !== TOTAL_LEVELS - SOURCE_LEVELS) {
    return { order: [...observed], completed: false, refusedBecause: "tail-mismatch" };
  }

  // Order the leftover basic points by the champion's OWN max priority.
  const effectivePriority = resolvePriority(priority, observed);
  const tailBasics: Ability[] = [];
  for (const ability of effectivePriority) {
    if (ability === "R") continue;
    for (let i = 0; i < remaining[ability]; i += 1) tailBasics.push(ability);
  }

  // R is conventionally (and, for levels 16-18, necessarily) taken at 16.
  const order: Ability[] = [...observed, "R", ...tailBasics];

  // Final structural guarantee before we dare set completed: true.
  if (order.length !== TOTAL_LEVELS) {
    return { order: [...observed], completed: false, refusedBecause: "tail-mismatch" };
  }

  return { order, completed: true };
}

/** Use the source's own priority when it is a usable permutation of the basic
 *  abilities; otherwise derive one from the observed path. A supplied
 *  priority that omits a basic still works — the missing ones are appended in
 *  derived order, so no remaining point is ever silently dropped. */
export function resolvePriority(
  supplied: readonly Ability[] | undefined,
  observed: readonly Ability[]
): Ability[] {
  const derived = derivePriority(observed);
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
export function buildSkillOrderModel(src: SkillOrderSource): SkillOrderModel | null {
  if (!Array.isArray(src.order) || !src.order.length || !src.order.every(isAbility)) return null;
  if (!Number.isFinite(src.play) || src.play <= 0) return null;

  const { order, completed } = completeSkillOrder(src.order, src.priorityIds);

  // Win rate is DERIVED, and only when the counts can actually support it.
  const winRate =
    Number.isFinite(src.win) && src.win >= 0 && src.play > 0
      ? clamp01(src.win / src.play)
      : null;

  const share =
    src.pickRate != null && Number.isFinite(src.pickRate) ? clamp01(src.pickRate) : null;

  return {
    priority: resolvePriority(src.priorityIds, src.order),
    levels: levelsByAbility(order),
    order,
    completed,
    sampleSize: src.play,
    winRate,
    share,
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
