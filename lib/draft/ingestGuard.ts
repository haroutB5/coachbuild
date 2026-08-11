// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/ingestGuard.ts — PERMANENT cross-source sanity guard (added
// 2026-07-21 as the direct fix for a P0 that this exact gap let through:
// the u.gg matchup perspective was inverted — see
// migrations/0011_draft_perspective_fix.sql and lib/draft/ugg.ts's
// decodeMatchupsJson doc comment for the full incident). The bootstrap's
// own wins<=games invariant and a single stale empirical anchor both held
// true under the WRONG perspective and could never have caught this on
// their own — a real perspective/schema drift needs an INDEPENDENT ground
// truth to compare against, not just internal shape checks.
//
// This module compares a small panel of well-known, single-role-main
// champions' draft_champ_stats baseline winrate against coachless's own
// per-champ+lane winrate (lib/heroStats.ts's getHeroStats — a genuinely
// SEPARATE upstream source from u.gg). A drift beyond GUARD_TOLERANCE_PCT
// points on enough panel entries means something is systematically wrong
// with the ingest (perspective flip, role-map regression, wrong endpoint,
// etc.) — the caller (lib/draft/ingest.ts's runDraftIngest, on the FINAL
// cursor of a walk) must treat that as a hard failure: never let retention
// (which prunes the last known-good patch) run against data the guard
// can't vouch for.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { getHeroStats, type LaneKey } from "@/lib/heroStats";
import type { RoleId } from "@/lib/types";
import { DIAMOND_2_PLUS_TIER } from "@/lib/draft/ugg";

export interface GuardPanelEntry {
  champId: number;
  role: RoleId;
  laneKey: LaneKey;
  /** Human-readable label for failure messages only. */
  label: string;
}

/** Single-role-main champions with a large, stable playerbase — same
 *  reasoning as scripts/ingest-draft.mjs's ROLE_PROBES (a champion
 *  overwhelmingly played in ONE role gives a clean, unambiguous
 *  cross-source comparison point). Spans ALL 5 roles, 4 champions each,
 *  deliberately mixing "normal" (~49-51%, simple/safe kits) and "skewed"
 *  (further from 50%, either genuinely strong/weak or high-skill-variance)
 *  archetypes per role — a panel of only safe, near-50% champions could
 *  fail to notice a systematic error that only shows up at the extremes
 *  (P0 addendum, 2026-07-21: "assurance across ALL lanes and champions,
 *  not just the [original] acceptance example"). Ground truth is fetched
 *  LIVE per champion (lib/heroStats.ts's getHeroStats) — nothing here is a
 *  hardcoded expected number, so this panel needs no maintenance as the
 *  meta shifts patch to patch. */
export const DEFAULT_GUARD_PANEL: GuardPanelEntry[] = [
  // TOP
  { champId: 86, role: 0, laneKey: "top", label: "Garen/top" },
  { champId: 54, role: 0, laneKey: "top", label: "Malphite/top" },
  { champId: 92, role: 0, laneKey: "top", label: "Riven/top" },
  { champId: 420, role: 0, laneKey: "top", label: "Illaoi/top" },
  // JUNGLE
  { champId: 64, role: 1, laneKey: "jungle", label: "LeeSin/jungle" },
  { champId: 19, role: 1, laneKey: "jungle", label: "Warwick/jungle" },
  { champId: 32, role: 1, laneKey: "jungle", label: "Amumu/jungle" },
  { champId: 141, role: 1, laneKey: "jungle", label: "Kayn/jungle" },
  // MID
  { champId: 112, role: 2, laneKey: "mid", label: "Viktor/mid" },
  { champId: 157, role: 2, laneKey: "mid", label: "Yasuo/mid" },
  { champId: 1, role: 2, laneKey: "mid", label: "Annie/mid" },
  { champId: 90, role: 2, laneKey: "mid", label: "Malzahar/mid" },
  // BOT (ADC)
  { champId: 222, role: 3, laneKey: "bot", label: "Jinx/bot" },
  { champId: 498, role: 3, laneKey: "bot", label: "Xayah/bot" },
  { champId: 29, role: 3, laneKey: "bot", label: "Twitch/bot" },
  { champId: 429, role: 3, laneKey: "bot", label: "Kalista/bot" },
  // SUPPORT
  { champId: 412, role: 4, laneKey: "support", label: "Thresh/support" },
  { champId: 350, role: 4, laneKey: "support", label: "Yuumi/support" },
  { champId: 16, role: 4, laneKey: "support", label: "Soraka/support" },
  { champId: 53, role: 4, laneKey: "support", label: "Blitzcrank/support" },
];

