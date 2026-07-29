import { describe, expect, it } from "vitest";
import {
  DEPTH_DEFICIT_FLOOR,
  DEPTH_TARGET,
  REEXHAUST_INTERVAL_MS,
  UNPLAYED_PLAY_WEIGHT,
  decideLock,
  depthDeficit,
  isResting,
  playWeight,
  rankPriorities,
  resolveCursorAction,
  selectUnitIds,
  summarizeProgress,
  trimLogText,
  type ChampionWalkState,
} from "../deepWalk";

const NOW = new Date("2026-07-29T18:00:00Z");

function state(over: Partial<ChampionWalkState> & { championId: number }): ChampionWalkState {
  return {
    championKey: `champ${over.championId}`,
    myGames: 0,
    storedGames: 0,
    featuredPuuid: `puuid-${over.championId}`,
    cursorPuuid: null,
    idsOffset: 0,
    windowExhausted: false,
    lastExhaustedAt: null,
    ...over,
  };
}

describe("playWeight", () => {
  it("rises with games played but compresses the skew", () => {
    // The user's pool is heavily skewed (45 games on champion 112, a long tail
    // at 1-3). Linear weighting would make the top champion 45x more urgent and
    // starve the tail; log2 keeps the order and compresses the ratio to ~5.5x.
    expect(playWeight(45) / playWeight(1)).toBeGreaterThan(5);
    expect(playWeight(45) / playWeight(1)).toBeLessThan(6);
    expect(playWeight(45)).toBeGreaterThan(playWeight(10));
    expect(playWeight(10)).toBeGreaterThan(playWeight(1));
  });

  it("is zero for an unplayed champion unless fleet mode is on", () => {
    expect(playWeight(0)).toBe(0);
    expect(playWeight(0, true)).toBe(UNPLAYED_PLAY_WEIGHT);
  });

  it("never lets an unplayed champion outweigh a champion played even once", () => {
    // Load-bearing: enabling --fleet must not reorder the user's own champions
    // or push one below a champion they have never touched.
    expect(UNPLAYED_PLAY_WEIGHT).toBeLessThan(playWeight(1));
  });
});

describe("depthDeficit", () => {
  it("ramps linearly toward the target", () => {
    expect(depthDeficit(0, 120)).toBeCloseTo(1, 6);
    expect(depthDeficit(60, 120)).toBeCloseTo(0.5, 6);
    expect(depthDeficit(90, 120)).toBeCloseTo(0.25, 6);
  });

  it("floors rather than reaching zero", () => {
    expect(depthDeficit(120, 120)).toBe(DEPTH_DEFICIT_FLOOR);
    expect(depthDeficit(9999, 120)).toBe(DEPTH_DEFICIT_FLOOR);
  });

  it("survives a nonsense target instead of dividing by zero", () => {
    expect(depthDeficit(10, 0)).toBe(DEPTH_DEFICIT_FLOOR);
  });
});

