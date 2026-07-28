/**
 * Tests for POST /api/otp/refresh — param validation and the ATOMIC claim
 * that stops two concurrent views of one champion both spending the shared
 * Riot budget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({ getSql: vi.fn(() => mockSql) }));
vi.mock("@/lib/otp/ingest", () => ({
  discoverOtpAccounts: vi.fn(),
  runOtpMatchIngest: vi.fn(),
}));

import { POST } from "@/app/api/otp/refresh/route";
import { getSql } from "@/lib/pro/db";
import { discoverOtpAccounts, runOtpMatchIngest } from "@/lib/otp/ingest";

const req = (qs: string) =>
  ({ url: `http://localhost/api/otp/refresh${qs}` }) as unknown as Parameters<typeof POST>[0];

beforeEach(() => {
  mockSql.mockReset();
  vi.mocked(getSql).mockReturnValue(mockSql as never);
  vi.mocked(discoverOtpAccounts).mockReset();
  vi.mocked(runOtpMatchIngest).mockReset();
  vi.mocked(discoverOtpAccounts).mockResolvedValue({
    championId: 112,
    candidatesSeen: 10,
    accountsUpserted: 8,
    errors: [],
  });
  vi.mocked(runOtpMatchIngest).mockResolvedValue({
    accountsProcessed: 1,
    matchesUpserted: 14,
    errors: [],
  });
  process.env.RIOT_API_KEY = "test-key";
});

describe("POST /api/otp/refresh", () => {
  it("400s on a missing or malformed championId", async () => {
    expect((await POST(req("?championKey=Viktor"))).status).toBe(400);
    expect((await POST(req("?championId=x&championKey=Viktor"))).status).toBe(400);
  });

  it("400s on a championKey that isn't a plain Riot key", async () => {
    // This value reaches an outbound URL path segment.
    expect((await POST(req("?championId=112&championKey=../../etc"))).status).toBe(400);
    expect((await POST(req("?championId=112"))).status).toBe(400);
  });

  it("accepts the real multi-word Riot keys", async () => {
    mockSql.mockResolvedValue([{ last_discovered_at: null }]);
    expect((await POST(req("?championId=62&championKey=MonkeyKing"))).status).toBe(200);
  });

  it("does no outbound work when the atomic claim returns no rows", async () => {
    // Zero rows = another caller holds the claim, or the cooldown hasn't
    // elapsed. Either way this request must spend nothing.
    mockSql.mockResolvedValue([]);
    const body = await (await POST(req("?championId=112&championKey=Viktor"))).json();
    expect(body).toEqual({ refreshed: false, reason: "cooldown" });
    expect(vi.mocked(discoverOtpAccounts)).not.toHaveBeenCalled();
    expect(vi.mocked(runOtpMatchIngest)).not.toHaveBeenCalled();
  });

  it("claims and ingests in ONE statement before any outbound call", async () => {
    mockSql.mockResolvedValue([{ last_discovered_at: null }]);
    await POST(req("?championId=112&championKey=Viktor"));
    // Exactly one SQL statement runs before the ingest — a read-then-write
    // pair would be two, and would reopen the double-spend race.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const stmt = String(mockSql.mock.calls[0][0].join(""));
    expect(stmt).toContain("ON CONFLICT");
    expect(stmt).toContain("RETURNING");
    expect(vi.mocked(runOtpMatchIngest)).toHaveBeenCalled();
  });

  it("runs discovery when the champion has never been discovered", async () => {
    mockSql.mockResolvedValue([{ last_discovered_at: null }]);
    const body = await (await POST(req("?championId=112&championKey=Viktor"))).json();
    expect(vi.mocked(discoverOtpAccounts)).toHaveBeenCalledWith(112, "Viktor");
    expect(body.accountsUpserted).toBe(8);
  });

  it("skips discovery when the roster was refreshed recently", async () => {
    mockSql.mockResolvedValue([{ last_discovered_at: new Date().toISOString() }]);
    const body = await (await POST(req("?championId=112&championKey=Viktor"))).json();
    expect(vi.mocked(discoverOtpAccounts)).not.toHaveBeenCalled();
    // Match ingest still runs — the roster is stable, their games are not.
    expect(vi.mocked(runOtpMatchIngest)).toHaveBeenCalled();
    expect(body.matchesUpserted).toBe(14);
  });

  it("re-runs discovery once the roster stamp is stale", async () => {
    const old = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    mockSql.mockResolvedValue([{ last_discovered_at: old }]);
    await POST(req("?championId=112&championKey=Viktor"));
    expect(vi.mocked(discoverOtpAccounts)).toHaveBeenCalled();
  });

  it("reports honestly instead of erroring when config is missing", async () => {
    vi.mocked(getSql).mockReturnValue(null as never);
    expect(await (await POST(req("?championId=112&championKey=Viktor"))).json()).toEqual({
      refreshed: false,
      reason: "no-db",
    });

    vi.mocked(getSql).mockReturnValue(mockSql as never);
    delete process.env.RIOT_API_KEY;
    expect(await (await POST(req("?championId=112&championKey=Viktor"))).json()).toEqual({
      refreshed: false,
      reason: "no-riot-key",
    });
  });
});