/** Max allowed |draft_winrate% - ground_truth_winrate%| before a panel
 *  entry is treated as a failure. 4 points is generous enough to absorb
 *  real source-to-source noise (different tier cuts, different sample
 *  windows) while being far tighter than the ~10-20 point swing a
 *  perspective inversion produces (see the incident's cited examples). */
export const GUARD_TOLERANCE_PCT = 4;

/** Below this many successfully-compared panel entries, the guard can't
 *  vouch for anything either way — treated as a FAILURE (not a pass) for
 *  the "is it safe to run retention" decision, never silently trusted.
 *  Half of DEFAULT_GUARD_PANEL's 20 entries. */
export const GUARD_MIN_CHECKABLE = 10;

export interface GuardEntryDetail {
  label: string;
  role: RoleId;
  /** Null when this entry couldn't be compared (missing draft baseline or
   *  ground truth) — excluded from `checked`/pass-fail, still reported for
   *  visibility. */
  draftPct: number | null;
  groundTruthPct: number | null;
  deltaPct: number | null;
}

export interface GuardResult {
  ok: boolean;
  /** How many panel entries had BOTH a draft baseline and ground truth to
   *  actually compare (skipped entries don't count toward pass or fail). */
  checked: number;
  /** Human-readable failure descriptions — empty when ok. */
  failures: string[];
  /** Full per-entry breakdown (including skipped ones) — for reporting/
   *  debugging, not part of the pass/fail decision itself. */
  details: GuardEntryDetail[];
}

export interface GuardDeps {
  /** Draft's own baseline winrate (0..1) for (patch, DIAMOND_2_PLUS_TIER, role,
   *  champId), or null if that champion+role has no row yet. */
  getDraftBaseline: (champId: number, role: RoleId) => Promise<number | null>;
  /** Independent ground truth — winRatePct is 0..100 (coachless's own
   *  scale), or null when unavailable/degraded. */
  getGroundTruth: (champId: number, laneKey: LaneKey) => Promise<{ winRatePct: number | null }>;
}

/** Pure orchestration over injected deps — directly unit-testable with
 *  fixture functions, no network/DB (see lib/__tests__/draft-ingestGuard.test.ts). */
export async function runIngestGuard(
  panel: GuardPanelEntry[],
  deps: GuardDeps,
  tolerancePct: number = GUARD_TOLERANCE_PCT,
  minCheckable: number = GUARD_MIN_CHECKABLE
): Promise<GuardResult> {
  const failures: string[] = [];
  const details: GuardEntryDetail[] = [];
  let checked = 0;

  for (const entry of panel) {
    const truth = await deps.getGroundTruth(entry.champId, entry.laneKey);
    const draftWr = truth.winRatePct === null ? null : await deps.getDraftBaseline(entry.champId, entry.role);

    if (truth.winRatePct === null || draftWr === null) {
      // No independent ground truth right now, or this champion+role isn't
      // in draft data yet -- skip (don't fail on this alone), but still
      // report it for visibility.
      details.push({ label: entry.label, role: entry.role, draftPct: draftWr === null ? null : draftWr * 100, groundTruthPct: truth.winRatePct, deltaPct: null });
      continue;
    }

    checked += 1;
    const draftPct = draftWr * 100;
    const delta = Math.abs(draftPct - truth.winRatePct);
    details.push({ label: entry.label, role: entry.role, draftPct, groundTruthPct: truth.winRatePct, deltaPct: delta });
    if (delta > tolerancePct) {
      failures.push(
        `${entry.label}: draft baseline ${draftPct.toFixed(1)}% vs ground truth ${truth.winRatePct.toFixed(1)}% ` +
          `(delta ${delta.toFixed(1)} > tolerance ${tolerancePct})`
      );
    }
  }

  if (checked < minCheckable) {
    failures.push(
      `only ${checked}/${panel.length} panel entries had both a draft baseline and ground truth to compare -- guard inconclusive, treated as failed`
    );
  }

  return { ok: failures.length === 0, checked, failures, details };
}

/** Real deps: draft baseline from Neon, ground truth from coachless via
 *  lib/heroStats.ts's getHeroStats (a genuinely separate upstream). */
