/**
 * Tests for lib/prostage/tournaments.ts — resolution priority (override >
 * env seed > Tournaments lookup > empty-fallback) and the in-process cache.
 * cargoQueryWithRetry is mocked — no network/pacer involved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prostage/cargo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prostage/cargo")>();
  return { ...actual, cargoQueryWithRetry: vi.fn() };
});

import { cargoQueryWithRetry } from "../prostage/cargo";
import {
  orderByStaleness,
  resolveActiveTournaments,
  __resetTournamentCacheForTests,
} from "../prostage/tournaments";

describe("resolveActiveTournaments", () => {
  beforeEach(() => {
    __resetTournamentCacheForTests();
    vi.mocked(cargoQueryWithRetry).mockReset();
    delete process.env.PROSTAGE_TOURNAMENT_SEED;
  });

  it("seedOverride short-circuits — no Cargo call", async () => {
    const pages = await resolveActiveTournaments({ seedOverride: ["MSI 2026"] });
    expect(pages).toEqual(["MSI 2026"]);
    expect(cargoQueryWithRetry).not.toHaveBeenCalled();
  });

  it("PROSTAGE_TOURNAMENT_SEED env var short-circuits — no Cargo call", async () => {
    process.env.PROSTAGE_TOURNAMENT_SEED = "LEC 2026 Summer, LCK 2026 Summer";
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual(["LEC 2026 Summer", "LCK 2026 Summer"]);
    expect(cargoQueryWithRetry).not.toHaveBeenCalled();
  });

  it("queries Tournaments and returns resolved OverviewPages", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([
      { OverviewPage: "LEC 2026 Summer" },
      { OverviewPage: "LCK 2026 Summer" },
    ] as never);
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual(["LEC 2026 Summer", "LCK 2026 Summer"]);
    expect(cargoQueryWithRetry).toHaveBeenCalledTimes(1);
  });

  it("caps at 7 tournaments", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({ OverviewPage: `League ${i}` })) as never
    );
    const pages = await resolveActiveTournaments();
    expect(pages).toHaveLength(7);
  });

  it("falls back to [] (not a throw) when the Tournaments lookup errors", async () => {
    vi.mocked(cargoQueryWithRetry).mockRejectedValueOnce(new Error("ratelimited"));
    const log = vi.fn();
    const pages = await resolveActiveTournaments({ log });
    expect(pages).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("falls back to [] when the lookup returns 0 usable rows", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: undefined }] as never);
    const pages = await resolveActiveTournaments();
    expect(pages).toEqual([]);
  });

  it("caches a successful resolution — a second call within TTL makes no new Cargo call", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    const first = await resolveActiveTournaments();
    const second = await resolveActiveTournaments();
    expect(first).toEqual(second);
    expect(cargoQueryWithRetry).toHaveBeenCalledTimes(1);
  });

  it("threads fastFailOnRatelimit through to cargoQueryWithRetry's retry options", async () => {
    vi.mocked(cargoQueryWithRetry).mockResolvedValueOnce([{ OverviewPage: "MSI 2026" }] as never);
    await resolveActiveTournaments({ fastFailOnRatelimit: true });
    const [, retryOpts] = vi.mocked(cargoQueryWithRetry).mock.calls[0];
    expect(retryOpts).toEqual({ fastFail: true });
  });
});

describe("orderByStaleness", () => {
  it("returns [] immediately for an empty input, without querying", async () => {
    const sql = vi.fn();
    const result = await orderByStaleness(sql as never, []);
    expect(result).toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });

  it("orders stalest-first — never-ingested (epoch) pages float to the front", async () => {
    // Fixes P1-1: a cursorless cron always calls with cursor=0, so whichever
    // tournament sorts first here is the ONLY one that cron will ever touch
    // without this ordering (see the doc comment on orderByStaleness).
    // orderByStaleness trusts the query's own `ORDER BY last_ingested ASC`
    // and just maps rows through — so the mock returns them PRE-SORTED, the
    // same shape Postgres would (this is testing the mapping, not re-testing
    // Postgres's own ORDER BY).
    const sql = vi.fn().mockResolvedValue([
      { overview_page: "Never Ingested", last_ingested: "1970-01-01T00:00:00.000Z" },
      { overview_page: "Ingested Yesterday", last_ingested: "2026-07-08T00:00:00.000Z" },
      { overview_page: "Ingested Today", last_ingested: "2026-07-09T00:00:00.000Z" },
    ]);
    const result = await orderByStaleness(sql as never, [
      "Ingested Today",
      "Never Ingested",
      "Ingested Yesterday",
    ]);
    expect(result).toEqual(["Never Ingested", "Ingested Yesterday", "Ingested Today"]);
  });

  it("queries with the given page list (unnest-driven staleness lookup)", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    await orderByStaleness(sql as never, ["A", "B"]);
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
