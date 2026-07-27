/**
 * Pure-logic tests for skillOrder.ts — the "recommended skill order" card's
 * display helpers (components/hextech/SkillOrderCard.tsx). No JSX, no
 * network for the format helpers; `fetchSkillOrder` is tested against a
 * stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ABILITY_ROWS,
  LOW_SAMPLE_THRESHOLD,
  fetchSkillOrder,
  formatPriorityString,
  formatSkillOrderSampleLine,
  sortedLevels,
  type SkillOrderModel,
} from "../hextech/skillOrder";

function formatPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const BASE_MODEL: SkillOrderModel = {
  priority: ["Q", "W", "E"],
  levels: {
    Q: [2, 4, 5, 7, 9],
    W: [1, 8, 10, 12, 13],
    E: [3, 14, 15, 17, 18],
    R: [6, 11, 16],
  },
  order: ["W", "Q", "E", "Q", "W", "R", "Q", "W", "E", "Q", "R", "W", "W", "E", "E", "Q", "R", "E"],
  completed: true,
  sampleSize: 812,
  winRate: 0.54,
  share: 0.61,
};

describe("ABILITY_ROWS", () => {
  it("is Q/W/E/R in that order — R last, distinctly marked in the UI", () => {
    expect(ABILITY_ROWS).toEqual(["Q", "W", "E", "R"]);
  });
});

describe("formatPriorityString", () => {
  it("joins the max-order priority with the compact separator", () => {
    expect(formatPriorityString(["Q", "W", "E"])).toBe("Q › W › E");
  });

  it("handles a different priority order", () => {
    expect(formatPriorityString(["E", "Q", "W"])).toBe("E › Q › W");
  });
});

describe("sortedLevels", () => {
  it("sorts ascending without mutating the input", () => {
    const input = [9, 2, 5];
    const sorted = sortedLevels(input);
    expect(sorted).toEqual([2, 5, 9]);
    expect(input).toEqual([9, 2, 5]); // original untouched
  });

  it("handles an empty array", () => {
    expect(sortedLevels([])).toEqual([]);
  });
});

describe("formatSkillOrderSampleLine", () => {
  it("includes games, win rate, and pick rate when all are supplied", () => {
    const line = formatSkillOrderSampleLine(BASE_MODEL, formatPct);
    expect(line).toBe("812 games · 54% win rate · 61% pick rate");
  });

  it("singularizes a sampleSize of exactly 1", () => {
    const line = formatSkillOrderSampleLine({ sampleSize: 1, winRate: null, share: null }, formatPct);
    expect(line).toBe("1 game");
  });

  it("omits win rate when null — never fabricates a 0%", () => {
    const line = formatSkillOrderSampleLine({ sampleSize: 40, winRate: null, share: 0.3 }, formatPct);
    expect(line).toBe("40 games · 30% pick rate");
  });

  it("omits pick rate when null", () => {
    const line = formatSkillOrderSampleLine({ sampleSize: 40, winRate: 0.5, share: null }, formatPct);
    expect(line).toBe("40 games · 50% win rate");
  });

  it("shows only the games count when both are null", () => {
    const line = formatSkillOrderSampleLine({ sampleSize: 12, winRate: null, share: null }, formatPct);
    expect(line).toBe("12 games");
  });
});

describe("LOW_SAMPLE_THRESHOLD", () => {
  it("matches ProConsensusCard's own threshold value", () => {
    expect(LOW_SAMPLE_THRESHOLD).toBe(3);
  });
});

describe("fetchSkillOrder", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns ok with the parsed model on a 200 with real data", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(BASE_MODEL),
    }) as unknown as typeof fetch;

    const result = await fetchSkillOrder(103, 2);
    expect(result).toEqual({ status: "ok", model: BASE_MODEL });
    expect(global.fetch).toHaveBeenCalledWith("/api/skill-order?champ=103&role=2");
  });

  it("returns hidden on a 200 with a null payload — 'absent, not empty'", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(null),
    }) as unknown as typeof fetch;

    const result = await fetchSkillOrder(103, 2);
    expect(result).toEqual({ status: "hidden" });
  });

  it("returns error on a non-ok response, carrying the status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve(null),
    }) as unknown as typeof fetch;

    const result = await fetchSkillOrder(103, 2);
    expect(result).toEqual({ status: "error", reason: "HTTP 500" });
  });

  it("returns error on a network failure without throwing", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch")) as unknown as typeof fetch;

    const result = await fetchSkillOrder(103, 2);
    expect(result).toEqual({ status: "error", reason: "Failed to fetch" });
  });

  it("treats a malformed/unexpected shape as an error, never as a trusted model", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ priority: ["Q", "W", "E"] /* missing levels/order/completed/sampleSize */ }),
    }) as unknown as typeof fetch;

    const result = await fetchSkillOrder(103, 2);
    expect(result).toEqual({ status: "error", reason: "Unexpected response shape" });
  });
});
