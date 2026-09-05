import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("cold metadata requests", () => {
  it.each(["loadRuneMap", "loadItemsMap"] as const)("%s shares one download and parse across 20 callers", async (loader) => {
    vi.resetModules();
    const data = { "1": { Name: "fixture" } };
    const json = vi.fn(async () => data);
    const fetchMock = vi.fn(async () => ({ ok: true, json }));
    vi.stubGlobal("fetch", fetchMock);
    const staticData = await import("../staticData");
    const results = await Promise.all(Array.from({ length: 20 }, () => staticData[loader]()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
    results.forEach((result) => expect(result).toBe(data));
  });

  it("retries after a shared failure instead of retaining the rejected request", async () => {
    vi.resetModules();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { loadRuneMap } = await import("../staticData");
    const failures = await Promise.allSettled([loadRuneMap(), loadRuneMap()]);
    expect(failures.every((r) => r.status === "rejected")).toBe(true);
    await expect(loadRuneMap()).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
