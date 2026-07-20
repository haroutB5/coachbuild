import { describe, it, expect } from "vitest";
import { parseLiveDeepLink, roleIdToLane } from "../live/deepLink";

describe("parseLiveDeepLink", () => {
  it("parses a well-formed link", () => {
    expect(parseLiveDeepLink("?championId=112&role=2&session=abc123")).toEqual({
      championId: 112,
      role: 2,
      session: "abc123",
    });
  });

  it("accepts a query string without the leading '?'", () => {
    expect(parseLiveDeepLink("championId=64&role=1&session=xyz")).toEqual({
      championId: 64,
      role: 1,
      session: "xyz",
    });
  });

  it("session is null when absent, but the link is still valid", () => {
    expect(parseLiveDeepLink("?championId=112&role=2")).toEqual({
      championId: 112,
      role: 2,
      session: null,
    });
  });

  it("returns null when championId is missing", () => {
    expect(parseLiveDeepLink("?role=2&session=abc")).toBeNull();
  });

  it("role-less link (blank/unmapped assignedPosition — custom/blind-pick/ARAM) is VALID, role is undefined", () => {
    expect(parseLiveDeepLink("?championId=112&session=abc")).toEqual({
      championId: 112,
      role: undefined,
      session: "abc",
    });
  });

  it("role-less link with no session either — still valid", () => {
    expect(parseLiveDeepLink("?championId=112")).toEqual({
      championId: 112,
      role: undefined,
      session: null,
    });
  });

  it("returns null for a non-numeric championId", () => {
    expect(parseLiveDeepLink("?championId=notanumber&role=2")).toBeNull();
  });

  it("returns null for championId <= 0", () => {
    expect(parseLiveDeepLink("?championId=0&role=2")).toBeNull();
    expect(parseLiveDeepLink("?championId=-5&role=2")).toBeNull();
  });

  it("returns null for role 5 (Auto) — companion never emits it", () => {
    expect(parseLiveDeepLink("?championId=112&role=5")).toBeNull();
  });

  it("returns null for a negative or non-numeric role", () => {
    expect(parseLiveDeepLink("?championId=112&role=-1")).toBeNull();
    expect(parseLiveDeepLink("?championId=112&role=nope")).toBeNull();
  });

  it("truncates a stray float role (companion is a trusted origin)", () => {
    expect(parseLiveDeepLink("?championId=112&role=2.9")).toEqual({
      championId: 112,
      role: 2,
      session: null,
    });
  });

  it("ignores extra/unknown query params", () => {
    expect(parseLiveDeepLink("?championId=112&role=2&session=abc&utm_source=x")).toEqual({
      championId: 112,
      role: 2,
      session: "abc",
    });
  });

  it("returns null for an empty query string", () => {
    expect(parseLiveDeepLink("")).toBeNull();
    expect(parseLiveDeepLink("?")).toBeNull();
  });
});

describe("roleIdToLane", () => {
  it("maps every companion role id to the app's LaneId vocabulary", () => {
    expect(roleIdToLane(0)).toBe("top");
    expect(roleIdToLane(1)).toBe("jungle");
    expect(roleIdToLane(2)).toBe("mid");
    expect(roleIdToLane(3)).toBe("bot");
    expect(roleIdToLane(4)).toBe("support");
  });
});
