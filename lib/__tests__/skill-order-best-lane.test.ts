// ─────────────────────────────────────────────────────────────────────────────
// skill-order-best-lane.test.ts
//
// WHY THIS FILE EXISTS.
//
// /compact's skill panel sent `role=5` when the lane was unknown, carrying the
// comment "5 = let the API pick". The API never picked. `opggPosition(5)`
// returns null because op.gg rejects `all`/`none`, so `role=5` answers `null`
// for EVERY champion and the panel rendered silently empty for the whole
// unknown-lane case — which is most of champ select. Verified against
// production 2026-07-27: role=5 returned `null` for both Udyr and Ahri while
// role=1 and role=2 returned full 18-level orders.
//
// The bug survived because it LOOKED deliberate. A comment describing an
// intention nobody implemented is indistinguishable from working code until
// someone probes the endpoint. So these tests pin the behaviour, not the
// intention.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSkillOrderBestLane } from "@/components/hextech/skillOrder";

/** A minimal but SHAPE-VALID model — `isSkillOrderModel` guards the real one. */
function model(sampleSize: number, tag: string) {
  return {
    priority: ["Q", "W", "E"],
    levels: { Q: [1], W: [2], E: [3], R: [6] },
    order: ["Q", "W", "E", "Q", "Q", "R", "Q", "W", "Q", "W", "R", "W", "W", "E", "E", "R", "E", "E"],
    completed: true,
    sampleSize,
    winRate: 0.5,
    share: 0.1,
    // Carried through so a test can tell WHICH lane's model came back.
    priorityString: tag,
  };
}

/** Map role id → response body. `undefined` means a null body (op.gg had none). */
function mockByRole(byRole: Record<number, unknown>, opts: { failRoles?: number[] } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const role = Number(new URL(url, "https://x.test").searchParams.get("role"));
      if (opts.failRoles?.includes(role)) return { ok: false, status: 500 } as unknown as Response;
      return {
        ok: true,
        json: async () => (role in byRole ? byRole[role] : null),
      } as unknown as Response;
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchSkillOrderBestLane", () => {
  it("never asks for role=5 — the value that silently returned null for everything", async () => {
    mockByRole({ 2: model(100, "mid") });
    await fetchSkillOrderBestLane(77);
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(
      (c) => c[0]
    );
    expect(calls).toHaveLength(5);
    const roles = calls.map((u) => Number(new URL(u, "https://x.test").searchParams.get("role"))).sort();
    expect(roles).toEqual([0, 1, 2, 3, 4]);
    expect(roles).not.toContain(5);
  });

  it("picks the LARGEST sample, not the first lane that answers", async () => {
    // A champion played mostly bot but occasionally mid. A fixed lane priority
    // would return mid; only the sample size knows which is the real lane.
    mockByRole({ 2: model(120, "mid"), 3: model(7150, "bot") });
    const res = await fetchSkillOrderBestLane(77);
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.model.sampleSize).toBe(7150);
  });

  it("returns hidden — not an error — when no lane has data", async () => {
    // Every lane legitimately answers null. That is "no data", which the panel
    // renders as nothing; surfacing it as a transport error would be a lie.
    mockByRole({});
    const res = await fetchSkillOrderBestLane(77);
    expect(res.status).toBe("hidden");
  });

  it("still returns the good lane when other lanes fail outright", async () => {
    // A 500 on two lanes must not lose a perfectly good answer from a third.
    mockByRole({ 1: model(9670, "jungle") }, { failRoles: [0, 3] });
    const res = await fetchSkillOrderBestLane(77);
    expect(res.status).toBe("ok");
    expect(res.status === "ok" && res.model.sampleSize).toBe(9670);
  });

  it("surfaces an error only when NOTHING resolved and nothing was legitimately empty", async () => {
    mockByRole({}, { failRoles: [0, 1, 2, 3, 4] });
    const res = await fetchSkillOrderBestLane(77);
    expect(res.status).toBe("error");
  });

  it("prefers a legitimate empty over an error when both occurred", async () => {
    // Some lanes 500'd, others honestly had no data. "No data" is the more
    // useful and less alarming answer, and it is true.
    mockByRole({}, { failRoles: [0, 1] });
    const res = await fetchSkillOrderBestLane(77);
    expect(res.status).toBe("hidden");
  });

  it("is stable on a tie — the earlier lane wins, so repeat calls agree", async () => {
    mockByRole({ 1: model(500, "jungle"), 4: model(500, "support") });
    const a = await fetchSkillOrderBestLane(77);
    const b = await fetchSkillOrderBestLane(77);
    expect(a.status).toBe("ok");
    expect(a).toEqual(b);
  });
});