export function makeRealGuardDeps(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string
): GuardDeps {
  return {
    getDraftBaseline: async (champId, role) => {
      const rows = (await sql`
        SELECT winrate FROM coachbuild.draft_champ_stats
        WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${role} AND champ_id = ${champId}
      `) as unknown as { winrate: number | null }[];
      return rows[0]?.winrate ?? null;
    },
    getGroundTruth: async (champId, laneKey) => {
      try {
        const stats = await getHeroStats(champId, laneKey);
        return { winRatePct: stats.winRatePct };
      } catch {
        return { winRatePct: null }; // a coachless blip degrades to "skip this entry", never a thrown ingest failure
      }
    },
  };
}

/** Runs the guard against live Neon + coachless for the given patch, using
 *  DEFAULT_GUARD_PANEL. Thin convenience wrapper — lib/draft/ingest.ts's
 *  final-cursor path and scripts/ingest-draft.mjs both call this. */
export async function runDefaultIngestGuard(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string
): Promise<GuardResult> {
  return runIngestGuard(DEFAULT_GUARD_PANEL, makeRealGuardDeps(sql, patch));
}

// ─────────────────────────────────────────────────────────────────────────────
// SYMMETRY CHECK — a SEPARATE, PURELY INTERNAL invariant. Added the same day
// as the cross-source panel above but catches a DIFFERENT class of bug —
// read this before "simplifying" one into the other:
//
//   IMPORTANT: symmetry alone would NOT have caught the P0 perspective
//   inversion this guard was built to prevent a repeat of. If BOTH sides of
//   a pairing are flipped the same way (wr' = 1 - wr on both A-vs-B and
//   B-vs-A), their sum is STILL ≈1 — a systematic, direction-independent
//   inversion is invisible to a symmetry check by construction. That is
//   exactly what happened here: u.gg's own row-owner/opponent
//   convention flips the SAME way in every file, so wr(A vs B) and
//   wr(B vs A) as originally decoded already summed to ~1 even though both
//   were wrong. The cross-source panel above (comparing against a THIRD,
//   independent source) is the only thing in this codebase that actually
//   detects a perspective inversion.
//
//   What symmetry DOES catch: decode/keying corruption that breaks the
//   A-vs-B / B-vs-A PAIRING itself — e.g. a role-map regression that files
//   a matchup under the wrong role on one side but not the other, an
//   oppId/champId mixup, a champion-id collision, or a genuinely corrupted
//   row. Those failure modes break the wr(A,B)+wr(B,A)≈1 invariant even
//   though they'd sail through a same-direction-everywhere inversion check.
//   Keep BOTH checks; neither substitutes for the other.
// ─────────────────────────────────────────────────────────────────────────────

export interface SymmetryPairRow {
  champA: number;
  champB: number;
  role: RoleId;
  winsA: number;
  gamesA: number;
  winsB: number;
  gamesB: number;
}

export const SYMMETRY_TOLERANCE_PCT = 4;

/** Both directions of a pairing need this many games before the pair is worth
 *  checking. UNCHANGED at 200 by v0.109.0 — measured, not assumed.
 *
 *  The concern this was reviewed against: after v0.108.0's ~8x narrowing,
 *  would a real ingest still find SYMMETRY_MIN_CHECKABLE qualifying pairs, or
 *  would the check start returning "inconclusive" (which checkSymmetry treats
 *  as FAILED, blocking pruneOldPatches and showing a data-integrity banner on
 *  /draft with nothing actually wrong)? MEASURED on patch 16.14, pairs with
 *  BOTH directions >= 200 games:
 *    tier 10: 9,992 total  (per role 2543 / 2078 / 2300 / 1223 / 1848)
 *    tier 15: 3,548 total  (per role  830 /  755 /  729 /  635 /  599)
 *  The bar is 20 and the query samples 100. Even the thinnest role clears the
 *  bar by 30x, so this floor is nowhere near binding and lowering it would buy
 *  nothing but weaker pairs. It is also an EVIDENCE floor, not a popularity
 *  one — the same reasoning that keeps N_FLOOR and MASS_GATE_MIN_GAMES fixed
 *  while the pool floor became a share. Left exactly where it was. */
export const SYMMETRY_MIN_GAMES = 200;
export const SYMMETRY_SAMPLE_SIZE = 100;
/** Same "can't vouch for anything on too few samples" posture as the
 *  cross-source guard's GUARD_MIN_CHECKABLE. Measured clearance above. */
export const SYMMETRY_MIN_CHECKABLE = 20;

