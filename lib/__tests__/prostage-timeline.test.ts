import { describe, it, expect } from "vitest";
import {
  processTimelineFrame,
  buildTimeline,
  iso10s,
  type DetailsFrame,
  type DetailsResponse,
  type GameMetadata,
} from "@/lib/prostage/timeline";
import {
  leagueSlugForOverviewPage,
  parseGameNumber,
  teamsMatch,
  resolveChampionKey,
  mapTimelinesToPlayers,
  distinctTeams,
  resolveEsportsGameId,
  computeGameTimelines,
  type TimelineDbRow,
} from "@/lib/prostage/resolveGame";
import { LolesportsFetchError } from "@/lib/prostage/lolesports";

// ── processTimelineFrame (appear-only diffing) ──────────────────────────────

describe("processTimelineFrame", () => {
  const start = "2026-01-01T00:00:00Z";
  const mkState = () => ({ gameStartTs: start, seq: {} as Record<number, Array<{ id: number; atSec: number }>>, seen: {} as Record<number, Set<number>> });

  it("records first appearance with seconds-into-game, ignores empty slots", () => {
    const st = mkState();
    const frame: DetailsFrame = {
      rfc460Timestamp: "2026-01-01T00:00:05Z",
      participants: [{ participantId: 1, items: [0, 1001, 0, 1002] }],
    };
    processTimelineFrame(frame, st);
    expect(st.seq[1]).toEqual([
      { id: 1001, atSec: 5 },
      { id: 1002, atSec: 5 },
    ]);
  });

  it("does not re-record an already-seen item (appear-only, ignores disappearance)", () => {
    const st = mkState();
    processTimelineFrame({ rfc460Timestamp: "2026-01-01T00:00:10Z", participants: [{ participantId: 1, items: [1001] }] }, st);
    // item sold then a NEW item appears — 1001 must not re-append; 1055 records at its first-seen time
    processTimelineFrame({ rfc460Timestamp: "2026-01-01T00:00:40Z", participants: [{ participantId: 1, items: [1055] }] }, st);
    processTimelineFrame({ rfc460Timestamp: "2026-01-01T00:01:00Z", participants: [{ participantId: 1, items: [1001, 1055] }] }, st);
    expect(st.seq[1]).toEqual([
      { id: 1001, atSec: 10 },
      { id: 1055, atSec: 40 },
    ]);
  });

  it("tracks participants independently", () => {
    const st = mkState();
    processTimelineFrame(
      { rfc460Timestamp: "2026-01-01T00:00:20Z", participants: [{ participantId: 1, items: [1001] }, { participantId: 6, items: [2003] }] },
      st
    );
    expect(st.seq[1]).toEqual([{ id: 1001, atSec: 20 }]);
    expect(st.seq[6]).toEqual([{ id: 2003, atSec: 20 }]);
  });
});

// ── buildTimeline (concurrent walk, dedupe, 204 vs failure) ─────────────────

describe("buildTimeline", () => {
  const start = "2026-01-01T00:00:00Z";
  const end = "2026-01-01T00:00:20Z";

  it("walks pages, dedupes overlapping frames, processes chronologically, no taint on 204", async () => {
    const pages: Record<string, DetailsResponse | null> = {
      [iso10s(new Date(start).getTime())]: { frames: [{ rfc460Timestamp: "2026-01-01T00:00:05Z", participants: [{ participantId: 1, items: [1001] }] }] },
      [iso10s(new Date(start).getTime() + 10_000)]: {
        frames: [
          // overlaps the previous frame timestamp (dedupe target) + a new one
          { rfc460Timestamp: "2026-01-01T00:00:05Z", participants: [{ participantId: 1, items: [1001] }] },
          { rfc460Timestamp: "2026-01-01T00:00:15Z", participants: [{ participantId: 1, items: [1001, 1002] }] },
        ],
      },
      [iso10s(new Date(start).getTime() + 20_000)]: { frames: [] }, // 204 empty — no taint
      [iso10s(new Date(start).getTime() + 30_000)]: { frames: [] },
    };
    const res = await buildTimeline("g", start, end, {
      fetchDetails: async (t) => pages[t] ?? { frames: [] },
      concurrency: 4,
      retryAttempts: 0,
      retryBackoffMs: 0,
    });
    expect(res.hadFailures).toBe(false);
    expect(res.seq[1]).toEqual([
      { id: 1001, atSec: 5 },
      { id: 1002, atSec: 15 },
    ]);
  });

  it("sets hadFailures when a page fails after retries (null strictly)", async () => {
    const res = await buildTimeline("g", start, end, {
      fetchDetails: async (t) => (t === iso10s(new Date(start).getTime() + 10_000) ? null : { frames: [] }),
      concurrency: 4,
      retryAttempts: 1,
      retryBackoffMs: 0,
    });
    expect(res.hadFailures).toBe(true);
  });
});