describe("rankPriorities — the property the whole design was asked for", () => {
  it("puts heavily-played-and-shallow above rarely-played-and-deep", () => {
    const plan = rankPriorities(
      [
        state({ championId: 1, championKey: "Deep", myGames: 1, storedGames: 100 }),
        state({ championId: 2, championKey: "Shallow", myGames: 45, storedGames: 10 }),
      ],
      { now: NOW }
    );
    expect(plan.ranked.map((e) => e.championKey)).toEqual(["Shallow", "Deep"]);
    // And not marginally: the gap has to be big enough that it survives a few
    // units of progress rather than flipping on the next pass.
    expect(plan.ranked[0].score / plan.ranked[1].score).toBeGreaterThan(10);
  });

  it("prefers the shallower of two equally-played champions", () => {
    const plan = rankPriorities(
      [
        state({ championId: 1, championKey: "A", myGames: 20, storedGames: 90 }),
        state({ championId: 2, championKey: "B", myGames: 20, storedGames: 20 }),
      ],
      { now: NOW }
    );
    expect(plan.ranked[0].championKey).toBe("B");
  });

  it("prefers the more-played of two equally-shallow champions", () => {
    const plan = rankPriorities(
      [
        state({ championId: 1, championKey: "A", myGames: 3, storedGames: 30 }),
        state({ championId: 2, championKey: "B", myGames: 40, storedGames: 30 }),
      ],
      { now: NOW }
    );
    expect(plan.ranked[0].championKey).toBe("B");
  });

  it("breaks ties on champion id so two passes over identical state agree", () => {
    const states = [
      state({ championId: 30, myGames: 5, storedGames: 40 }),
      state({ championId: 7, myGames: 5, storedGames: 40 }),
      state({ championId: 19, myGames: 5, storedGames: 40 }),
    ];
    const a = rankPriorities(states, { now: NOW }).ranked.map((e) => e.championId);
    const b = rankPriorities([...states].reverse(), { now: NOW }).ranked.map((e) => e.championId);
    expect(a).toEqual([7, 19, 30]);
    expect(b).toEqual(a);
  });

  it("a newly played champion enters the list with no manual edit", () => {
    // The list is derived from live state every pass, never snapshotted. So the
    // ONLY thing that has to happen for a champion to appear is my_matches
    // growing — which is why the walk refreshes my_matches before it recomputes.
    const before = [
      state({ championId: 1, championKey: "Known", myGames: 45, storedGames: 10 }),
      state({ championId: 2, championKey: "JustPlayed", myGames: 0, storedGames: 0 }),
    ];
    const planBefore = rankPriorities(before, { now: NOW });
    expect(planBefore.ranked.map((e) => e.championKey)).toEqual(["Known"]);
    expect(planBefore.skipped.find((s) => s.championKey === "JustPlayed")?.reason).toBe(
      "not-played"
    );

    // One game appears in my_matches. Nothing else changes anywhere.
    const after = [before[0], { ...before[1], myGames: 1 }];
    const planAfter = rankPriorities(after, { now: NOW });
    expect(planAfter.ranked.map((e) => e.championKey)).toContain("JustPlayed");
    // And with zero stored games it outranks nothing-else-changed champions
    // that are already partly walked — a full deficit against a shallow one.
    expect(planAfter.ranked[0].championKey).toBe("Known"); // 45 games still dominates
    expect(planAfter.ranked[1].championKey).toBe("JustPlayed");
  });

  it("a brand-new champion with no featured account is surfaced, not silently dropped", () => {
    const plan = rankPriorities(
      [state({ championId: 5, championKey: "NoAccount", myGames: 12, featuredPuuid: null })],
      { now: NOW }
    );
    expect(plan.ranked).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({
      championKey: "NoAccount",
      reason: "no-featured-account",
    });
  });

  it("rests an exhausted champion, then lets it back in", () => {
    const justExhausted = state({
      championId: 1,
      myGames: 45,
      storedGames: 200,
      windowExhausted: true,
      lastExhaustedAt: new Date(NOW.getTime() - 60_000),
    });
    expect(rankPriorities([justExhausted], { now: NOW }).ranked).toHaveLength(0);
    expect(rankPriorities([justExhausted], { now: NOW }).skipped[0].reason).toBe(
      "resting-after-exhaustion"
    );

    const rested = {
      ...justExhausted,
      lastExhaustedAt: new Date(NOW.getTime() - REEXHAUST_INTERVAL_MS - 1000),
    };
    expect(rankPriorities([rested], { now: NOW }).ranked).toHaveLength(1);
  });

  it("does not park a champion forever on a missing exhaustion timestamp", () => {
    const s = state({ championId: 1, myGames: 5, windowExhausted: true, lastExhaustedAt: null });
    expect(isResting(s, NOW)).toBe(false);
    expect(rankPriorities([s], { now: NOW }).ranked).toHaveLength(1);
  });

  it("fleet mode never reorders the played champions among themselves", () => {
    const states = [
      state({ championId: 1, championKey: "Played1", myGames: 45, storedGames: 10 }),
      state({ championId: 2, championKey: "Played2", myGames: 2, storedGames: 5 }),
      state({ championId: 3, championKey: "Unplayed", myGames: 0, storedGames: 0 }),
    ];
    const played = rankPriorities(states, { now: NOW }).ranked.map((e) => e.championKey);
    const fleet = rankPriorities(states, { now: NOW, includeUnplayed: true }).ranked.map(
      (e) => e.championKey
    );
    expect(played).toEqual(["Played1", "Played2"]);
    // Same relative order, unplayed strictly last.
    expect(fleet.filter((k) => k !== "Unplayed")).toEqual(played);
    expect(fleet[fleet.length - 1]).toBe("Unplayed");
  });
});

