// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/score.ts — "CoachBuild Score": a transparent, deterministic 0-100
// per-game grade in the spirit of dpm.lol's most-copied feature. Pure, no
// I/O — every input is a plain number/boolean already sitting on a
// pro_matches row (or ExtractedMatch, pre-insert).
//
// FORMULA (documented here so the number is never a black box):
//
// 1. KDA ratio. deaths=0 games use (kills+assists+2) instead of dividing by
//    zero — a flat "flawless" bonus rather than an undefined/Infinity ratio,
//    so a 5/0/5 game scores a bit better than a 5/1/5 game instead of
//    exploding to Infinity.
//      kda = deaths > 0 ? (kills + assists) / deaths : kills + assists + 2
//
// 2. KDA -> 0-100 baseline via a saturating curve (not linear — linear would
//    let one insane outlier game blow past 100 before the clamp, and would
//    make the 0-3 range (where most games live) too flat to be legible).
//    Scale constant picked so kda=3 -> ~50, kda=6 -> ~75, kda=10 -> ~90:
//      kdaComponent = 100 * (1 - e^(-kda / 4.33))
//
// 3. Win/loss modifier — a flat add, not a weighted blend, so it reads as
//    "the win/loss swing" independent of how good the KDA component was:
//      winBonus = win ? +8 : -4
//    (Asymmetric on purpose: winning is weighted a bit more than losing is
//    punished — an individually strong performance in a loss shouldn't be
//    crushed by a scoreline the player didn't fully control.)
//
// 4. Optional blend — only when BOTH `cs` and `teamKills` are present
//    (non-null/undefined; they're always ingested together from the same
//    match-v5 record, so "one present" never happens in practice, but the
//    guard is on both defensively). `damageChampions`/`gold` are captured on
//    the row for future use but are NOT part of the score formula yet.
//      csPerMin = cs / max(gameDurationSec / 60, 1)   [duration floor of 1
//        min guards div-by-zero/blowup on a sub-minute remake, still lets a
//        genuinely short 10-min game produce a meaningful csPerMin]
//      csComponent = clamp((csPerMin / 8) * 100, 0, 100)   [8 cs/min ~=
//        elite laner pace; this is a simplification with no role adjustment
//        — junglers/supports will read lower here, a known/accepted bias
//        documented rather than hidden]
//      kp = teamKills > 0 ? clamp((kills+assists) / teamKills, 0, 1) : 0
//      kpComponent = kp * 100
//      statBlend = csComponent * 0.5 + kpComponent * 0.5
//      score = clamp(kdaComponent * 0.6 + statBlend * 0.4 + winBonus, 0, 100)
//
//    Degraded (no optional stats): score = clamp(kdaComponent + winBonus, 0, 100)
//
// 5. Grade thresholds (documented, not derived): S >= 90, A >= 75, B >= 60,
//    C >= 40, D < 40.
// ─────────────────────────────────────────────────────────────────────────────

export type CoachBuildGrade = "S" | "A" | "B" | "C" | "D";

export interface GameScoreInput {
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
  gameDurationSec: number;
  cs?: number | null;
  damageChampions?: number | null;
  teamKills?: number | null;
}

export interface GameScoreResult {
  score: number; // 0-100, integer
  grade: CoachBuildGrade;
}

const KDA_SCALE = 4.33; // see formula step 2 above
const WIN_BONUS = 8;
const LOSS_PENALTY = -4;
const ELITE_CS_PER_MIN = 8;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** kda ratio per formula step 1 — exported for reuse/testing in isolation. */
export function computeKdaRatio(kills: number, deaths: number, assists: number): number {
  return deaths > 0 ? (kills + assists) / deaths : kills + assists + 2;
}

/** CS/min, floored at a 1-minute game duration to avoid a div-by-zero or
 *  absurd blowup on a near-instant remake. Returns 0 when cs itself is 0. */
export function computeCsPerMin(cs: number, gameDurationSec: number): number {
  const durationMin = Math.max(gameDurationSec / 60, 1);
  return cs / durationMin;
}

/** Kill participation as a 0-1 fraction. teamKills=0 (e.g. a 0-0 scoreline
 *  before any team kill, or bad data) degrades to 0 rather than NaN. */
export function computeKillParticipation(kills: number, assists: number, teamKills: number): number {
  if (teamKills <= 0) return 0;
  return clamp((kills + assists) / teamKills, 0, 1);
}

function gradeForScore(score: number): CoachBuildGrade {
  if (score >= 90) return "S";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

export function computeGameScore(input: GameScoreInput): GameScoreResult {
  const { kills, deaths, assists, win, gameDurationSec, cs, damageChampions, teamKills } = input;
  void damageChampions; // captured on the row, intentionally unused in the formula (see header)

  const kda = computeKdaRatio(kills, deaths, assists);
  const kdaComponent = 100 * (1 - Math.exp(-kda / KDA_SCALE));
  const winBonus = win ? WIN_BONUS : LOSS_PENALTY;

  let rawScore: number;
  if (cs !== null && cs !== undefined && teamKills !== null && teamKills !== undefined) {
    const csPerMin = computeCsPerMin(cs, gameDurationSec);
    const csComponent = clamp((csPerMin / ELITE_CS_PER_MIN) * 100, 0, 100);
    const kp = computeKillParticipation(kills, assists, teamKills);
    const kpComponent = kp * 100;
    const statBlend = csComponent * 0.5 + kpComponent * 0.5;
    rawScore = kdaComponent * 0.6 + statBlend * 0.4 + winBonus;
  } else {
    rawScore = kdaComponent + winBonus;
  }

  const score = Math.round(clamp(rawScore, 0, 100));
  return { score, grade: gradeForScore(score) };
}
