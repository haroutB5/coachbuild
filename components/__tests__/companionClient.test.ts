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
  getSkills,
  isLiveError,
  applyRunes,
  applyItemSets,
  getAutoItemSetsEnabled,
  setAutoItemSetsEnabled,
  isFollowCapableRoute,
  followKindForRoute,
  detachFollow,
  recordCompanionError,
  getCompanionErrorLog,
  clearCompanionErrorLog,
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

  it("treats a 403 session rotation as an unavailable companion", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(probeCompanion("old-session", "passive", { fetchImpl })).resolves.toEqual({
      kind: "no-companion",
    });
  });

  it("getStatus returns null when a status request times out", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const pending = getStatus(48291, "sess", { fetchImpl });
      await vi.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    expect(status?.champSelect).toEqual({
      localPlayerCellId: 0,
      cellChampionId: null,
      pickIntent: 103,
      actionChampionId: null,
      roleId: 0,
      theirTeam: [],
      timerPhase: null,
    });
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

  it("parses theirTeam + timerPhase from a v1.4.0 companion", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.4.0",
        phase: "ChampSelect",
        clientConnected: true,
        champSelect: {
          localPlayerCellId: 2,
          cellChampionId: 112,
          pickIntent: null,
          actionChampionId: null,
          roleId: 2,
          theirTeam: [103, 64, 0, 51, 412],
          timerPhase: "BAN_PICK",
        },
      }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    // The literal 0 (an enemy who's only shown pickIntent, per companion.ps1's
    // own substitution — see CompanionChampSelectSnapshot's doc comment) is
    // dropped by the client's defensive `>0` filter, not forwarded as a fake
    // championId; that substitution is the COMPANION's job, not this file's.
    expect(status?.champSelect?.theirTeam).toEqual([103, 64, 51, 412]);
    expect(status?.champSelect?.timerPhase).toBe("BAN_PICK");
  });

  it("degrades theirTeam to [] and timerPhase to null from an older (pre-1.4.0) companion that never sends them", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.3.1",
        phase: "ChampSelect",
        clientConnected: true,
        champSelect: { localPlayerCellId: 0, cellChampionId: null, pickIntent: 103, actionChampionId: null, roleId: 0 },
      }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.champSelect?.theirTeam).toEqual([]);
    expect(status?.champSelect?.timerPhase).toBeNull();
  });

  it("filters non-number/negative/zero garbage entries out of theirTeam defensively", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.4.0",
        phase: "ChampSelect",
        clientConnected: true,
        champSelect: {
          localPlayerCellId: 0,
          cellChampionId: null,
          pickIntent: null,
          actionChampionId: null,
          roleId: null,
          theirTeam: [103, -1, 0, "64", null, undefined, NaN, 222],
          timerPhase: 42,
        },
      }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status?.champSelect?.theirTeam).toEqual([103, 222]);
    expect(status?.champSelect?.timerPhase).toBeNull(); // non-string degrades to null too
  });

  it("never rejects the whole status over a malformed theirTeam (non-array)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        version: "1.4.0",
        phase: "ChampSelect",
        clientConnected: true,
        champSelect: { localPlayerCellId: 0, cellChampionId: 103, pickIntent: null, actionChampionId: null, roleId: 0, theirTeam: "not-an-array" },
      }),
    })) as unknown as typeof fetch;
    const status = await getStatus(48291, "sess", { fetchImpl });
    expect(status).not.toBeNull();
    expect(status?.champSelect?.cellChampionId).toBe(103);
    expect(status?.champSelect?.theirTeam).toEqual([]);
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