// ── league mapping ──────────────────────────────────────────────────────────

describe("leagueSlugForOverviewPage", () => {
  it("maps tier-1 prefixes", () => {
    expect(leagueSlugForOverviewPage("LEC/2026 Season/Spring Playoffs")).toBe("lec");
    expect(leagueSlugForOverviewPage("LCK/2026 Season/Road to MSI")).toBe("lck");
    expect(leagueSlugForOverviewPage("LPL/2026 Season/Split 2 Playoffs")).toBe("lpl");
    expect(leagueSlugForOverviewPage("LCS/2026 Season/Spring Playoffs")).toBe("lcs");
  });
  it("maps international events by contained name", () => {
    expect(leagueSlugForOverviewPage("2026 Mid-Season Invitational")).toBe("msi");
    expect(leagueSlugForOverviewPage("2026 World Championship")).toBe("worlds");
  });
  it("excludes prefix false positives and unknown pages", () => {
    expect(leagueSlugForOverviewPage("LPLOL/2026 Season/Split 1")).toBeNull(); // Brazilian league, not LPL
    expect(leagueSlugForOverviewPage("Some Random Cup 2026")).toBeNull();
  });
});

// ── parseGameNumber ─────────────────────────────────────────────────────────

describe("parseGameNumber", () => {
  it("reads the trailing game-in-series segment", () => {
    expect(parseGameNumber("2026 Mid-Season Invitational_Bracket Round 2_4_1")).toBe(1);
    expect(parseGameNumber("2026 Mid-Season Invitational_Bracket Round 2_4_4")).toBe(4);
    expect(parseGameNumber("LEC/2026 Season/Spring Playoffs_Semifinals_2_3")).toBe(3);
  });
  it("returns null for a non-numeric trailing segment", () => {
    expect(parseGameNumber("weird_game_id_abc")).toBeNull();
    expect(parseGameNumber("noseparators")).toBeNull();
  });
});

// ── teamsMatch ──────────────────────────────────────────────────────────────

describe("teamsMatch", () => {
  const evTeams = [
    { name: "G2 Esports", code: "G2" },
    { name: "T1", code: "T1" },
  ];
  it("matches on name or code regardless of order", () => {
    expect(teamsMatch(["T1", "G2 Esports"], evTeams)).toBe(true);
    expect(teamsMatch(["G2 Esports", "T1"], evTeams)).toBe(true);
    expect(teamsMatch(["G2", "T1"], evTeams)).toBe(true); // DB stored short code
  });
  it("rejects a non-matching pair or wrong team count", () => {
    expect(teamsMatch(["T1", "Gen.G"], evTeams)).toBe(false);
    expect(teamsMatch(["T1", "G2 Esports"], [{ name: "T1" }])).toBe(false);
  });
});

// ── resolveChampionKey ──────────────────────────────────────────────────────

describe("resolveChampionKey", () => {
  const map = new Map<string, number>([
    ["MonkeyKing", 62],
    ["JarvanIV", 59],
    ["Renekton", 58],
  ]);
  it("passes a bare numeric through", () => {
    expect(resolveChampionKey("62", map)).toBe(62);
  });
  it("resolves an internal id (incl. the Wukong/MonkeyKing case)", () => {
    expect(resolveChampionKey("MonkeyKing", map)).toBe(62);
    expect(resolveChampionKey("Renekton", map)).toBe(58);
  });
  it("returns null for an unknown internal id", () => {
    expect(resolveChampionKey("NotAChampion", map)).toBeNull();
  });
});

// ── mapTimelinesToPlayers ───────────────────────────────────────────────────

