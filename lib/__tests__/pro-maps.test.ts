/**
 * Tests for lib/pro/regionMap.ts and lib/pro/roleMap.ts — pure mapping
 * functions, no network.
 */
import { describe, it, expect } from "vitest";
import { routingForServer } from "../pro/regionMap";
import { roleFromTeamPosition, roleFromLolProsPosition } from "../pro/roleMap";

describe("routingForServer", () => {
  it("maps known lolpros server strings to platform + regional routing", () => {
    expect(routingForServer("EUW")).toEqual({ platform: "euw1", regional: "europe" });
    expect(routingForServer("KR")).toEqual({ platform: "kr", regional: "asia" });
    expect(routingForServer("NA")).toEqual({ platform: "na1", regional: "americas" });
    expect(routingForServer("OCE")).toEqual({ platform: "oc1", regional: "americas" });
  });

  it("is case-insensitive", () => {
    expect(routingForServer("euw")).toEqual({ platform: "euw1", regional: "europe" });
  });

  it("returns null (skip+log) for unmapped/missing servers", () => {
    expect(routingForServer("MARS")).toBeNull();
    expect(routingForServer(undefined)).toBeNull();
    expect(routingForServer(null)).toBeNull();
    expect(routingForServer("")).toBeNull();
  });
});

describe("roleFromTeamPosition", () => {
  it("maps Riot's five teamPosition strings", () => {
    expect(roleFromTeamPosition("TOP")).toBe(0);
    expect(roleFromTeamPosition("JUNGLE")).toBe(1);
    expect(roleFromTeamPosition("MIDDLE")).toBe(2);
    expect(roleFromTeamPosition("BOTTOM")).toBe(3);
    expect(roleFromTeamPosition("UTILITY")).toBe(4);
  });

  it("returns null for empty/unknown teamPosition (Riot leaves it '' on remakes)", () => {
    expect(roleFromTeamPosition("")).toBeNull();
    expect(roleFromTeamPosition(undefined)).toBeNull();
    expect(roleFromTeamPosition("INVALID")).toBeNull();
  });
});

describe("roleFromLolProsPosition", () => {
  it("maps the observed live lolpros position strings (verified 2026-07-09)", () => {
    expect(roleFromLolProsPosition("10_top")).toBe(0);
    expect(roleFromLolProsPosition("20_jungle")).toBe(1);
    expect(roleFromLolProsPosition("30_mid")).toBe(2);
    expect(roleFromLolProsPosition("40_adc")).toBe(3);
    expect(roleFromLolProsPosition("50_support")).toBe(4);
  });

  it("returns null for unrecognized positions", () => {
    expect(roleFromLolProsPosition("99_coach")).toBeNull();
    expect(roleFromLolProsPosition(null)).toBeNull();
  });
});