describe("companionClient — getSkills (companion 1.8.0 /skills)", () => {
  // These test THIS CLIENT'S degradation behaviour against an injected fetch.
  // They do not — and cannot — test that the real companion emits this shape;
  // there is no League client in CI or on the authoring machine, so no real
  // /skills response has ever been observed. See lib/__tests__/nextSkill.test.ts's
  // header for why that distinction is kept explicit rather than blurred.
  const okWith = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it("narrows a well-formed reading", async () => {
    const fetchImpl = okWith({ level: 9, abilities: { Q: 5, W: 2, E: 1, R: 1 } });
    expect(await getSkills(48291, "sess", { fetchImpl })).toEqual({
      level: 9,
      abilities: { Q: 5, W: 2, E: 1, R: 1 },
    });
  });

  it("requests /skills on the given port with the session", async () => {
    const fetchImpl = okWith({ level: 1, abilities: { Q: 0, W: 0, E: 0, R: 0 } });
    await getSkills(48292, "tok en", { fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "http://127.0.0.1:48292/skills?session=tok%20en"
    );
  });

  it("collapses {error:'no-live'} to null — no game is not an error", async () => {
    expect(await getSkills(48291, "sess", { fetchImpl: okWith({ error: "no-live" }) })).toBeNull();
  });

  it("collapses a 404 from a pre-1.8.0 companion to null, exactly like no game", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "not-found" }),
    })) as unknown as typeof fetch;
    expect(await getSkills(48291, "sess", { fetchImpl })).toBeNull();
  });

  it("rejects a PARTIAL reading rather than passing half a snapshot to the resolver", async () => {
    expect(await getSkills(48291, "sess", { fetchImpl: okWith({ level: 9, abilities: { Q: 5, W: 2 } }) })).toBeNull();
    expect(await getSkills(48291, "sess", { fetchImpl: okWith({ abilities: { Q: 5, W: 2, E: 1, R: 1 } }) })).toBeNull();
  });

  it("returns null (not a throw) on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await getSkills(48291, "sess", { fetchImpl })).toBeNull();
  });

  it("returns null when the body is not JSON at all", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    })) as unknown as typeof fetch;
    expect(await getSkills(48291, "sess", { fetchImpl })).toBeNull();
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
    // v0.43.0 diagnosability: a non-2xx now carries a classified, distinct
    // hint (previously dropped entirely, indistinguishable from every other
    // failure mode on the toast).
    expect(result).toEqual({
      ok: false,
      reason: "http-500",
      hint: "League client refused the rune-page write (code 500) — is the client open?",
    });
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

describe("companionClient — isFollowCapableRoute", () => {
  it("is true for the Builds page ('/')", () => {
    expect(isFollowCapableRoute("/")).toBe(true);
  });

  it("is true for /draft", () => {
    expect(isFollowCapableRoute("/draft")).toBe(true);
  });

  it("is false for every other route (the reported bug: /live-setup)", () => {
    expect(isFollowCapableRoute("/live-setup")).toBe(false);
    expect(isFollowCapableRoute("/mystats")).toBe(false);
    expect(isFollowCapableRoute("/history")).toBe(false);
    expect(isFollowCapableRoute("/movers")).toBe(false);
  });

  it("does not prefix-match — a nested path under a follow-capable route is NOT follow-capable", () => {
    expect(isFollowCapableRoute("/draft/something")).toBe(false);
  });

  it("is false for null/undefined (usePathname can return null during a transition)", () => {
    expect(isFollowCapableRoute(null)).toBe(false);
    expect(isFollowCapableRoute(undefined)).toBe(false);
  });
});

describe("companionClient — followKindForRoute (v1.6.0 page identity)", () => {
  it("maps '/' to 'builds'", () => {
    expect(followKindForRoute("/")).toBe("builds");
  });

  it("maps '/draft' to 'draft'", () => {
    expect(followKindForRoute("/draft")).toBe("draft");
  });

  it("maps every other route to null (the reported bug: /live-setup)", () => {
    expect(followKindForRoute("/live-setup")).toBeNull();
    expect(followKindForRoute("/mystats")).toBeNull();
    expect(followKindForRoute("/history")).toBeNull();
    expect(followKindForRoute("/movers")).toBeNull();
  });

  it("does not prefix-match — a nested path under a follow-capable route maps to null", () => {
    expect(followKindForRoute("/draft/something")).toBeNull();
  });

  it("maps null/undefined to null (usePathname can return null during a transition)", () => {
    expect(followKindForRoute(null)).toBeNull();
    expect(followKindForRoute(undefined)).toBeNull();
  });

  it("isFollowCapableRoute stays a pure boolean wrapper over followKindForRoute", () => {
    expect(isFollowCapableRoute("/")).toBe(followKindForRoute("/") !== null);
    expect(isFollowCapableRoute("/draft")).toBe(followKindForRoute("/draft") !== null);
    expect(isFollowCapableRoute("/mystats")).toBe(followKindForRoute("/mystats") !== null);
  });
});