describe("mapTimelinesToPlayers", () => {
  const champMap = new Map<string, number>([
    ["MonkeyKing", 62], // Wukong
    ["Renekton", 58],
    ["Cassiopeia", 69],
  ]);
  const meta: GameMetadata = {
    patchVersion: "16.13.790.6961",
    blueTeamMetadata: {
      esportsTeamId: "B",
      participantMetadata: [
        { participantId: 1, summonerName: "G2 BrokenBlade", championId: "Renekton", role: "top" },
      ],
    },
    redTeamMetadata: {
      esportsTeamId: "R",
      participantMetadata: [
        { participantId: 6, summonerName: "T1 Oner", championId: "MonkeyKing", role: "jungle" },
        { participantId: 8, summonerName: "T1 Faker", championId: "Cassiopeia", role: "mid" },
      ],
    },
  };
  const dbRows: TimelineDbRow[] = [
    { player_link: "BrokenBlade", team: "G2 Esports", champion_id: 58 },
    { player_link: "Oner", team: "T1", champion_id: 62 }, // Wukong -> matched via MonkeyKing
    { player_link: "Faker", team: "T1", champion_id: 69 },
  ];

  it("maps each participant's sequence to a player_link by champion_id, shaped as ProGamePurchase", () => {
    const timeline = {
      hadFailures: false,
      seq: {
        1: [{ id: 3047, atSec: 120 }],
        6: [{ id: 1101, atSec: 60 }, { id: 3340, atSec: 61 }],
        8: [{ id: 1056, atSec: 40 }],
      },
    };
    const byPlayer = mapTimelinesToPlayers(timeline, meta, dbRows, champMap);
    expect(byPlayer.get("BrokenBlade")).toEqual([{ itemId: 3047, ts: 120 }]);
    expect(byPlayer.get("Oner")).toEqual([{ itemId: 1101, ts: 60 }, { itemId: 3340, ts: 61 }]);
    expect(byPlayer.get("Faker")).toEqual([{ itemId: 1056, ts: 40 }]);
  });

  it("skips a participant whose champion doesn't match any DB row", () => {
    const meta2: GameMetadata = {
      ...meta,
      redTeamMetadata: {
        esportsTeamId: "R",
        participantMetadata: [{ participantId: 6, summonerName: "x", championId: "Cassiopeia", role: "mid" }],
      },
    };
    const byPlayer = mapTimelinesToPlayers({ hadFailures: false, seq: { 6: [{ id: 1, atSec: 1 }] } }, meta2, [{ player_link: "z", team: "T1", champion_id: 999 }], champMap);
    expect(byPlayer.size).toBe(0);
  });
});

// ── distinctTeams ───────────────────────────────────────────────────────────

describe("distinctTeams", () => {
  it("returns the two distinct team names", () => {
    const rows: TimelineDbRow[] = [
      { player_link: "a", team: "T1", champion_id: 1 },
      { player_link: "b", team: "T1", champion_id: 2 },
      { player_link: "c", team: "G2 Esports", champion_id: 3 },
    ];
    expect(distinctTeams(rows)).toEqual(["T1", "G2 Esports"]);
  });
});

// ── resolveEsportsGameId ────────────────────────────────────────────────────

describe("resolveEsportsGameId", () => {
  const baseDeps = {
    getLeagues: async () => [{ id: "L-MSI", slug: "msi", name: "MSI" }],
    getScheduleForLeague: async () => ({
      events: [
        {
          startTime: "2026-07-08T08:00:00Z",
          type: "match",
          state: "completed",
          match: { id: "M1", teams: [{ name: "G2 Esports", code: "G2" }, { name: "T1", code: "T1" }] },
        },
      ],
      olderToken: null,
    }),
    getEventDetails: async () => ({
      teams: [],
      games: [
        { number: 1, id: "115570934355614582", state: "completed" },
        { number: 2, id: "115570934355614583", state: "completed" },
      ],
    }),
  };

  it("resolves to the esports game id for the matched game number", async () => {
    const r = await resolveEsportsGameId(
      { overviewPage: "2026 Mid-Season Invitational", teams: ["T1", "G2 Esports"], gameDatetime: "2026-07-08T05:52:00Z", gameNumber: 1 },
      baseDeps
    );
    expect(r).toEqual({ ok: true, esportsGameId: "115570934355614582" });
  });

  it("returns unavailable when no league maps", async () => {
    const r = await resolveEsportsGameId(
      { overviewPage: "Unknown Cup", teams: ["A", "B"], gameDatetime: "2026-07-08T05:52:00Z", gameNumber: 1 },
      baseDeps
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ transient: false });
  });

  it("returns unavailable when no schedule event matches teams+date", async () => {
    const r = await resolveEsportsGameId(
      { overviewPage: "2026 Mid-Season Invitational", teams: ["Gen.G", "HLE"], gameDatetime: "2026-07-08T05:52:00Z", gameNumber: 1 },
      baseDeps
    );
    expect(r).toMatchObject({ ok: false, transient: false });
  });

  it("returns unavailable when the matched match has no such game number", async () => {
    const r = await resolveEsportsGameId(
      { overviewPage: "2026 Mid-Season Invitational", teams: ["T1", "G2 Esports"], gameDatetime: "2026-07-08T05:52:00Z", gameNumber: 5 },
      baseDeps
    );
    expect(r).toMatchObject({ ok: false, transient: false });
  });

  it("returns TRANSIENT on a lolesports API failure", async () => {
    const r = await resolveEsportsGameId(
      { overviewPage: "2026 Mid-Season Invitational", teams: ["T1", "G2 Esports"], gameDatetime: "2026-07-08T05:52:00Z", gameNumber: 1 },
      { ...baseDeps, getLeagues: async () => { throw new LolesportsFetchError("HTTP 503", 503); } }
    );
    expect(r).toMatchObject({ ok: false, transient: true });
  });

  it("does not match an event outside the ±48h date window", async () => {
    const r = await resolveEsportsGameId(
      { overviewPage: "2026 Mid-Season Invitational", teams: ["T1", "G2 Esports"], gameDatetime: "2026-07-20T00:00:00Z", gameNumber: 1 },
      baseDeps
    );
    expect(r).toMatchObject({ ok: false, transient: false });
  });
});

