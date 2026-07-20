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
        status: { version: "1.0.0", port: COMPANION_PORTS[1], phase: "ChampSelect", clientConnected: true },
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
      status: { version: "1.0.0", port: 48293, phase: "InProgress", clientConnected: true },
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
  it("returns {ok:true} on a successful apply", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
    const result = await applyRunes(48291, "sess", RUNE_BODY, { fetchImpl });
    expect(result).toEqual({ ok: true });
  });

  it("passes through a {ok:false, reason, hint} envelope verbatim (e.g. bug #1013 delete-failed)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, reason: "delete-failed", hint: "delete a rune page manually and retry" }),
    })) as unknown as typeof fetch;
    const result = await applyRunes(48291, "sess", RUNE_BODY, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "delete-failed", hint: "delete a rune page manually and retry" });
  });

  it("degrades to a network-error result on a fetch throw, never throwing itself", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await applyRunes(48291, "sess", RUNE_BODY, { fetchImpl });
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
    const result = await applyRunes(48291, "sess", RUNE_BODY, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "http-500" });
  });
});
