/**
 * SESSION GROUPING AND THE LP BRACKET (spec §1 and §6, 2026-08-20).
 *
 * ── THE HEADLINE REQUIREMENT ────────────────────────────────────────────────
 *
 * "A session that runs past midnight must NOT split into two." The user plays
 * late; the obvious implementation — group by calendar date — cuts their
 * evening in half and reports two three-game sessions where there was one
 * six-game one. Both halves would look plausible, which is what makes it worth
 * a test rather than a comment.
 *
 * The first test below does not merely assert "one session". It computes what a
 * calendar-day grouping WOULD have produced from the same fixture (two groups)
 * and asserts the gap rule produces one. So it fails against the naive
 * implementation by construction, not by luck of the fixture.
 *
 * ── THE BOUNDARY ────────────────────────────────────────────────────────────
 *
 * A gap of >= 8h between consecutive counted games starts a new session (the
 * user's own choice: "only sleep ends it"). 8h exactly is a boundary and gets
 * its own test in both directions — an implementation using `>` instead of
 * `>=` passes every other test in this file.
 *
 * ── THE LP BRACKET ──────────────────────────────────────────────────────────
 *
 * `unavailable` is the state that matters most. Every session played before LP
 * capture existed is in it, so it is the common case for months, and the rule
 * is absolute: it renders a dash and NEVER a number derived from the win count.
 * The test named for that asserts a 5W-0L session with no samples returns
 * `value: null` — not +75, not +15 per win, not 0.
 */
import { describe, it, expect } from "vitest";
import {
  SESSION_GAP_HOURS,
  SESSION_GAP_MS,
  groupSessions,
  sessionLpDelta,
  type RankSample,
  type SessionMatchInput,
} from "@/lib/mystats/sessions";

/** A counted game at `iso`, `durationMin` long. Wins/losses matter only where
 *  the test says so, so they default to a win. */
function game(iso: string, win = true, durationMin: number | null = 30): SessionMatchInput {
  return { gameCreation: iso, win, gameDurationSec: durationMin === null ? null : durationMin * 60 };
}

function sample(
  iso: string,
  tier: string | null,
  division: string | null,
  lp: number | null,
  cumulativeLp?: number | null
): RankSample {
  return { observedAt: iso, tier, division, lp, ...(cumulativeLp === undefined ? {} : { cumulativeLp }) };
}

const utcDay = (iso: string) => iso.slice(0, 10);

describe("groupSessions — the boundary", () => {
  it("HEADLINE: a session that runs 22:40 -> 01:32 is ONE session, dated the earlier day", () => {
    // Five games across midnight, none more than 40 minutes apart.
    const matches = [
      game("2026-08-14T22:40:00.000Z"),
      game("2026-08-14T23:15:00.000Z"),
      game("2026-08-14T23:52:00.000Z"),
      game("2026-08-15T00:38:00.000Z"),
      game("2026-08-15T01:32:00.000Z"),
    ];

    // THE ORACLE. What a calendar-day implementation would produce from this
    // exact fixture — asserted here so the test provably discriminates between
    // the two implementations rather than just describing the right answer.
    const byCalendarDay = new Set(matches.map((m) => utcDay(m.gameCreation as string)));
    expect(byCalendarDay.size).toBe(2);

    const sessions = groupSessions(matches);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].games).toBe(5);
    expect(sessions[0].startedAt).toBe("2026-08-14T22:40:00.000Z");
    // Labelled by its START date — the earlier day — per spec §1.
    expect(utcDay(sessions[0].startedAt)).toBe("2026-08-14");
    // And it genuinely ends on the following day; the session straddles the
    // boundary rather than the fixture quietly avoiding it.
    expect(utcDay(sessions[0].endedAt)).toBe("2026-08-15");
  });

  it("a gap of EXACTLY 8h starts a new session", () => {
    const first = Date.parse("2026-08-14T14:00:00.000Z");
    const sessions = groupSessions([
      { gameCreation: first, win: true, gameDurationSec: null },
      { gameCreation: first + SESSION_GAP_MS, win: true, gameDurationSec: null },
    ]);
    expect(SESSION_GAP_HOURS).toBe(8);
    expect(sessions).toHaveLength(2);
  });

  it("a gap of one millisecond under 8h does NOT", () => {
    const first = Date.parse("2026-08-14T14:00:00.000Z");
    const sessions = groupSessions([
      { gameCreation: first, win: true, gameDurationSec: null },
      { gameCreation: first + SESSION_GAP_MS - 1, win: true, gameDurationSec: null },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].games).toBe(2);
  });

  it("measures the gap CREATION to CREATION, not end to start", () => {
    // Documented deliberately (spec §1): true idle time is roughly one game
    // shorter than the measured gap. Two games 7h30m apart by creation, the
    // first 40 minutes long, are 6h50m apart by idle time — one session either
    // way at an 8h threshold, and this pins WHICH quantity is compared so a
    // future "improvement" to end-to-start is a visible decision.
    const first = Date.parse("2026-08-14T10:00:00.000Z");
    const sessions = groupSessions([
      { gameCreation: first, win: true, gameDurationSec: 40 * 60 },
      { gameCreation: first + 7.5 * 3600_000, win: true, gameDurationSec: null },
    ]);
    expect(sessions).toHaveLength(1);
  });
});