describe("selectUnitIds — resumability", () => {
  const page = Array.from({ length: 20 }, (_, i) => `EUW1_${i}`);

  it("takes at most one unit and reports what is left", () => {
    const sel = selectUnitIds(page, new Set(), 6);
    expect(sel.take).toEqual(page.slice(0, 6));
    expect(sel.remaining).toBe(14);
    expect(sel.pageDrained).toBe(false);
  });

  it("TWO PASSES OVER THE SAME STATE DO NOT DOUBLE-FETCH", () => {
    // This is the resumability contract. Pass 1 examines 6 ids; those 6 land in
    // otp_featured_scanned. Pass 2 sees the same page and must select six
    // DIFFERENT ids — never one it already paid for.
    const scanned = new Set<string>();
    const pass1 = selectUnitIds(page, scanned, 6);
    pass1.take.forEach((id) => scanned.add(id));
    const pass2 = selectUnitIds(page, scanned, 6);

    expect(pass2.take).toHaveLength(6);
    expect(pass2.take.some((id) => pass1.take.includes(id))).toBe(false);
    expect(new Set([...pass1.take, ...pass2.take]).size).toBe(12);
  });

  it("a killed unit re-fetches only what it had not already recorded", () => {
    // Kill after 2 of 6. Those 2 have scanned rows (they are written per match,
    // immediately), the other 4 do not.
    const scanned = new Set<string>();
    const started = selectUnitIds(page, scanned, 6);
    started.take.slice(0, 2).forEach((id) => scanned.add(id));

    const afterRestart = selectUnitIds(page, scanned, 6);
    expect(afterRestart.take.some((id) => started.take.slice(0, 2).includes(id))).toBe(false);
    // The 4 in-flight ids come back — nothing was fetched for them, so nothing
    // is lost by re-selecting them.
    expect(afterRestart.take.slice(0, 4)).toEqual(started.take.slice(2));
  });

  it("reports a fully examined page as drained so the walk advances", () => {
    const sel = selectUnitIds(page, new Set(page), 6);
    expect(sel.take).toEqual([]);
    expect(sel.pageDrained).toBe(true);
    expect(sel.remaining).toBe(0);
  });

  it("re-examining a rejected match never happens — the whole point of 0019", () => {
    // A match examined and REJECTED (off-champion, so never in otp_matches) is
    // still in the scanned set, so it is never selected again. Without this the
    // featured Ahri one-trick's 116 off-champion games would cost a Riot call
    // on every single pass, forever.
    const rejected = new Set(["EUW1_3", "EUW1_4"]);
    const sel = selectUnitIds(page, rejected, 6);
    expect(sel.take).not.toContain("EUW1_3");
    expect(sel.take).not.toContain("EUW1_4");
  });
});