// ── computeGameTimelines (orchestrator, fully mocked) ────────────────────────

describe("computeGameTimelines", () => {
  const dbRows: TimelineDbRow[] = [
    { player_link: "BrokenBlade", team: "G2 Esports", champion_id: 58 },
    { player_link: "Faker", team: "T1", champion_id: 69 },
  ];
  const meta: GameMetadata = {
    patchVersion: "16.13.790.6961",
    blueTeamMetadata: { esportsTeamId: "B", participantMetadata: [{ participantId: 1, summonerName: "G2 BrokenBlade", championId: "Renekton", role: "top" }] },
    redTeamMetadata: { esportsTeamId: "R", participantMetadata: [{ participantId: 8, summonerName: "T1 Faker", championId: "Cassiopeia", role: "mid" }] },
  };
  const deps = {
    getLeagues: async () => [{ id: "L-MSI", slug: "msi", name: "MSI" }],
    getScheduleForLeague: async () => ({
      events: [{ startTime: "2026-07-08T08:00:00Z", type: "match", state: "completed", match: { id: "M1", teams: [{ name: "G2 Esports", code: "G2" }, { name: "T1", code: "T1" }] } }],
      olderToken: null,
    }),
    getEventDetails: async () => ({ teams: [], games: [{ number: 1, id: "ESP1", state: "completed" }] }),
    fetchOpeningWindow: async () => ({ ok: true as const, metadata: meta, gameStartTs: "2026-07-08T05:52:45Z" }),
    fetchLatestFrameTs: async () => "2026-07-08T06:20:00Z",
    buildTimeline: async () => ({ hadFailures: false, seq: { 1: [{ id: 3047, atSec: 100 }], 8: [{ id: 1056, atSec: 40 }] } }),
    getChampionKeyByInternalId: async () => new Map<string, number>([["Renekton", 58], ["Cassiopeia", 69]]),
  };

  it("returns ok with per-player build order mapped by champion_id", async () => {
    const r = await computeGameTimelines("2026 Mid-Season Invitational_Bracket Round 2_4_1", "2026-07-08T05:52:00Z", "2026 Mid-Season Invitational", dbRows, deps);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.lolesportsGameId).toBe("ESP1");
      expect(r.byPlayer.get("BrokenBlade")).toEqual([{ itemId: 3047, ts: 100 }]);
      expect(r.byPlayer.get("Faker")).toEqual([{ itemId: 1056, ts: 40 }]);
    }
  });

  it("propagates unavailable from resolution", async () => {
    const r = await computeGameTimelines("Unknown Cup_1_1", "2026-07-08T05:52:00Z", "Unknown Cup", dbRows, deps);
    expect(r.status).toBe("unavailable");
  });

  it("returns transient (never persists) when the details walk is tainted", async () => {
    const r = await computeGameTimelines(
      "2026 Mid-Season Invitational_Bracket Round 2_4_1",
      "2026-07-08T05:52:00Z",
      "2026 Mid-Season Invitational",
      dbRows,
      { ...deps, buildTimeline: async () => ({ hadFailures: true, seq: {} }) }
    );
    expect(r.status).toBe("transient");
  });

  it("returns unavailable when the livestats feed genuinely has no data (404/empty)", async () => {
    const r = await computeGameTimelines(
      "2026 Mid-Season Invitational_Bracket Round 2_4_1",
      "2026-07-08T05:52:00Z",
      "2026 Mid-Season Invitational",
      dbRows,
      { ...deps, fetchOpeningWindow: async () => ({ ok: false as const, transient: false }) }
    );
    expect(r.status).toBe("unavailable");
  });

  it("returns TRANSIENT when the opening window fetch has a 5xx/network blip", async () => {
    const r = await computeGameTimelines(
      "2026 Mid-Season Invitational_Bracket Round 2_4_1",
      "2026-07-08T05:52:00Z",
      "2026 Mid-Season Invitational",
      dbRows,
      { ...deps, fetchOpeningWindow: async () => ({ ok: false as const, transient: true }) }
    );
    expect(r.status).toBe("transient");
  });
});