export interface SymmetryResult {
  /** False for BOTH "a pair disagreed" and "not enough pairs to judge" — the
   *  retention decision treats them identically on purpose (never prune on
   *  data nothing vouched for). `inconclusive` below is what tells them
   *  apart for a human. */
  ok: boolean;
  checked: number;
  failures: string[];
  /** v0.109.0 — TRUE when the check could not reach a verdict (fewer than
   *  minCheckable qualifying pairs) rather than finding a real asymmetry.
   *
   *  These are different facts and were reported as one: an inconclusive run
   *  pushed a `failures` entry, `ok` went false, retention was skipped, and
   *  /draft showed "Last data refresh reported an error" — the same wording a
   *  genuine decode/keying corruption produces. One means "something is wrong
   *  with the data"; the other means "there is not enough data yet to say",
   *  which on the first hours of a new patch is the expected state and not an
   *  error at all. `ok` deliberately stays false in both cases (the cautious
   *  retention behaviour is correct); only the description changes. */
  inconclusive: boolean;
}

/** Pure check over already-fetched pair rows — see
 *  lib/__tests__/draft-ingestGuard.test.ts for fixture-based coverage. */
export function checkSymmetry(
  rows: SymmetryPairRow[],
  tolerancePct: number = SYMMETRY_TOLERANCE_PCT,
  minCheckable: number = SYMMETRY_MIN_CHECKABLE
): SymmetryResult {
  const failures: string[] = [];
  let checked = 0;

  for (const row of rows) {
    if (row.gamesA <= 0 || row.gamesB <= 0) continue;
    checked += 1;
    const wrA = row.winsA / row.gamesA;
    const wrB = row.winsB / row.gamesB;
    const sumPct = (wrA + wrB) * 100;
    const deltaFrom100 = Math.abs(sumPct - 100);
    if (deltaFrom100 > tolerancePct) {
      failures.push(
        `champ ${row.champA} vs ${row.champB} (role ${row.role}): wr(A,B)=${(wrA * 100).toFixed(1)}% + ` +
          `wr(B,A)=${(wrB * 100).toFixed(1)}% = ${sumPct.toFixed(1)}% (expected ~100%, delta ${deltaFrom100.toFixed(1)} > tolerance ${tolerancePct})`
      );
    }
  }

  const inconclusive = checked < minCheckable;
  if (inconclusive) {
    // Worded as what it is. It still blocks retention (see SymmetryResult's
    // `inconclusive`), but "we could not check" must not read as "the check
    // found something", or every early-patch run looks like a data incident.
    failures.push(
      `INCONCLUSIVE (not a detected asymmetry): only ${checked} of the ${minCheckable} required symmetric pairs had ` +
        `both sides >= ${SYMMETRY_MIN_GAMES} games. Nothing is known to be wrong with the data; there is not yet enough ` +
        `of it to vouch for. Retention is skipped until a later run can check.`
    );
  }

  return { ok: failures.length === 0, checked, failures, inconclusive };
}

/** Fetches up to SYMMETRY_SAMPLE_SIZE (A,B) pairs (each direction's row
 *  present, both with >= SYMMETRY_MIN_GAMES games) and runs checkSymmetry
 *  over them. `champ_id < opp_id` in the WHERE clause samples each
 *  unordered pair once rather than once per direction. */
export async function runSymmetryCheck(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string
): Promise<SymmetryResult> {
  const rows = (await sql`
    SELECT m1.champ_id AS champ_a, m1.opp_id AS champ_b, m1.role,
           m1.wins AS wins_a, m1.games AS games_a,
           m2.wins AS wins_b, m2.games AS games_b
    FROM coachbuild.draft_matchup m1
    JOIN coachbuild.draft_matchup m2
      ON m1.opp_id = m2.champ_id AND m1.champ_id = m2.opp_id
     AND m1.role = m2.role AND m1.patch = m2.patch AND m1.tier = m2.tier
    WHERE m1.patch = ${patch} AND m1.tier = ${DIAMOND_2_PLUS_TIER}
      AND m1.champ_id < m1.opp_id
      AND m1.games >= ${SYMMETRY_MIN_GAMES} AND m2.games >= ${SYMMETRY_MIN_GAMES}
    LIMIT ${SYMMETRY_SAMPLE_SIZE}
  `) as unknown as {
    champ_a: number;
    champ_b: number;
    role: RoleId;
    wins_a: number;
    games_a: number;
    wins_b: number;
    games_b: number;
  }[];

  const pairRows: SymmetryPairRow[] = rows.map((r) => ({
    champA: r.champ_a,
    champB: r.champ_b,
    role: r.role,
    winsA: r.wins_a,
    gamesA: r.games_a,
    winsB: r.wins_b,
    gamesB: r.games_b,
  }));

  return checkSymmetry(pairRows);
}