describe("companionClient — follow=<kind> query param plumbing (v1.5.0, widened v1.6.0)", () => {
  afterEach(() => unstubWindow());

  it("getStatus omits follow= by default", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ version: "1.6.0", phase: "None", clientConnected: false }) } as Response;
    }) as unknown as typeof fetch;
    await getStatus(48291, "sess", { fetchImpl });
    expect(calledUrl).not.toContain("follow=");
  });

  it("getStatus appends follow=builds when the 4th arg is 'builds'", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ version: "1.6.0", phase: "None", clientConnected: false }) } as Response;
    }) as unknown as typeof fetch;
    await getStatus(48291, "sess", { fetchImpl }, "builds");
    expect(calledUrl).toContain("follow=builds");
  });

  it("getStatus appends follow=draft when the 4th arg is 'draft'", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ version: "1.6.0", phase: "None", clientConnected: false }) } as Response;
    }) as unknown as typeof fetch;
    await getStatus(48291, "sess", { fetchImpl }, "draft");
    expect(calledUrl).toContain("follow=draft");
  });

  it("refreshStatus forwards the follow kind through to the /status request (stored-port path)", async () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48293);
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ version: "1.6.0", phase: "None", clientConnected: false }) } as Response;
    }) as unknown as typeof fetch;
    await refreshStatus("sess", { fetchImpl }, "draft");
    expect(calledUrl).toContain("follow=draft");
  });

  it("refreshStatus forwards the follow kind through to the probe fallback path", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ version: "1.6.0", phase: "None", clientConnected: false }) } as Response;
    }) as unknown as typeof fetch;
    await refreshStatus("sess", { fetchImpl }, "builds");
    expect(calledUrl).toContain("follow=builds");
  });

  it("probeCompanion appends follow=<kind> to every port it tries when asked to", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await probeCompanion("sess", "passive", { fetchImpl }, "builds");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes("follow=builds"))).toBe(true);
  });
});

describe("companionClient — detachFollow (v0.59.0 / companion 1.7.0)", () => {
  afterEach(() => unstubWindow());

  function captureFetch(urls: string[], inits: (RequestInit | undefined)[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      inits.push(init);
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  }

  it("sends follow=<kind>&detach=1 to the stored port — the whole point is that the companion stops counting this tab as attached", () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48292);
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    expect(detachFollow("builds", "sess", { fetchImpl: captureFetch(urls, inits) })).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("http://127.0.0.1:48292/status?session=sess&follow=builds&detach=1");
  });

  it("uses keepalive so the request survives the unload that triggered it", () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48291);
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    detachFollow("draft", "sess", { fetchImpl: captureFetch(urls, inits) });
    expect(urls[0]).toContain("follow=draft&detach=1");
    expect(inits[0]?.keepalive).toBe(true);
    expect(inits[0]?.method).toBe("GET"); // stays a CORS-simple request — no preflight to survive unload
  });

  it("is a no-op with no stored port (this tab never reached the bridge, so it never attached)", () => {
    stubWindow(makeLocalStorageShim());
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    expect(detachFollow("builds", "sess", { fetchImpl: captureFetch(urls, inits) })).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("is a no-op for a null kind (a non-follow-capable route was never attached)", () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48291);
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    expect(detachFollow(null, "sess", { fetchImpl: captureFetch(urls, inits) })).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("never throws or rejects — a failed beacon during unload must stay silent (the companion's browser-liveness guard is the backstop)", async () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48291);
    const rejecting = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(() => detachFollow("builds", "sess", { fetchImpl: rejecting })).not.toThrow();
    // let the swallowed rejection settle — an unhandled one would fail the run
    await Promise.resolve();
  });

  it("does not attach detach=1 to an ordinary follow poll (the suppression path must keep working)", async () => {
    stubWindow(makeLocalStorageShim());
    setStoredPort(48291);
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ version: "1.7.0", phase: "None", clientConnected: false }) } as Response;
    }) as unknown as typeof fetch;
    await refreshStatus("sess", { fetchImpl }, "builds");
    expect(calledUrl).toContain("follow=builds");
    expect(calledUrl).not.toContain("detach=");
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

