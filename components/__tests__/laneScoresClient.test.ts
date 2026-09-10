import { afterEach, describe, expect, it, vi } from "vitest";
import { localBridgeFetch } from "@/desktop/ui/localBridge";
import { submitLaneScore, laneScoreFailureMessage } from "@/components/live/laneScoresClient";

vi.mock("@/components/live/companionClient", () => ({
  getStoredPort: () => 48291,
  getStoredSession: () => "test-session",
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("lane-score bridge requests", () => {
  it("sends a chosen role and opponent with the score and session", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    expect(await submitLaneScore({ matchId: "game", score: 8, roleId: 4, opponentChampionId: 887 })).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url.origin).toBe("http://127.0.0.1:48291");
    expect(url.searchParams.get("session")).toBe("test-session");
    expect(JSON.parse(init.body)).toEqual({ matchId: "game", score: 8, roleId: 4, opponentChampionId: 887 });
  });

  it("still times out when a mounted poll supplies a cancellation signal", async () => {
    const timeout = new AbortController();
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await localBridgeFetch("/lane-scores/pending", caller.signal);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    timeout.abort();
    expect(signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(20000);
  });

  it("honours unmount cancellation without waiting for the timeout", async () => {
    const caller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    await localBridgeFetch("/lane-scores/pending", caller.signal);
    caller.abort();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not send the session token to another origin", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(localBridgeFetch("https://example.com/")).rejects.toThrow("Invalid bridge destination");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains unknown-role and unreadable-history failures", () => {
    expect(laneScoreFailureMessage("role-required")).toContain("role");
    expect(laneScoreFailureMessage("store-unreadable")).toContain("unchanged");
  });
});
