import { describe, it, expect, beforeEach } from "vitest";
import { forwardDecisionToBridge, __resetBridgeLogForTests } from "../bridgeLog";

function responder(status: number, seen: string[]) {
  return (async (url: string, init?: RequestInit) => {
    seen.push(`${(init?.method ?? "GET")} ${url} :: ${init?.body ?? ""}`);
    return { status } as Response;
  }) as unknown as typeof fetch;
}

describe("bridgeLog forwarding", () => {
  beforeEach(() => __resetBridgeLogForTests());

  it("POSTs one decision line to /client-log with the session", async () => {
    const seen: string[] = [];
    forwardDecisionToBridge("103/2: hold - timer phase PLANNING", "tok", 48291, {
      fetchImpl: responder(200, seen),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("POST http://127.0.0.1:48291/client-log?session=tok");
    expect(seen[0]).toContain("103/2: hold - timer phase PLANNING");
  });

  it("sends nothing without a session, a port, or a line", async () => {
    const seen: string[] = [];
    const f = responder(200, seen);
    forwardDecisionToBridge("x", null, 48291, { fetchImpl: f });
    forwardDecisionToBridge("x", "", 48291, { fetchImpl: f });
    forwardDecisionToBridge("x", "tok", null, { fetchImpl: f });
    forwardDecisionToBridge("", "tok", 48291, { fetchImpl: f });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(0);
  });

  it("skips a consecutive duplicate rather than re-posting it", async () => {
    const seen: string[] = [];
    const f = responder(200, seen);
    forwardDecisionToBridge("same line", "tok", 48291, { fetchImpl: f });
    forwardDecisionToBridge("same line", "tok", 48291, { fetchImpl: f });
    forwardDecisionToBridge("different line", "tok", 48291, { fetchImpl: f });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(2);
  });

  it("treats a 404 as an older bridge and stays console-only for that session", async () => {
    const seen: string[] = [];
    const f = responder(404, seen);
    forwardDecisionToBridge("first", "oldsess", 48291, { fetchImpl: f });
    await new Promise((r) => setTimeout(r, 0));
    forwardDecisionToBridge("second", "oldsess", 48291, { fetchImpl: f });
    forwardDecisionToBridge("third", "newsess", 48291, { fetchImpl: f });
    await new Promise((r) => setTimeout(r, 0));
    // First 404s (one post), second suppressed, third is a new session.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("session=newsess");
  });

  it("a throwing transport never rejects out of the forwarder", async () => {
    const f = (async () => {
      throw new Error("bridge gone");
    }) as unknown as typeof fetch;
    expect(() => forwardDecisionToBridge("x", "tok", 48291, { fetchImpl: f })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