describe("groupSessions — shape of the result", () => {
  it("counts wins and losses per session and returns them oldest first", () => {
    const sessions = groupSessions([
      game("2026-08-12T18:00:00.000Z", true),
      game("2026-08-12T18:40:00.000Z", false),
      game("2026-08-12T19:20:00.000Z", true),
      // next day
      game("2026-08-13T19:00:00.000Z", false),
      game("2026-08-13T19:40:00.000Z", false),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ wins: 2, losses: 1, games: 3 });
    expect(sessions[1]).toMatchObject({ wins: 0, losses: 2, games: 2 });
    expect(sessions[0].startedAtMs).toBeLessThan(sessions[1].startedAtMs);
  });

  it("endedAt is the last game's END, using the stored duration when there is one", () => {
    // my_matches DOES carry game_duration_sec (it feeds the CS headline), so
    // the rendered time range can be honest about when play actually stopped
    // instead of stopping at the last game's creation.
    const sessions = groupSessions([game("2026-08-12T18:00:00.000Z", true, 32)]);
    expect(sessions[0].endedAt).toBe("2026-08-12T18:32:00.000Z");
  });

  it("falls back to the creation time when the duration is missing or absurd", () => {
    for (const duration of [null, 0, -60, 6 * 3600]) {
      const sessions = groupSessions([
        { gameCreation: "2026-08-12T18:00:00.000Z", win: true, gameDurationSec: duration },
      ]);
      expect(sessions[0].endedAt, `duration=${duration}`).toBe("2026-08-12T18:00:00.000Z");
    }
  });

  it("sorts unsorted input rather than trusting the caller's order", () => {
    const sessions = groupSessions([
      game("2026-08-13T19:40:00.000Z"),
      game("2026-08-12T18:00:00.000Z"),
      game("2026-08-12T18:40:00.000Z"),
      game("2026-08-13T19:00:00.000Z"),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.games)).toEqual([2, 2]);
  });

  it("a single game is a session of one", () => {
    const sessions = groupSessions([game("2026-08-12T18:00:00.000Z", false, null)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ games: 1, wins: 0, losses: 1 });
    expect(sessions[0].startedAt).toBe("2026-08-12T18:00:00.000Z");
  });

  it("an empty history is an empty list, not a session of zero games", () => {
    expect(groupSessions([])).toEqual([]);
  });

  it("drops rows with an unusable timestamp instead of producing NaN", () => {
    const sessions = groupSessions([
      { gameCreation: "not-a-date", win: true, gameDurationSec: null },
      game("2026-08-12T18:00:00.000Z"),
      { gameCreation: Number.NaN, win: true, gameDurationSec: null },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].games).toBe(1);
    expect(JSON.stringify(sessions)).not.toContain("null");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sessionLpDelta — the three confidence states", () => {
  /** Two sittings a day apart: Thursday evening (3 games) and Friday evening
   *  (2 games). Every LP test below is built on this one history. */
  const HISTORY: SessionMatchInput[] = [
    game("2026-08-13T19:00:00.000Z", true, 30), // ends 19:30
    game("2026-08-13T19:40:00.000Z", false, 30), // ends 20:10
    game("2026-08-13T20:20:00.000Z", true, 30), // ends 20:50
    game("2026-08-14T20:00:00.000Z", true, 30), // ends 20:30
    game("2026-08-14T20:40:00.000Z", true, 30), // ends 21:10
  ];
  const SESSIONS = groupSessions(HISTORY);

  it("the fixture really is two sessions", () => {
    expect(SESSIONS).toHaveLength(2);
    expect(SESSIONS.map((s) => s.games)).toEqual([3, 2]);
  });

  it("EXACT: a sample on each side of the sitting and no other games between them", () => {
    const samples = [
      sample("2026-08-13T18:55:00.000Z", "EMERALD", "II", 47), // app start, Thursday
      sample("2026-08-13T20:52:00.000Z", "EMERALD", "II", 61), // game end, Thursday
      sample("2026-08-14T19:58:00.000Z", "EMERALD", "II", 61), // app start, Friday
      sample("2026-08-14T21:12:00.000Z", "EMERALD", "I", 8), // game end, Friday
    ];

    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday).toEqual({ value: 14, confidence: "exact" });

    // Friday crosses a division: Emerald II 61 -> Emerald I 8 is +47, not -53.
    const friday = sessionLpDelta(SESSIONS[1], samples, SESSIONS);
    expect(friday).toEqual({ value: 47, confidence: "exact" });
  });

  it("prefers Riot's cumulativeLp when present", () => {
    // Even a tier this build cannot yet place is usable when Riot supplied its
    // own absolute integer. Without the preferred field both rows are skipped.
    const samples = [
      sample("2026-08-13T18:55:00.000Z", "MYTHIC", "IV", 10, 1691),
      sample("2026-08-13T20:52:00.000Z", "MYTHIC", "IV", 24, 1705),
    ];
    expect(sessionLpDelta(SESSIONS[0], samples, SESSIONS)).toEqual({ value: 14, confidence: "exact" });
  });

  it("APPROXIMATE: a CONTAMINATED bracket — the only samples straddle both sittings", () => {
    // The companion was not running on Friday, so the nearest sample before
    // Friday's first game is Thursday's opening one. The LP difference is real
    // but it covers THREE games that are not Friday's.
    const samples = [
      sample("2026-08-13T18:55:00.000Z", "EMERALD", "II", 47),
      sample("2026-08-14T21:12:00.000Z", "EMERALD", "I", 8),
    ];

    const friday = sessionLpDelta(SESSIONS[1], samples, SESSIONS);
    expect(friday.confidence).toBe("approximate");
    expect(friday.value).toBe(61); // a real number, from a bracket that is too wide
    expect(friday.reason).toBe("extra-games");
    expect(friday.extraGames).toBe(3); // Thursday's three games

    // The same bracket is contaminated for Thursday too, by Friday's two.
    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday.confidence).toBe("approximate");
    expect(thursday.reason).toBe("extra-games");
    expect(thursday.extraGames).toBe(2);
  });

  it("APPROXIMATE: capture started MID-session, so the bracket opens late", () => {
    // The user installed the companion between their second and third game.
    // +9 covers one game of three; it is a real reading of part of the sitting,
    // and it is marked so the UI can say so.
    const samples = [
      sample("2026-08-13T20:15:00.000Z", "EMERALD", "II", 52), // after game 2
      sample("2026-08-13T20:52:00.000Z", "EMERALD", "II", 61), // after game 3
    ];
    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday.confidence).toBe("approximate");
    expect(thursday.value).toBe(9);
    expect(thursday.reason).toBe("partial-open");
    expect(thursday.extraGames).toBe(0);
  });

  it("APPROXIMATE: the sitting is still going, so the bracket closes early", () => {
    const samples = [
      sample("2026-08-13T18:55:00.000Z", "EMERALD", "II", 47),
      sample("2026-08-13T20:12:00.000Z", "EMERALD", "II", 39), // after game 2, none after game 3
    ];
    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday.confidence).toBe("approximate");
    expect(thursday.value).toBe(-8);
    expect(thursday.reason).toBe("partial-close");
  });

  it("UNAVAILABLE: no samples at all renders a dash and NEVER a number from the win count", () => {
    // THE RULE THAT MATTERS. Every session before capture shipped is here.
    const winning = groupSessions([
      game("2026-06-01T18:00:00.000Z", true),
      game("2026-06-01T18:40:00.000Z", true),
      game("2026-06-01T19:20:00.000Z", true),
      game("2026-06-01T20:00:00.000Z", true),
      game("2026-06-01T20:40:00.000Z", true),
    ]);
    expect(winning[0]).toMatchObject({ wins: 5, losses: 0 });

    const result = sessionLpDelta(winning[0], [], winning);
    expect(result.value).toBeNull();
    expect(result.confidence).toBe("unavailable");
    expect(result.reason).toBe("no-samples");
    // Not 5 wins x anything, not 0, not the game count. Null.
    expect(result.value).not.toBe(0);
    expect(result).not.toHaveProperty("extraGames");
  });

  it("UNAVAILABLE: every sample sits on the same side of the session", () => {
    // A session that predates capture entirely: samples exist, but all of them
    // are after it. There is nothing to subtract from.
    const samples = [
      sample("2026-08-14T19:58:00.000Z", "EMERALD", "II", 61),
      sample("2026-08-14T21:12:00.000Z", "EMERALD", "I", 8),
    ];
    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday).toEqual({ value: null, confidence: "unavailable", reason: "unbracketed" });
  });

  it("UNAVAILABLE: a sample that does not bracket the session is not a bracket", () => {
    const samples = [sample("2026-08-13T19:50:00.000Z", "EMERALD", "II", 52)];
    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday).toEqual({ value: null, confidence: "unavailable", reason: "unbracketed" });
  });

  it("samples that cannot be placed on the ladder are ignored, not treated as zero", () => {
    // An unranked reading and a tier this app does not know. Either one placed
    // at 0 LP would produce a delta of ~2,000.
    const samples = [
      sample("2026-08-13T18:55:00.000Z", null, null, null), // unranked
      sample("2026-08-13T20:52:00.000Z", "MYTHIC", "I", 61), // a tier we do not know
    ];
    const thursday = sessionLpDelta(SESSIONS[0], samples, SESSIONS);
    expect(thursday.confidence).toBe("unavailable");
    expect(thursday.value).toBeNull();
  });

  it("a promotion inside the bracket is counted on the absolute scale", () => {
    // The ladder module's headline case, reached through the session path so
    // the two are wired together and not merely individually correct.
    const samples = [
      sample("2026-08-13T18:55:00.000Z", "GOLD", "I", 90),
      sample("2026-08-13T20:52:00.000Z", "PLATINUM", "IV", 10),
    ];
    expect(sessionLpDelta(SESSIONS[0], samples, SESSIONS)).toEqual({ value: 20, confidence: "exact" });
  });

  it("a sample exactly on a boundary counts as outside the session, both ends", () => {
    // The open sample lands on the first game's creation and the close sample
    // on the last game's end. Both are legitimate bracket ends (champ-select
    // and game-end capture land there), so this must be EXACT, not partial.
    const samples = [
      sample(SESSIONS[0].startedAt, "EMERALD", "II", 47),
      sample(SESSIONS[0].endedAt, "EMERALD", "II", 61),
    ];
    expect(sessionLpDelta(SESSIONS[0], samples, SESSIONS)).toEqual({ value: 14, confidence: "exact" });
  });
});
