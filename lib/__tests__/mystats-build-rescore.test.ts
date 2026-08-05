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

import {
  BUILD_ADHERENCE_RESCORE_LIMIT,
  rescoreCurrentPatchBuildAdherence,
} from "@/lib/mystats/ingest";

const sql = vi.fn();
const account = { puuid: "account-puuid" };

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

const topRecommendation = [
  {
    items: { first: { id: 3078 }, second: { id: 3072 }, third: { id: 3053 } },
    runes: { keystone: { id: 8005 } },
  },
];

describe("current-patch build adherence re-score", () => {
  beforeEach(() => {
    sql.mockReset();
    mockBuildRecommendations.mockReset();
    mockGetLatestPatch.mockReset();
    mockGetLatestPatch.mockResolvedValue({ major: 16, patch: 14, patchAdditions: 0, label: "16.14" });
    mockBuildRecommendations.mockResolvedValue(topRecommendation);
  });

  it("selects only current-patch NULL rows and writes a same-patch measurement", async () => {
    let candidateValues: unknown[] | null = null;
    let candidateText = "";
    let updateText = "";
    let updateValues: unknown[] | null = null;
    sql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sqlText(strings);
      if (text.includes("SELECT match_id, champion_id, role, patch, item_ids, primary_keystone")) {
        candidateText = text;
        candidateValues = values;
        return Promise.resolve([
          {
            match_id: "EUW1_1",
            champion_id: 112,
            role: 2,
            patch: "16.14",
            item_ids: [3078, 3072, 3053, 3006, 0, 0],
            primary_keystone: 8005,
          },
        ]);
      }
      if (text.includes("FROM coachbuild.my_build_recommendation_snapshots")) return Promise.resolve([]);
      if (text.includes("INSERT INTO coachbuild.my_build_recommendation_snapshots")) {
        return Promise.resolve([{ core_item_ids: [3078, 3072, 3053], keystone_id: 8005 }]);
      }
      if (text.includes("UPDATE coachbuild.my_matches")) {
        updateText = text;
        updateValues = values;
        return Promise.resolve([{ match_id: "EUW1_1" }]);
      }
      return Promise.resolve([]);
    });

    const result = await rescoreCurrentPatchBuildAdherence(
      sql as never,
      account as never,
      new Map(),
      "16.14",
      vi.fn()
    );

    expect(result).toEqual({ candidates: 1, scored: 1 });
    expect(candidateValues).toEqual(["account-puuid", "16.14", BUILD_ADHERENCE_RESCORE_LIMIT]);
    expect(candidateText).toContain("AND on_wpa_build IS NULL");
    expect(candidateText).toContain("AND role BETWEEN 0 AND 4");
    expect(candidateText).toContain("AND patch =");
    expect(updateValues).toEqual([true, "16.14", "account-puuid", "EUW1_1", "16.14"]);
    expect(updateText).toContain("AND on_wpa_build IS NULL");
    expect(updateText).toContain("AND patch =");
  });

  it("is idempotent: the query and update both retain the NULL guard, so a non-null boolean cannot be overwritten", async () => {
    let candidateText = "";
    sql.mockImplementation((strings: TemplateStringsArray) => {
      candidateText = sqlText(strings);
      return Promise.resolve([]);
    });

    const result = await rescoreCurrentPatchBuildAdherence(
      sql as never,
      account as never,
      new Map(),
      "16.14",
      vi.fn()
    );

    expect(result).toEqual({ candidates: 0, scored: 0 });
    expect(candidateText).toContain("AND on_wpa_build IS NULL");
    expect(sql.mock.calls.some(([strings]) =>
      sqlText(strings as TemplateStringsArray).includes("UPDATE coachbuild.my_matches")
    )).toBe(false);
  });
});
