// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/cs.ts — creep-score-per-minute arithmetic. Pure, no I/O, same
// posture as lib/mystats/aggregate.ts (which delegates here rather than
// re-deriving any of it).
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT: an average CS/min is
// TIME-WEIGHTED, not a mean of per-game rates.
//
//   40 min @ 320 CS  -> 8.0/min
//   20 min @ 100 CS  -> 5.0/min
//   mean of rates    -> 6.5/min     WRONG
//   420 CS / 60 min  -> 7.0/min     RIGHT
//
// The mean-of-rates answer treats the 20-minute game as though it contributed
// as much lane time as the 40-minute one. Those two numbers differ by half a
// creep per minute here, and the gap widens with a longer tail of short games.
// This is also exactly why migration 0021 stores raw `cs` and raw
// `game_duration_sec` instead of a pre-divided rate: a stored rate would leave
// the wrong answer as the ONLY answer reachable from the table.
//
// NULL IS NOT ZERO. A row with cs === null is a row we never measured (stored
// before migration 0021, not yet backfilled). It is dropped from both the
// numerator and the denominator, never counted as a zero-CS game — which is
// why every aggregate here also reports `games`, the count that actually backs
// the figure, separately from any caller's total game count.
// ─────────────────────────────────────────────────────────────────────────────

/** Games shorter than this are excluded from every RATE (never from storage).
 *
 *  5 minutes, not Riot's 3:00 remake vote. A remake is the obvious case, but
 *  the 3-5 minute band is the same problem wearing different clothes: an early
 *  FF/disconnect ends before a laning phase exists, so the "rate" it produces
 *  is not a measurement of farming at all — it is a measurement of the game
 *  having ended. One such game at ~2 CS/min pulls a real 7.0 average down
 *  visibly on the small denominators a personal account has (a few hundred
 *  games ever).
 *
 *  There is deliberately no UPPER bound and no other filter. A 55-minute game
 *  is a real game; its CS and its minutes both count, which is precisely what
 *  time-weighting is for.
 *
 *  Changing this constant needs no re-ingest — the raw columns are always
 *  stored, so the filter is re-evaluated on every read. */
export const CS_MIN_GAME_SEC = 300;

/** One row's raw CS inputs. `null` on either field means NOT MEASURED. */
export interface CsInput {
  cs: number | null;
  gameDurationSec: number | null;
}

export interface CsAggregate {
  /** Time-weighted CS per minute, 1 decimal. null when `games` is 0. */
  csPerMin: number | null;
  /** How many rows actually contributed. ALWAYS report this next to
   *  csPerMin — it is routinely smaller than the caller's own game count
   *  (unbackfilled rows, sub-CS_MIN_GAME_SEC games) and a rate over 3 games
   *  should not be rendered the same way as one over 300. */
  games: number;
  /** Raw sums behind the figure, so a caller can re-aggregate across groups
   *  correctly instead of averaging our already-divided answer (the exact
   *  mistake this module exists to prevent). null when games is 0. */
  totalCs: number | null;
  totalDurationSec: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** True when a row can contribute to a rate: both halves measured, duration
 *  long enough to mean something, and duration strictly positive (a stored 0
 *  would divide by zero — prostage rows carry exactly that sentinel, and
 *  although they never reach this table, a guard that depends on another
 *  table's conventions staying put is not a guard). */
export function countsTowardCsRate(row: CsInput): boolean {
  return (
    row.cs !== null &&
    row.gameDurationSec !== null &&
    row.gameDurationSec > 0 &&
    row.gameDurationSec >= CS_MIN_GAME_SEC
  );
}

/** ONE game's CS/min, 1 decimal — null when the row does not qualify (see
 *  countsTowardCsRate). Callers still get the raw `cs`/`gameDurationSec` for
 *  such a row and may render "12 CS in 3:41"; what they must not get is a
 *  rate that reads like a farming statistic. */
export function csPerMinForGame(row: CsInput): number | null {
  if (!countsTowardCsRate(row)) return null;
  return round1((row.cs as number) / ((row.gameDurationSec as number) / 60));
}

/** TIME-WEIGHTED average across many games — see this file's header. */
export function aggregateCs(rows: CsInput[]): CsAggregate {
  let totalCs = 0;
  let totalDurationSec = 0;
  let games = 0;
  for (const row of rows) {
    if (!countsTowardCsRate(row)) continue;
    totalCs += row.cs as number;
    totalDurationSec += row.gameDurationSec as number;
    games += 1;
  }
  if (games === 0 || totalDurationSec <= 0) {
    return { csPerMin: null, games: 0, totalCs: null, totalDurationSec: null };
  }
  return {
    csPerMin: round1(totalCs / (totalDurationSec / 60)),
    games,
    totalCs,
    totalDurationSec,
  };
}
