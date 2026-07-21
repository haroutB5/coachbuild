import { describe, it, expect, vi } from "vitest";
import { buildDraftRecommendQuery, normalizeDraftRecommendResponse, fetchDraftRecommend } from "../live/draftRecommend";

describe("buildDraftRecommendQuery", () => {
  it("always includes lane", () => {
    expect(buildDraftRecommendQuery({ lane: 2, enemies: [], hover: null })).toBe("lane=2");
  });

  it("includes enemies as a csv when present", () => {
    const qs = buildDraftRecommendQuery({ lane: 2, enemies: [103, 64, 51], hover: null });
    expect(qs).toBe("lane=2&enemies=103%2C64%2C51");
    expect(decodeURIComponent(qs)).toBe("lane=2&enemies=103,64,51");
  });

  it("omits enemies entirely when the list is empty", () => {
    const qs = buildDraftRecommendQuery({ lane: 0, enemies: [], hover: 112 });
    expect(qs).not.toContain("enemies");
  });

  it("includes hover only when non-null", () => {
    expect(buildDraftRecommendQuery({ lane: 0, enemies: [], hover: 112 })).toContain("hover=112");
    expect(buildDraftRecommendQuery({ lane: 0, enemies: [], hover: null })).not.toContain("hover");
  });

  it("hover=0 is a valid champion id and must not be dropped (0 !== null)", () => {
    // championId 0 never actually occurs for a real champion, but the guard
    // is `!== null`, not truthiness — pin that explicitly so a future
    // refactor to `if (params.hover)` regresses loudly via this test.
    expect(buildDraftRecommendQuery({ lane: 0, enemies: [], hover: 0 })).toContain("hover=0");
  });

  it("includes laneOpp only when non-null/non-undefined", () => {
    expect(buildDraftRecommendQuery({ lane: 0, enemies: [64], hover: null, laneOpp: 64 })).toContain("laneOpp=64");
    expect(buildDraftRecommendQuery({ lane: 0, enemies: [64], hover: null, laneOpp: null })).not.toContain("laneOpp");
    expect(buildDraftRecommendQuery({ lane: 0, enemies: [64], hover: null })).not.toContain("laneOpp");
  });
});

