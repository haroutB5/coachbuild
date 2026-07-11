/**
 * Cache-Control contract for GET /api/pros (2026-07-11 prostage incident):
 * an EMPTY result must never be CDN-cached — when a degraded upstream (or a
 * poisoned fetch data cache, see lib/pro/db.ts) yields [], the old
 * s-maxage=1800 pinned "No games" on users for 30-60 min per URL. Only
 * non-empty responses earn the long s-maxage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.fn();

vi.mock("@/lib/pro/db", () => ({
  getSql: vi.fn(() => mockSql),
}));

import { GET } from "@/app/api/pros/route";
import { getSql } from "@/lib/pro/db";

const req = (qs: string) =>
  ({ url: `http://localhost/api/pros${qs}` }) as unknown as Parameters<typeof GET>[0];

const PROSTAGE_ROW = {
  game_id: "MSI_2026_R4_1_3",
  player_link: "Zeka (Kim Geon-woo)",
  team: "Hanwha Life Esports",
  champion_id: 112,
  champion_name: "Viktor",
  role: 2,
  win: true,
  kills: 4,
  deaths: 0,
  assists: 5,
  game_datetime: "2026-07-09T09:45:00.000Z",
  patch: null,
  spells: [12, 4],
  final_items: [6653],
  trinket: 2055,
  runes: { primaryTree: 8100, keystone: 8112, primary: [], secondaryTree: 8200, secondary: [], shards: [] },
  tournament_display: "2026 Mid-Season Invitational",
  pro_name: null,
  pro_team: null,
  pro_role: null,
  pro_country: null,
};

describe("GET /api/pros Cache-Control policy", () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getSql).mockReturnValue(mockSql as never);
  });

  it("non-empty result gets the long s-maxage", async () => {
    // First sql call = prostage rows; second = comps batch (empty is fine).
    mockSql.mockResolvedValueOnce([PROSTAGE_ROW]).mockResolvedValueOnce([]);
    const res = await GET(req("?championId=112&role=5&source=prostage"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.games).toHaveLength(1);
    expect(res.headers.get("Cache-Control")).toBe("s-maxage=1800, stale-while-revalidate=3600");
  });

  it("empty result is no-store (never pinned by the CDN)", async () => {
    mockSql.mockResolvedValue([]);
    const res = await GET(req("?championId=112&role=5&source=prostage"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.games).toHaveLength(0);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("degraded non-array driver result is coerced to [] AND stays uncached", async () => {
    // asRows() coerces a non-array to [] — that degraded shape must fall in
    // the no-store bucket too, not get cached as a "real" empty.
    mockSql.mockResolvedValue(undefined);
    const res = await GET(req("?championId=112&role=5&source=prostage"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.games).toHaveLength(0);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
