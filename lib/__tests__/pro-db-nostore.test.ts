/**
 * lib/pro/db.ts must create the Neon client with fetchOptions.cache =
 * "no-store" (2026-07-11 prod incident): on Vercel the driver's POSTs to the
 * Neon HTTP endpoint went through Next.js's patched, Data-Cache-aware fetch,
 * which replayed a {rows:[]} response cached while prostage_matches was still
 * empty — for the exact (query bytes + params) key, across deployments. This
 * test pins the opt-out so a future "cleanup" can't silently drop it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const neonMock = vi.fn((..._args: unknown[]) => vi.fn());

vi.mock("@neondatabase/serverless", () => ({
  neon: (...args: unknown[]) => neonMock(...args),
}));

describe("getSql neon client options", () => {
  const prevUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    neonMock.mockClear();
  });

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
  });

  it("passes fetchOptions cache no-store to neon()", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@example.neon.tech/db";
    const { getSql } = await import("@/lib/pro/db");
    const sql = getSql();
    expect(sql).not.toBeNull();
    expect(neonMock).toHaveBeenCalledTimes(1);
    expect(neonMock).toHaveBeenCalledWith("postgresql://user:pass@example.neon.tech/db", {
      fetchOptions: { cache: "no-store" },
    });
  });

  it("returns null without DATABASE_URL and never constructs a client", async () => {
    delete process.env.DATABASE_URL;
    const { getSql } = await import("@/lib/pro/db");
    expect(getSql()).toBeNull();
    expect(neonMock).not.toHaveBeenCalled();
  });
});
