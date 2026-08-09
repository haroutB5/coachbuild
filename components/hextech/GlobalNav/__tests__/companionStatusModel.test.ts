import { describe, it, expect } from "vitest";
import { companionStatusModel } from "../companionStatusModel";

describe("companionStatusModel", () => {
  it("row 1: no session -> off, grey dot, links to /live-setup", () => {
    const model = companionStatusModel({ session: null, phase: null, clientConnected: false, champSelect: null });
    expect(model).toEqual({ tone: "off", dotClass: "bg-mut", header: "COMPANION", title: "Not paired", subtitle: "Set up →", href: "/live-setup" });
  });

  it("row 2: session set, client not connected -> idle, gold dot", () => {
    const model = companionStatusModel({ session: "tok", phase: null, clientConnected: false, champSelect: null });
    expect(model).toEqual({ tone: "idle", dotClass: "bg-mut", header: "COMPANION", title: "Client not detected", subtitle: "Waiting for League client…" });
  });

  it("row 3: client connected, phase not ChampSelect/InProgress -> idle, green dot", () => {
    const model = companionStatusModel({ session: "tok", phase: "None", clientConnected: true, champSelect: null });
    expect(model).toEqual({ tone: "idle", dotClass: "bg-win", header: "COMPANION READY", title: "Client detected", subtitle: "Waiting for queue…" });
  });

  it("row 3b: client connected, phase null -> same idle/green as row 3", () => {
    const model = companionStatusModel({ session: "tok", phase: null, clientConnected: true, champSelect: null });
    expect(model.tone).toBe("idle");
    expect(model.dotClass).toBe("bg-win");
    expect(model.title).toBe("Client detected");
  });

  it("row 4: phase ChampSelect -> live, green dot", () => {
    const model = companionStatusModel({ session: "tok", phase: "ChampSelect", clientConnected: true, champSelect: {} });
    expect(model).toEqual({ tone: "live", dotClass: "bg-win", header: "COMPANION LIVE", title: "In champ select", subtitle: "Locking in…" });
  });

  it("row 5: phase InProgress -> live, green dot", () => {
    const model = companionStatusModel({ session: "tok", phase: "InProgress", clientConnected: true, champSelect: null });
    expect(model).toEqual({ tone: "live", dotClass: "bg-win", header: "COMPANION LIVE", title: "In game", subtitle: "Live" });
  });

  it("never fabricates a live phase when the client isn't connected, even if phase claims ChampSelect", () => {
    // Guards the "honest state" invariant: !clientConnected always wins over
    // whatever phase happens to be reported (a stale/bogus phase value from
    // a companion that's no longer actually attached to a client).
    const model = companionStatusModel({ session: "tok", phase: "ChampSelect", clientConnected: false, champSelect: {} });
    expect(model.tone).toBe("idle");
    expect(model.dotClass).toBe("bg-mut");
    expect(model.title).toBe("Client not detected");
  });

  it("shows OFF when the last successful status poll is stale, even if cached phase says ChampSelect", () => {
    const model = companionStatusModel({
      session: "tok",
      phase: "ChampSelect",
      clientConnected: true,
      champSelect: {},
      statusFresh: false,
    });
    expect(model).toEqual({ tone: "off", dotClass: "bg-mut", header: "COMPANION", title: "Not responding", subtitle: "Check it's running →", href: "/live-setup" });
  });
});