describe("normalizeDraftRecommendResponse", () => {
  it("returns null for a non-object payload", () => {
    expect(normalizeDraftRecommendResponse(null)).toBeNull();
    expect(normalizeDraftRecommendResponse("<html>error</html>")).toBeNull();
  });

  it("parses a full, well-formed envelope", () => {
    const result = normalizeDraftRecommendResponse({
      plays: [{ champId: 103, score: 0.52, winVsLaneOpp: 0.54, winVsLaneOppGames: 5000, confidence: "normal", minGames: 400 }],
      potentialPlays: [{ champId: 200, score: 0.5, winVsLaneOpp: 0.48, winVsLaneOppGames: 500, confidence: "low", minGames: 500 }],
      bans: [{ champId: 64, score: 0.08, confidence: "low", minGames: 20 }],
      meta: { patch: "16.14", tier: 10, fetchedAt: "2026-07-20T00:00:00.000Z", laneOppInferred: 64, currentPatch: "16.14" },
    });
    expect(result).toEqual({
      plays: [{ champId: 103, score: 0.52, winVsLaneOpp: 0.54, winVsLaneOppGames: 5000, confidence: "normal", minGames: 400 }],
      potentialPlays: [{ champId: 200, score: 0.5, winVsLaneOpp: 0.48, winVsLaneOppGames: 500, confidence: "low", minGames: 500 }],
      bans: [{ champId: 64, score: 0.08, confidence: "low", minGames: 20 }],
      meta: { patch: "16.14", tier: 10, fetchedAt: "2026-07-20T00:00:00.000Z", laneOppInferred: 64, currentPatch: "16.14" },
      pending: false,
    });
  });

  it("v0.37.4: potentialPlays absent (older cached response / server hasn't shipped it) degrades to [], never crashes", () => {
    const result = normalizeDraftRecommendResponse({
      plays: [{ champId: 103, score: 0.52, winVsLaneOpp: null, confidence: "normal", minGames: 400 }],
      bans: null,
      meta: { patch: "16.14", tier: 10, fetchedAt: "2026-07-20T00:00:00.000Z" },
    });
    expect(result?.potentialPlays).toEqual([]);
    // absent winVsLaneOppGames on an individual play also degrades to null, same posture as the other optional numeric fields
    expect(result?.plays[0].winVsLaneOppGames).toBeNull();
  });

  it("v0.37.4: a malformed potentialPlays entry is dropped without dropping the rest of the list", () => {
    const result = normalizeDraftRecommendResponse({
      plays: [],
      potentialPlays: [
        { champId: 200, score: 0.5, confidence: "low", minGames: 500 },
        { score: 0.5 }, // missing champId
      ],
      meta: {},
    });
    expect(result?.potentialPlays).toHaveLength(1);
    expect(result?.potentialPlays[0].champId).toBe(200);
  });

  it("meta.laneOppInferred degrades to null when absent or non-numeric", () => {
    expect(normalizeDraftRecommendResponse({ meta: {} })?.meta.laneOppInferred).toBeNull();
    expect(normalizeDraftRecommendResponse({ meta: { laneOppInferred: "64" } })?.meta.laneOppInferred).toBeNull();
  });

  it("meta.currentPatch degrades to null when absent or non-string, parses through when present (Round-B)", () => {
    expect(normalizeDraftRecommendResponse({ meta: {} })?.meta.currentPatch).toBeNull();
    expect(normalizeDraftRecommendResponse({ meta: { currentPatch: 16.14 } })?.meta.currentPatch).toBeNull();
    expect(normalizeDraftRecommendResponse({ meta: { currentPatch: "16.15" } })?.meta.currentPatch).toBe("16.15");
  });

  it("bans:null (no hover sent) passes through as null, not an empty array", () => {
    const result = normalizeDraftRecommendResponse({
      plays: [],
      bans: null,
      meta: { patch: "16.14", tier: 10, fetchedAt: "2026-07-20T00:00:00.000Z" },
    });
    expect(result?.bans).toBeNull();
  });

  it("missing plays/bans/meta degrades to empty/null/blank rather than rejecting", () => {
    const result = normalizeDraftRecommendResponse({});
    expect(result).toEqual({
      plays: [],
      potentialPlays: [],
      bans: null,
      meta: { patch: "", tier: 0, fetchedAt: "", laneOppInferred: null, currentPatch: null },
      pending: false,
    });
  });

  it("drops a malformed individual play entry without dropping the rest of the list", () => {
    const result = normalizeDraftRecommendResponse({
      plays: [
        { champId: 103, score: 0.5, winVsLaneOpp: null, confidence: "normal", minGames: 300 },
        { champId: "not-a-number", score: 0.5 },
        { score: 0.5 }, // missing champId entirely
      ],
      meta: { patch: "16.14", tier: 10, fetchedAt: "now" },
    });
    expect(result?.plays).toHaveLength(1);
    expect(result?.plays[0].champId).toBe(103);
  });

  it("an unrecognized confidence string degrades to the CAUTIOUS 'low', never a false 'normal'", () => {
    const result = normalizeDraftRecommendResponse({
      plays: [{ champId: 103, score: 0.5, confidence: "surely-fine" }],
      meta: {},
    });
    expect(result?.plays[0].confidence).toBe("low");
  });

  it("passes through pending:true", () => {
    const result = normalizeDraftRecommendResponse({ pending: true, meta: { patch: "16.14", tier: 10, fetchedAt: "x" } });
    expect(result?.pending).toBe(true);
  });
});

describe("fetchDraftRecommend", () => {
  it("returns the normalized response on success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        plays: [{ champId: 103, score: 0.5, winVsLaneOpp: null, confidence: "normal", minGames: 300 }],
        bans: null,
        meta: { patch: "16.14", tier: 10, fetchedAt: "now" },
      }),
    })) as unknown as typeof fetch;
    const result = await fetchDraftRecommend({ lane: 2, enemies: [103], hover: null }, { fetchImpl });
    expect(result?.plays).toHaveLength(1);
  });

  it("returns null on a non-ok response (never throws)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(await fetchDraftRecommend({ lane: 2, enemies: [], hover: null }, { fetchImpl })).toBeNull();
  });

  it("returns null on a network error (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await fetchDraftRecommend({ lane: 2, enemies: [], hover: null }, { fetchImpl });
    expect(result).toBeNull();
  });

  it("hits the URL with lane/enemies/hover encoded correctly", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    await fetchDraftRecommend({ lane: 4, enemies: [412, 89], hover: 111 }, { fetchImpl });
    expect(calledUrl).toBe("/api/draft/recommend?lane=4&enemies=412%2C89&hover=111");
  });
});
