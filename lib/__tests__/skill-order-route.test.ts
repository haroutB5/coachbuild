/**
 * Route wiring + CROSS-HALF INTEGRATION for GET /api/skill-order.
 *
 * The second describe block is the important one. This feature was split
 * engy(backend: lib/ + app/api/) / fronty(frontend: components/hextech/), and
 * fronty necessarily built against a hand-written copy of the contract because
 * the route didn't exist yet. Two independently-correct halves that disagree
 * on a field name or a null-vs-undefined would pass BOTH test suites and still
 * render nothing — so these tests feed this route's REAL serialized body into
 * fronty's REAL fetch/guard code and assert it comes out as `{status:"ok"}`.
 *
 * Upstream network + champion metadata are mocked; nothing here calls op.gg.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// NOTE: this factory replaces the WHOLE module, so every staticData export the
// route calls must be listed here or it arrives as `undefined` and the route's
// catch-all turns a TypeError into a silent `null` body. `resolveChampionKit`
// was added when per-champion rank caps landed (see lib/championKit.ts).
vi.mock("@/lib/staticData", () => ({
  getChampionById: vi.fn(),
  resolveChampionKit: vi.fn(),
}));
vi.mock("@/lib/opgg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/opgg")>();
  return { ...actual, fetchSkillOrder: vi.fn() };
});

import { GET } from "@/app/api/skill-order/route";
import { getChampionById, resolveChampionKit } from "@/lib/staticData";
import { STANDARD_KIT } from "@/lib/championKit";
import { fetchSkillOrder, CACHE_TTL_SECONDS } from "@/lib/opgg";
import { buildSkillOrderModel } from "@/lib/skillOrderModel";
import type { Ability, SkillOrderModel } from "@/lib/types";
// fronty's half — imported, never edited.
import { fetchSkillOrder as fetchSkillOrderClient } from "@/components/hextech/skillOrder";

const req = (qs: string) =>
  ({ url: `http://localhost/api/skill-order${qs}` }) as unknown as Parameters<typeof GET>[0];

const AHRI_15 = "WQEQQRQWQWRWWEE".split("") as Ability[];

const AHRI_MODEL = buildSkillOrderModel({
  order: AHRI_15,
  priorityIds: ["Q", "W", "E"],
  play: 71667,
  win: 41408,
  pickRate: 0.57,
})!;

beforeEach(() => {
  vi.mocked(getChampionById).mockReset();
  vi.mocked(fetchSkillOrder).mockReset();
  vi.mocked(resolveChampionKit).mockReset();
  vi.mocked(resolveChampionKit).mockResolvedValue(STANDARD_KIT);
  vi.mocked(getChampionById).mockResolvedValue({
    id: 103,
    key: "Ahri",
    name: "Ahri",
    icon: "https://example.invalid/ahri.webp",
  } as never);
  vi.mocked(fetchSkillOrder).mockResolvedValue(AHRI_MODEL);
});

describe("GET /api/skill-order — param validation", () => {
  it("400 when champ or role is missing", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?champ=103"))).status).toBe(400);
    expect((await GET(req("?role=2"))).status).toBe(400);
  });

  it("400 on non-integer params (mirrors /api/build)", async () => {
    for (const qs of ["?champ=ahri&role=2", "?champ=103&role=mid", "?champ=86.5&role=2", "?champ=2x&role=2"]) {
      expect((await GET(req(qs))).status, qs).toBe(400);
    }
  });

  it("400 on an out-of-range role", async () => {
    expect((await GET(req("?champ=103&role=6"))).status).toBe(400);
    expect((await GET(req("?champ=103&role=99"))).status).toBe(400);
  });

  it("does NOT 400 on a data-availability outcome — that is a 200 with null", async () => {
    vi.mocked(fetchSkillOrder).mockResolvedValue(null);
    const res = await GET(req("?champ=103&role=5"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});

describe("GET /api/skill-order — payload + cache policy", () => {
  it("200 with the model served BARE (no wrapper), like /api/build", async () => {
    const res = await GET(req("?champ=103&role=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Not { data: ... } — the body IS the payload.
    expect(body.order).toHaveLength(18);
    expect(body.sampleSize).toBe(71667);
    expect(body.completed).toBe(true);
  });

  it("passes the champion's Riot KEY (not its id) and the role through", async () => {
    await GET(req("?champ=103&role=2"));
    // The 3rd arg is the injectable transport (left default); the 4th is the
    // champion's resolved rank rules. Asserting all four keeps this test's
    // original point (key-not-id, plus the role) while also pinning that the
    // kit is actually forwarded rather than resolved and dropped.
    expect(vi.mocked(fetchSkillOrder)).toHaveBeenCalledWith("Ahri", 2, undefined, STANDARD_KIT);
  });

  it("resolves the kit for the requested champion, by id AND key", async () => {
    await GET(req("?champ=103&role=2"));
    expect(vi.mocked(resolveChampionKit)).toHaveBeenCalledWith(103, "Ahri");
  });

  it("forwards a null kit (known non-standard, unresolved) instead of substituting a standard one", async () => {
    // The whole point of the null: the route must not paper over it, because
    // downstream `unknown-kit` is what stops a Jayce player getting 5/5/5/3
    // advice. See lib/staticData.ts's resolveChampionKit.
    vi.mocked(resolveChampionKit).mockResolvedValue(null);
    await GET(req("?champ=126&role=0"));
    expect(vi.mocked(fetchSkillOrder)).toHaveBeenCalledWith("Ahri", 0, undefined, null);
  });

  it("a real payload earns a long s-maxage", async () => {
    const res = await GET(req("?champ=103&role=2"));
    expect(res.headers.get("Cache-Control")).toBe(
      `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`
    );
  });

  it("NEVER CDN-caches an empty response (repo gotcha (b))", async () => {
    vi.mocked(fetchSkillOrder).mockResolvedValue(null);
    const res = await GET(req("?champ=103&role=2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("200-nulls an unknown champion instead of erroring", async () => {
    vi.mocked(getChampionById).mockResolvedValue(null);
    const res = await GET(req("?champ=99999&role=2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(vi.mocked(fetchSkillOrder)).not.toHaveBeenCalled();
  });

  it("degrades to 200-null when the champion lookup THROWS", async () => {
    vi.mocked(getChampionById).mockRejectedValue(new Error("ddragon down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req("?champ=103&role=2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    spy.mockRestore();
  });

  it("serialises winRate/share as explicit null — never a dropped key", async () => {
    // undefined would vanish through JSON.stringify, and the client's
    // `winRate !== null` check would then format `undefined` as a percent.
    vi.mocked(fetchSkillOrder).mockResolvedValue({
      ...AHRI_MODEL,
      winRate: null,
      share: null,
    });
    const raw = await (await GET(req("?champ=103&role=2"))).text();
    expect(raw).toContain('"winRate":null');
    expect(raw).toContain('"share":null');
    const body = JSON.parse(raw);
    expect("winRate" in body).toBe(true);
    expect("share" in body).toBe(true);
  });
});

describe("CROSS-HALF INTEGRATION — this route's body vs fronty's real guard", () => {
  const originalFetch = globalThis.fetch;

  /** Wire fronty's client fetch to this route's ACTUAL Response. */
  const wireClientToRoute = (qs: string) => {
    globalThis.fetch = (async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      expect(path.startsWith("/api/skill-order")).toBe(true);
      return GET(req(path.replace("/api/skill-order", "")) );
    }) as unknown as typeof fetch;
    return qs;
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a real model passes fronty's isSkillOrderModel guard → status 'ok'", async () => {
    wireClientToRoute("");
    const result = await fetchSkillOrderClient(103, 2);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("guard rejected the real payload");
    expect(result.model.order).toHaveLength(18);
    expect(result.model.priority).toEqual(["Q", "W", "E"]);
    expect(result.model.sampleSize).toBe(71667);
    expect(result.model.completed).toBe(true);
  });

  it("every field fronty's guard inspects survives JSON serialisation", async () => {
    const round: SkillOrderModel = JSON.parse(JSON.stringify(AHRI_MODEL));
    expect(Array.isArray(round.priority)).toBe(true);
    expect(typeof round.levels).toBe("object");
    expect(round.levels).not.toBeNull();
    expect(Array.isArray(round.order)).toBe(true);
    expect(typeof round.completed).toBe("boolean");
    expect(typeof round.sampleSize).toBe("number");
    // levels is a Record keyed by ability — object, not array, after a round trip.
    expect(Object.keys(round.levels).sort()).toEqual(["E", "Q", "R", "W"]);
  });

  it("null payload → fronty renders NO card ('hidden'), not an error", async () => {
    vi.mocked(fetchSkillOrder).mockResolvedValue(null);
    wireClientToRoute("");
    const result = await fetchSkillOrderClient(103, 2);
    expect(result.status).toBe("hidden");
  });

  it("a refused (15-level) model still passes the guard and claims nothing past 15", async () => {
    const udyr = buildSkillOrderModel({
      order: "QRWEQQQEQEQEEEW".split("") as Ability[],
      priorityIds: ["Q", "E", "W", "R"],
      play: 8815,
      win: 5418,
      pickRate: 0.3,
    })!;
    vi.mocked(fetchSkillOrder).mockResolvedValue(udyr);
    wireClientToRoute("");
    const result = await fetchSkillOrderClient(77, 1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("guard rejected the refused model");
    expect(result.model.completed).toBe(false);
    expect(result.model.order).toHaveLength(15);
    expect(Math.max(...Object.values(result.model.levels).flat())).toBeLessThanOrEqual(15);
  });

  it("the two halves' field names have not drifted apart", async () => {
    // If either side renames a field, this fails loudly instead of rendering
    // an empty card in production.
    expect(Object.keys(AHRI_MODEL).sort()).toEqual(
      ["completed", "levels", "order", "priority", "sampleSize", "share", "winRate"]
    );
  });
});