describe("companionClient — recordCompanionError / getCompanionErrorLog (v0.43.0 diagnosability ring buffer)", () => {
  afterEach(() => unstubWindow());

  it("no window (SSR) — getCompanionErrorLog returns [], recordCompanionError never throws", () => {
    expect(getCompanionErrorLog()).toEqual([]);
    expect(() => recordCompanionError("network-error", "detail")).not.toThrow();
  });

  it("round-trips one entry with ts/kind/detail", () => {
    stubWindow(makeLocalStorageShim());
    recordCompanionError("http-500", "League client refused the item-set write (code 500) — is the client open?");
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("http-500");
    expect(log[0].detail).toBe("League client refused the item-set write (code 500) — is the client open?");
    expect(typeof log[0].ts).toBe("string");
    expect(new Date(log[0].ts).toString()).not.toBe("Invalid Date");
  });

  it("appends in order, most-recent-last", () => {
    stubWindow(makeLocalStorageShim());
    recordCompanionError("a", "first");
    recordCompanionError("b", "second");
    recordCompanionError("c", "third");
    const log = getCompanionErrorLog();
    expect(log.map((e) => e.kind)).toEqual(["a", "b", "c"]);
  });

  it("caps at 20 entries, dropping the oldest first", () => {
    stubWindow(makeLocalStorageShim());
    for (let i = 0; i < 25; i++) recordCompanionError(`kind-${i}`, `detail-${i}`);
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(20);
    expect(log[0].kind).toBe("kind-5"); // first 5 dropped
    expect(log[19].kind).toBe("kind-24");
  });

  it("clearCompanionErrorLog empties the log", () => {
    stubWindow(makeLocalStorageShim());
    recordCompanionError("x", "y");
    expect(getCompanionErrorLog()).toHaveLength(1);
    clearCompanionErrorLog();
    expect(getCompanionErrorLog()).toEqual([]);
  });

  it("a malformed stored value degrades to [] rather than throwing", () => {
    const shim = makeLocalStorageShim();
    shim.setItem("coachbuild:companion:lastErrors:v1", "not json");
    stubWindow(shim);
    expect(getCompanionErrorLog()).toEqual([]);
  });

  it("applyItemSets' network-error failure is recorded into the log", async () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await applyItemSets(48291, "sess", { championId: 1, sets: [] }, { fetchImpl });
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("network-error");
    expect(log[0].detail).toBe("Companion not reachable — is the tray app running?");
  });

  it("applyItemSets' non-2xx failure is recorded with the classified hint", async () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await applyItemSets(48291, "sess", { championId: 1, sets: [] }, { fetchImpl });
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("http-503");
    expect(log[0].detail).toContain("code 503");
  });

  it("applyItemSets' ok:false-without-hint is recorded with a reason-derived detail", async () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, reason: "slots-full" }),
    })) as unknown as typeof fetch;
    const result = await applyItemSets(48291, "sess", { championId: 1, sets: [] }, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain("slots-full");
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("slots-full");
  });

  it("applyItemSets' ok:false WITH a companion-supplied hint is passed through verbatim into the log", async () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, reason: "read-failed", hint: "could not read existing item sets" }),
    })) as unknown as typeof fetch;
    await applyItemSets(48291, "sess", { championId: 1, sets: [] }, { fetchImpl });
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].detail).toBe("could not read existing item sets");
  });

  it("a successful applyItemSets call records nothing", async () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, count: 1 }),
    })) as unknown as typeof fetch;
    await applyItemSets(48291, "sess", { championId: 1, sets: [] }, { fetchImpl });
    expect(getCompanionErrorLog()).toEqual([]);
  });

  it("applyRunes' network-error failure is recorded into the same log", async () => {
    stubWindow(makeLocalStorageShim());
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await applyRunes(48291, "sess", RUNE_BODY, "manual", { fetchImpl });
    const log = getCompanionErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("network-error");
  });
});
