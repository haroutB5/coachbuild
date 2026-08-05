import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildRecommendations = vi.fn();
const mockGetLatestPatch = vi.fn();
vi.mock("@/lib/recommend", () => {
  class NotPlayedInRoleError extends Error {}
  return {
    buildRecommendations: (...args: unknown[]) => mockBuildRecommendations(...args),
    NotPlayedInRoleError,
  };
});
vi.mock("@/lib/staticData", () => ({
  getLatestPatch: (...args: unknown[]) => mockGetLatestPatch(...args),
}));

import { resolveRecommendedBuild } from "@/lib/mystats/ingest";

const sql = vi.fn();

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

describe("per-patch build recommendation snapshots", () => {
  beforeEach(() => {
    sql.mockReset();
    mockBuildRecommendations.mockReset();
    mockGetLatestPatch.mockReset();
    mockGetLatestPatch.mockResolvedValue({ major: 16, patch: 15, patchAdditions: 0, label: "16.15" });
  });

  it("looks up a snapshot using the game patch, even when the live pointer has moved", async () => {
    sql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (sqlText(strings).includes("FROM coachbuild.my_build_recommendation_snapshots")) {
        expect(values).toEqual(["16.15", 112, 2]);
        return Promise.resolve([{ core_item_ids: [3078, 3072, 3053], keystone_id: 8005 }]);
      }
      return Promise.resolve([]);
    });

    const result = await resolveRecommendedBuild(sql as never, new Map(), "16.16", 112, 2, "16.15", vi.fn());

    expect(result).toEqual({ coreItemIds: [3078, 3072, 3053], keystoneId: 8005 });
    expect(mockBuildRecommendations).not.toHaveBeenCalled();
  });

  it("captures the current-patch recommendation once and uses that patch as its snapshot key", async () => {
    sql.mockImplementation((strings: TemplateStringsArray) => {
      if (sqlText(strings).includes("INSERT INTO coachbuild.my_build_recommendation_snapshots")) {
        return Promise.resolve([{ core_item_ids: [3078, 3072, 3053], keystone_id: 8005 }]);
      }
      return Promise.resolve([]);
    });
    mockBuildRecommendations.mockResolvedValue([
      {
        items: { first: { id: 3078 }, second: { id: 3072 }, third: { id: 3053 } },
        runes: { keystone: { id: 8005 } },
      },
    ]);

    const result = await resolveRecommendedBuild(sql as never, new Map(), "16.15", 112, 2, "16.15", vi.fn());

    expect(result).toEqual({ coreItemIds: [3078, 3072, 3053], keystoneId: 8005 });
    const insert = sql.mock.calls.find(([strings]) =>
      sqlText(strings as TemplateStringsArray).includes("INSERT INTO coachbuild.my_build_recommendation_snapshots")
    );
    expect(insert?.slice(1)).toEqual(["16.15", 112, 2, 8005, [3078, 3072, 3053]]);
  });

  it("does not create a current-build comparison for an unsnapshotted game from another patch", async () => {
    sql.mockResolvedValue([]);

    const result = await resolveRecommendedBuild(sql as never, new Map(), "16.16", 112, 2, "16.15", vi.fn());

    expect(result).toBeNull();
    expect(mockBuildRecommendations).not.toHaveBeenCalled();
    expect(sql.mock.calls.some(([strings]) => sqlText(strings as TemplateStringsArray).includes("INSERT INTO"))).toBe(false);
  });

  it("does not capture a signature when the populated patch moves during the live lookup", async () => {
    sql.mockResolvedValue([]);
    mockBuildRecommendations.mockResolvedValue([
      {
        items: { first: { id: 3078 }, second: { id: 3072 }, third: { id: 3053 } },
        runes: { keystone: { id: 8005 } },
      },
    ]);
    mockGetLatestPatch.mockResolvedValue({ major: 16, patch: 16, patchAdditions: 0, label: "16.16" });

    const log = vi.fn();
    const result = await resolveRecommendedBuild(sql as never, new Map(), "16.15", 112, 2, "16.15", log);

    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("snapshot skipped"));
    expect(sql.mock.calls.some(([strings]) =>
      sqlText(strings as TemplateStringsArray).includes("INSERT INTO coachbuild.my_build_recommendation_snapshots")
    )).toBe(false);
  });
});
