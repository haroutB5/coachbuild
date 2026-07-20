/**
 * Tests for components/live/companionClient.ts. The bridge itself is
 * fundamentally untestable off a real gaming PC (plan §5) — this exercises
 * the client's own logic against an injected `fetchImpl` (never a real
 * loopback server) plus localStorage persistence, using the exact
 * stub-window shim pattern components/__tests__/rankBracketStorage.test.ts
 * already established for this repo's node-env vitest run.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  COMPANION_PORTS,
  getStoredSession,
  setStoredSession,
  getStoredPort,
  setStoredPort,
  hasSession,
  getStatus,
  probeCompanion,
  refreshStatus,
  getLive,
  isLiveError,
  applyRunes,
  applyItemSets,
  getAutoItemSetsEnabled,
  setAutoItemSetsEnabled,
} from "../live/companionClient";

function makeLocalStorageShim() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
}

function stubWindow(localStorage: {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}): void {
  (globalThis as unknown as { window: { localStorage: typeof localStorage } }).window = { localStorage };
}

function unstubWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

const RUNE_BODY = {
  name: "CoachBuild Viktor Mid",
  primaryStyleId: 8200,
  subStyleId: 8100,
  selectedPerkIds: [8214, 8226, 8210, 8237, 8143, 8135, 5008, 5008, 5001],
  current: true as const,
};

describe("companionClient — persistence, SSR (no window)", () => {
  it("getStoredSession/getStoredPort return null, hasSession is false", () => {
    expect(typeof window).toBe("undefined");
    expect(getStoredSession()).toBeNull();
    expect(getStoredPort()).toBeNull();
    expect(hasSession()).toBe(false);
  });

  it("setStoredSession/setStoredPort never throw", () => {
    expect(() => setStoredSession("abc")).not.toThrow();
    expect(() => setStoredPort(48291)).not.toThrow();
  });
});

describe("companionClient — persistence, browser env (stubbed localStorage)", () => {
  afterEach(() => unstubWindow());

  it("round-trips a session", () => {
    stubWindow(makeLocalStorageShim());
    expect(hasSession()).toBe(false);
    setStoredSession("session-token-1");
    expect(getStoredSession()).toBe("session-token-1");
    expect(hasSession()).toBe(true);
  });

  it("round-trips a port from COMPANION_PORTS", () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48292);
    expect(getStoredPort()).toBe(48292);
  });

  it("getStoredPort ignores a stored value outside COMPANION_PORTS", () => {
    const shim = makeLocalStorageShim();
    shim.setItem("coachbuild:companion:port", "9999");
    stubWindow(shim);
    expect(getStoredPort()).toBeNull();
  });
});

describe("companionClient — probeCompanion (port walk + classification)", () => {
  afterEach(() => unstubWindow());

  it("returns 'connected' on the first port that answers, and persists that port", () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith(`http://127.0.0.1:${COMPANION_PORTS[1]}`)) {
        return {
          ok: true,
          json: async () => ({ version: "1.0.0", phase: "ChampSelect", clientConnected: true }),
        } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    return probeCompanion("sess", "passive", { fetchImpl }).then((state) => {
      expect(state).toEqual({
        kind: "connected",
        port: COMPANION_PORTS[1],
        status: {
          version: "1.0.0",
          port: COMPANION_PORTS[1],
          phase: "ChampSelect",
          clientConnected: true,
          lastOpen: null,
          champSelect: null,
          lastPollAt: null,
          lastError: null,
        },
      });
      expect(getStoredPort()).toBe(COMPANION_PORTS[1]);
    });
  });

  it("tries the previously-known-good port FIRST", async () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(COMPANION_PORTS[2]);
    const tried: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const port = parseInt(new URL(url).port, 10);
      tried.push(port);
      if (port === COMPANION_PORTS[2]) {
        return { ok: true, json: async () => ({ version: "1.0.0", phase: "Lobby", clientConnected: false }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await probeCompanion("sess", "passive", { fetchImpl });
    expect(tried[0]).toBe(COMPANION_PORTS[2]);
  });

  it("classifies an all-ports failure as no-companion on a passive trigger", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const state = await probeCompanion("sess", "passive", { fetchImpl });
    expect(state).toEqual({ kind: "no-companion" });
  });

  it("classifies an all-ports failure as lna-denied on a user-click trigger", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const state = await probeCompanion("sess", "user-click", { fetchImpl });
    expect(state).toEqual({ kind: "lna-denied" });
  });

  it("treats a non-ok response as a miss and keeps walking", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < COMPANION_PORTS.length) return { ok: false, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ version: "2.0.0", phase: "InProgress", clientConnected: true }) } as Response;
    });
    const state = await probeCompanion("sess", "passive", { fetchImpl });
    expect(state.kind).toBe("connected");
  });

  it("treats a malformed (missing-field) JSON body as a miss and keeps walking", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < COMPANION_PORTS.length) return { ok: true, json: async () => ({ version: "1.0.0" }) } as Response;
      return { ok: true, json: async () => ({ version: "1.0.0", phase: "InProgress", clientConnected: false }) } as Response;
    });
    const state = await probeCompanion("sess", "passive", { fetchImpl });
    expect(state.kind).toBe("connected");
  });
});

describe("companionClient — getStatus / refreshStatus", () => {
  afterEach(() => unstubWindow());

  it("getStatus returns null on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await getStatus(48291, "sess", { fetchImpl })).toBeNull();
  });

  it("refreshStatus reuses the stored port without a full walk when it still answers", async () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48293);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.0.0", phase: "InProgress", clientConnected: true }),
    })) as unknown as typeof fetch;
    const state = await refreshStatus("sess", { fetchImpl });
    expect(state).toEqual({
      kind: "connected",
      port: 48293,
      status: {
        version: "1.0.0",
        port: 48293,
        phase: "InProgress",
        clientConnected: true,
        lastOpen: null,
        champSelect: null,
        lastPollAt: null,
        lastError: null,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no 3-port walk needed
  });

  it("refreshStatus falls back to a full probe when the stored port stops answering", async () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48291);
    const fetchImpl = vi.fn(async (url: string) => {
      const port = parseInt(new URL(url).port, 10);
      if (port === 48292) {
        return { ok: true, json: async () => ({ version: "1.0.0", phase: "Lobby", clientConnected: false }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const state = await refreshStatus("sess", { fetchImpl });
    expect(state.kind).toBe("connected");
    if (state.kind === "connected") expect(state.port).toBe(48292);
  });

  it("refreshStatus is passive — never classifies as lna-denied", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const state = await refreshStatus("sess", { fetchImpl });
    expect(state).toEqual({ kind: "no-companion" });
  });

  it("parses a real lastOpen + champSelect snapshot from a v1.2.0 companion", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.2.0",
        phase: "ChampSelect",
        clientConnected: true,
        lastOpen: { championId: 103, roleId: 0, at: "2026-07-20T00:00:00.000Z" },
        champSelect: { localPlayerCellId: 0, cellChampionId: null, pickIntent: 103, actionChampionId: null, roleId: 0 },
      }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.lastOpen).toEqual({ championId: 103, roleId: 0, at: "2026-07-20T00:00:00.000Z" });
    expect(status?.champSelect).toEqual({ localPlayerCellId: 0, cellChampionId: null, pickIntent: 103, actionChampionId: null, roleId: 0 });
  });

  it("degrades lastOpen/champSelect to null from an older (pre-1.2.0) companion that never sends them", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.1.0", phase: "InProgress", clientConnected: true }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.lastOpen).toBeNull();
    expect(status?.champSelect).toBeNull();
  });

  it("degrades a malformed lastOpen/champSelect to null rather than rejecting the whole status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.2.0", phase: "InProgress", clientConnected: true, lastOpen: "not-an-object", champSelect: 42 }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.lastOpen).toBeNull();
    expect(status?.champSelect).toBeNull();
  });

  it("parses lastPollAt + lastError from a v1.2.2 companion", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.2.2",
        phase: "None",
        clientConnected: true,
        lastPollAt: "2026-07-20T00:00:05.000Z",
        lastError: "Invoke-LcuRaw failed: GET /lol-gameflow/v1/gameflow-phase -- WebException: The underlying connection was closed",
      }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.lastPollAt).toBe("2026-07-20T00:00:05.000Z");
    expect(status?.lastError).toContain("Invoke-LcuRaw failed");
  });

  it("degrades lastPollAt/lastError to null from an older (pre-1.2.1/1.2.2) companion that never sends them", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.2.0", phase: "InProgress", clientConnected: true }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.lastPollAt).toBeNull();
    expect(status?.lastError).toBeNull();
  });

  it("degrades a malformed (non-string) lastPollAt/lastError to null", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "1.2.2", phase: "None", clientConnected: false, lastPollAt: 12345, lastError: { oops: true } }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.lastPollAt).toBeNull();
    expect(status?.lastError).toBeNull();
  });
});

describe("companionClient — getLive / isLiveError", () => {
  it("returns the raw allgamedata payload on success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ allPlayers: [] }),
    })) as unknown as typeof fetch;
    const live = await getLive(48291, "sess", { fetchImpl });
    expect(live).toEqual({ allPlayers: [] });
    expect(live && isLiveError(live)).toBe(false);
  });

  it("passes through the {error:'no-live'} shape", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: "no-live" }),
    })) as unknown as typeof fetch;
    const live = await getLive(48291, "sess", { fetchImpl });
    expect(live && isLiveError(live)).toBe(true);
  });

  it("returns null (not a throw) on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await getLive(48291, "sess", { fetchImpl })).toBeNull();
  });
});

describe("companionClient — applyRunes", () => {
  it("returns {ok:true, selected, verified, mismatch} on a successful apply", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, selected: true, verified: true, mismatch: [] }),
    })) as unknown as typeof fetch;
    const result = await applyRunes(48291, "sess", RUNE_BODY, "manual", { fetchImpl });
    expect(result).toEqual({ ok: true, selected: true, verified: true, mismatch: [] });
  });

  it("passes through a {ok:false, reason, hint} envelope verbatim (e.g. bug #1013 delete-failed, or v1.3.0 slots-full)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, reason: "delete-failed", hint: "delete a rune page manually and retry" }),
    })) as unknown as typeof fetch;
    const result = await applyRunes(48291, "sess", RUNE_BODY, "manual", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "delete-failed", hint: "delete a rune page manually and retry" });
  });

  it("degrades to a network-error result on a fetch throw, never throwing itself", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await applyRunes(48291, "sess", RUNE_BODY, "manual", { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network-error");
  });

  it("classifies a non-2xx HTTP response with no JSON envelope as a reasoned failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    const result = await applyRunes(48291, "sess", RUNE_BODY, "manual", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "http-500" });
  });

  it("sends the mode in the request body (v1.3.0)", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return { ok: true, json: async () => ({ ok: true, selected: true, verified: true, mismatch: [] }) } as Response;
    }) as unknown as typeof fetch;
    await applyRunes(48291, "sess", RUNE_BODY, "auto", { fetchImpl });
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.mode).toBe("auto");
    expect(parsed.name).toBe(RUNE_BODY.name);
  });
});

describe("companionClient — applyItemSets", () => {
  const ITEM_SETS_BODY = { championId: 112, sets: [{ uid: "coachbuild-viktor-mid-core", title: "CoachBuild Viktor Mid — Core" }] };

  it("returns {ok:true, count} on a successful apply", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, count: 2 }) })) as unknown as typeof fetch;
    const result = await applyItemSets(48291, "sess", ITEM_SETS_BODY, { fetchImpl });
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it("passes through a {ok:false, reason, hint} envelope verbatim (e.g. read-failed)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, reason: "read-failed", hint: "could not read existing item sets -- nothing was changed" }),
    })) as unknown as typeof fetch;
    const result = await applyItemSets(48291, "sess", ITEM_SETS_BODY, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "read-failed", hint: "could not read existing item sets -- nothing was changed" });
  });

  it("degrades to a network-error result on a fetch throw, never throwing itself", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await applyItemSets(48291, "sess", ITEM_SETS_BODY, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network-error");
  });

  it("posts to /apply-itemsets with the exact body shape (championId + sets)", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return { ok: true, json: async () => ({ ok: true, count: 1 }) } as Response;
    }) as unknown as typeof fetch;
    await applyItemSets(48291, "sess", ITEM_SETS_BODY, { fetchImpl });
    expect(JSON.parse(capturedBody!)).toEqual(ITEM_SETS_BODY);
    const calledUrl = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(calledUrl).toContain("/apply-itemsets?session=sess");
  });
});

describe("companionClient — getAutoItemSetsEnabled / setAutoItemSetsEnabled", () => {
  afterEach(() => unstubWindow());

  it("defaults to false with no window (SSR — nothing to toggle for)", () => {
    expect(getAutoItemSetsEnabled()).toBe(false);
  });

  it("defaults ON once a session already exists and the toggle was never explicitly set", () => {
    stubWindow(makeLocalStorageShim());
    setStoredSession("sess-1");
    expect(getAutoItemSetsEnabled()).toBe(true);
  });

  it("defaults to false when no session exists yet, even though nothing was explicitly set", () => {
    stubWindow(makeLocalStorageShim());
    expect(getAutoItemSetsEnabled()).toBe(false);
  });

  it("an explicit false always wins, even with a session present", () => {
    stubWindow(makeLocalStorageShim());
    setStoredSession("sess-1");
    setAutoItemSetsEnabled(false);
    expect(getAutoItemSetsEnabled()).toBe(false);
  });

  it("an explicit true round-trips", () => {
    stubWindow(makeLocalStorageShim());
    setAutoItemSetsEnabled(true);
    expect(getAutoItemSetsEnabled()).toBe(true);
  });

  it("setAutoItemSetsEnabled never throws with no window", () => {
    expect(() => setAutoItemSetsEnabled(true)).not.toThrow();
  });
});
