/**
 * Route-level tests for GET /api/prostage/timeline.
 *
 * 2026-07-26 security fix (audit P1-3, "the worst unauthenticated cost
 * amplifier"): added an atomic in-flight claim + post-transient-failure
 * cooldown via `timeline_next_attempt_at` (migration 0016). Every test in the
 * "cooldown / in-flight claim / backoff" describe block below FAILS against
 * pre-fix HEAD — that code had no such column, no claim UPDATE, and no
 * cooldown check, so it always fell straight through to computeGameTimelines.
 *
 * lib/pro/db.ts and lib/prostage/resolveGame.ts are both mocked — no
 * network/DB. `mockSql` is a single vi.fn() used as the tagged-template `sql`
 * function; each test queues its expected sequential DB responses with
 * `mockResolvedValueOnce`, matching the exact call order the route issues.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

vi.mock("@/lib/prostage/resolveGame", () => ({
  computeGameTimelines: vi.fn(),
}));

import { GET } from "@/app/api/prostage/timeline/route";
import { getSql } from "@/lib/pro/db";
import { computeGameTimelines } from "@/lib/prostage/resolveGame";
import { computeBackoffSeconds, CLAIM_LEASE_SEC } from "@/lib/prostage/timelineBackoff";

function req(gameId = "G1", player = "PlayerA") {
  return new NextRequest(
    `http://localhost/api/prostage/timeline?gameId=${encodeURIComponent(gameId)}&player=${encodeURIComponent(player)}`
  );
}

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(getSql).mockReturnValue(mockSql as never);
  vi.mocked(computeGameTimelines).mockReset();
});

describe("computeBackoffSeconds (pure)", () => {
  it("doubles each attempt, floored at the 60s base", () => {
    expect(computeBackoffSeconds(1)).toBe(60);
    expect(computeBackoffSeconds(2)).toBe(120);
    expect(computeBackoffSeconds(3)).toBe(240);
    expect(computeBackoffSeconds(4)).toBe(480);
  });

  it("caps at 3600s (1h) rather than growing unbounded", () => {
    expect(computeBackoffSeconds(10)).toBe(3600);
    expect(computeBackoffSeconds(30)).toBe(3600);
  });

  it("treats a non-positive attempt count as attempt 1", () => {
    expect(computeBackoffSeconds(0)).toBe(60);
    expect(computeBackoffSeconds(-5)).toBe(60);
  });
});

describe("GET /api/prostage/timeline — existing contract (unchanged by the fix)", () => {
  it("400 on missing params", async () => {
    const res = await GET(new NextRequest("http://localhost/api/prostage/timeline"));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("400 on overly long params", async () => {
    const res = await GET(req("G1", "x".repeat(400)));
    expect(res.status).toBe(400);
  });

  it("503 when DB is unavailable", async () => {
    vi.mocked(getSql).mockReturnValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it("400 when the player isn't in this game", async () => {
    mockSql.mockResolvedValueOnce([]); // requested-row SELECT
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it("status 'ok' serves straight from the DB, no compute", async () => {
    mockSql.mockResolvedValueOnce([
      { purchase_order: [{ itemId: 1054, ts: 65 }], timeline_status: "ok", timeline_next_attempt_at: null },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", purchaseOrder: [{ itemId: 1054, ts: 65 }] });
    expect(computeGameTimelines).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("status 'unavailable' serves straight from the DB, no compute", async () => {
    mockSql.mockResolvedValueOnce([
      { purchase_order: null, timeline_status: "unavailable", timeline_next_attempt_at: null },
    ]);
    const res = await GET(req());
    const body = await res.json();
    expect(body.status).toBe("unavailable");
    expect(computeGameTimelines).not.toHaveBeenCalled();
  });
});

describe("GET /api/prostage/timeline — cooldown / in-flight claim / backoff (FAILS against pre-fix HEAD)", () => {
  it("a NULL-status row whose timeline_next_attempt_at is in the future bounces 429 WITHOUT touching the network", async () => {
    const future = new Date(Date.now() + 30_000).toISOString();
    mockSql.mockResolvedValueOnce([
      { purchase_order: null, timeline_status: null, timeline_next_attempt_at: future },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(computeGameTimelines).not.toHaveBeenCalled();
    // Only the one read-only SELECT — no claim UPDATE was even attempted.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("losing the atomic claim race (0 rows returned) bounces 429 WITHOUT computing", async () => {
    mockSql
      .mockResolvedValueOnce([{ purchase_order: null, timeline_status: null, timeline_next_attempt_at: null }]) // step 1 select
      .mockResolvedValueOnce([]); // step 2 claim UPDATE ... RETURNING -> lost the race
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(CLAIM_LEASE_SEC));
    expect(computeGameTimelines).not.toHaveBeenCalled();
  });

  it("a winning claim proceeds to compute, and a transient result sets exponential backoff (attempt 1)", async () => {
    mockSql
      .mockResolvedValueOnce([{ purchase_order: null, timeline_status: null, timeline_next_attempt_at: null }])
      .mockResolvedValueOnce([
        {
          player_link: "PlayerA",
          team: "T1",
          champion_id: 1,
          game_datetime: "2026-07-20T00:00:00.000Z",
          overview_page: "LEC/2026 Season/Split 3",
          timeline_attempt_count: 0,
        },
      ])
      .mockResolvedValueOnce([]); // backoff UPDATE
    vi.mocked(computeGameTimelines).mockResolvedValueOnce({ status: "transient", reason: "feed 503" });

    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBe("60"); // computeBackoffSeconds(1)

    // The backoff UPDATE (3rd sql call) must carry backoffSec=60 and the
    // bumped attemptCount=1 as its interpolated values, and must NEVER set
    // timeline_status — a transient result stays NULL (taint discipline).
    const backoffCall = mockSql.mock.calls[2];
    expect(backoffCall[0].join("")).not.toContain("timeline_status =");
    expect(backoffCall.slice(1)).toEqual([60, 1, "G1"]);
  });

  it("a repeated transient failure compounds the backoff from the persisted attempt count", async () => {
    mockSql
      .mockResolvedValueOnce([{ purchase_order: null, timeline_status: null, timeline_next_attempt_at: null }])
      .mockResolvedValueOnce([
        {
          player_link: "PlayerA",
          team: "T1",
          champion_id: 1,
          game_datetime: "2026-07-20T00:00:00.000Z",
          overview_page: "LEC/2026 Season/Split 3",
          timeline_attempt_count: 3, // 3 prior transient failures already recorded
        },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(computeGameTimelines).mockResolvedValueOnce({ status: "transient", reason: "feed 503 again" });

    const res = await GET(req());
    expect(res.headers.get("Retry-After")).toBe("480"); // computeBackoffSeconds(4)
    const backoffCall = mockSql.mock.calls[2];
    expect(backoffCall.slice(1)).toEqual([480, 4, "G1"]);
  });

  it("an 'unavailable' result clears the backoff columns alongside the terminal status", async () => {
    mockSql
      .mockResolvedValueOnce([{ purchase_order: null, timeline_status: null, timeline_next_attempt_at: null }])
      .mockResolvedValueOnce([
        {
          player_link: "PlayerA",
          team: "T1",
          champion_id: 1,
          game_datetime: "2026-07-20T00:00:00.000Z",
          overview_page: "LEC/2026 Season/Split 3",
          timeline_attempt_count: 2,
        },
      ])
      .mockResolvedValueOnce([]); // terminal UPDATE
    vi.mocked(computeGameTimelines).mockResolvedValueOnce({ status: "unavailable", reason: "no such game" });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("unavailable");

    const terminalCall = mockSql.mock.calls[2];
    expect(terminalCall[0].join("")).toContain("timeline_status = 'unavailable'");
    expect(terminalCall[0].join("")).toContain("timeline_next_attempt_at = NULL");
    expect(terminalCall[0].join("")).toContain("timeline_attempt_count = 0");
  });

  it("an 'ok' result persists every claimed row and clears the backoff columns", async () => {
    mockSql
      .mockResolvedValueOnce([{ purchase_order: null, timeline_status: null, timeline_next_attempt_at: null }])
      .mockResolvedValueOnce([
        {
          player_link: "PlayerA",
          team: "T1",
          champion_id: 1,
          game_datetime: "2026-07-20T00:00:00.000Z",
          overview_page: "LEC/2026 Season/Split 3",
          timeline_attempt_count: 1,
        },
        {
          player_link: "PlayerB",
          team: "T2",
          champion_id: 2,
          game_datetime: "2026-07-20T00:00:00.000Z",
          overview_page: "LEC/2026 Season/Split 3",
          timeline_attempt_count: 1,
        },
      ])
      .mockResolvedValueOnce([]) // persist PlayerA
      .mockResolvedValueOnce([]); // persist PlayerB
    vi.mocked(computeGameTimelines).mockResolvedValueOnce({
      status: "ok",
      lolesportsGameId: "esports123",
      byPlayer: new Map([
        ["PlayerA", [{ itemId: 1054, ts: 65 }]],
        ["PlayerB", []],
      ]),
    });

    const res = await GET(req("G1", "PlayerA"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", purchaseOrder: [{ itemId: 1054, ts: 65 }] });
    // 1 select + 1 claim + 2 persists = 4 total.
    expect(mockSql).toHaveBeenCalledTimes(4);
    const persistA = mockSql.mock.calls[2][0].join("");
    expect(persistA).toContain("timeline_next_attempt_at = NULL");
    expect(persistA).toContain("timeline_attempt_count = 0");
  });
});