describe("resolveCursorAction", () => {
  it("starts fresh when there is no cursor", () => {
    expect(resolveCursorAction(state({ championId: 1 }), NOW)).toEqual({
      kind: "reset",
      offset: 0,
      reason: "fresh",
    });
  });

  it("resumes at the persisted offset for the same account", () => {
    const s = state({ championId: 1, cursorPuuid: "puuid-1", idsOffset: 200 });
    expect(resolveCursorAction(s, NOW)).toEqual({ kind: "resume", offset: 200 });
  });

  it("RESETS when the featured account changed under it", () => {
    // An offset into a different account's history is not a smaller offset, it
    // is a meaningless one — resuming at 200 into an account with 90 games
    // returns nothing, forever, and looks like an inactive player.
    const s = state({
      championId: 1,
      featuredPuuid: "new-account",
      cursorPuuid: "old-account",
      idsOffset: 200,
    });
    expect(resolveCursorAction(s, NOW)).toEqual({
      kind: "reset",
      offset: 0,
      reason: "puuid-changed",
    });
  });

  it("re-walks from the top once the rest interval expires", () => {
    const s = state({
      championId: 1,
      cursorPuuid: "puuid-1",
      idsOffset: 300,
      windowExhausted: true,
      lastExhaustedAt: new Date(NOW.getTime() - REEXHAUST_INTERVAL_MS - 1),
    });
    expect(resolveCursorAction(s, NOW)).toEqual({ kind: "reset", offset: 0, reason: "rewalk" });
  });

  it("stays put while still resting", () => {
    const s = state({
      championId: 1,
      cursorPuuid: "puuid-1",
      idsOffset: 300,
      windowExhausted: true,
      lastExhaustedAt: new Date(NOW.getTime() - 1000),
    });
    expect(resolveCursorAction(s, NOW)).toEqual({ kind: "resume", offset: 300 });
  });

  it("never returns a negative offset", () => {
    const s = state({ championId: 1, cursorPuuid: "puuid-1", idsOffset: -5 });
    expect(resolveCursorAction(s, NOW)).toEqual({ kind: "resume", offset: 0 });
  });
});

describe("decideLock", () => {
  const MARKER = "ingest-otp-priority";

  it("takes a free lock", () => {
    expect(decideLock(null, null, MARKER)).toEqual({ take: true, reason: "no-lock" });
  });

  it("REFUSES to start beside a live instance", () => {
    // riotYield.ts's SELF_MARKER makes this walk invisible to itself, so two
    // copies would each read the other as "self" and run concurrently — the
    // exact failure the yield predicate exists to prevent, through its own
    // escape hatch. This is the only thing that catches it.
    const d = decideLock(
      { pid: 4242, startedAt: NOW.toISOString() },
      "node scripts/ingest-otp-priority.mjs --max-hours 12",
      MARKER
    );
    expect(d).toEqual({ take: false, reason: "live-instance", pid: 4242 });
  });

  it("takes over a lock whose process is gone", () => {
    expect(decideLock({ pid: 4242, startedAt: NOW.toISOString() }, null, MARKER)).toEqual({
      take: true,
      reason: "stale-pid",
    });
  });

  it("takes over when Windows reused the pid for something unrelated", () => {
    expect(
      decideLock({ pid: 4242, startedAt: NOW.toISOString() }, "notepad.exe readme.txt", MARKER)
    ).toEqual({ take: true, reason: "pid-reused" });
  });
});

describe("trimLogText", () => {
  it("leaves a log inside budget alone", () => {
    expect(trimLogText("a\nb\nc\n", 1024)).toBeNull();
  });

  it("keeps roughly the newest half and cuts on a line boundary", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const trimmed = trimLogText(text, 100);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.length).toBeLessThan(text.length);
    // Never opens mid-line: the first character begins a real log line.
    expect(trimmed!.startsWith("line ")).toBe(true);
    expect(text.endsWith(trimmed!)).toBe(true);
  });

  it("handles a single enormous line without looping forever", () => {
    const trimmed = trimLogText("x".repeat(5000), 100);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.length).toBe(2500);
  });
});

describe("summarizeProgress", () => {
  it("counts the fleet the way the log reports it", () => {
    const p = summarizeProgress(
      [
        state({ championId: 1, storedGames: 232, windowExhausted: true }),
        state({ championId: 2, storedGames: 39 }),
        state({ championId: 3, storedGames: 0 }),
      ],
      DEPTH_TARGET
    );
    expect(p).toEqual({
      champions: 3,
      exhausted: 1,
      atTarget: 1,
      storedTotal: 271,
      storedShortfall: (DEPTH_TARGET - 39) + DEPTH_TARGET,
    });
  });
});
