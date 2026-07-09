/**
 * Tests for lib/pro/teamRegions.ts — the curated team->region map and the
 * pure account-activation decision function (Directive 1, 2026-07-09).
 */
import { describe, it, expect } from "vitest";
import {
  decideAccountRegionActivation,
  expectedRegionForTeam,
  normalizeTeamName,
} from "../pro/teamRegions";

describe("normalizeTeamName", () => {
  it("collapses an Esports-suffix variant to the same key as the bare name", () => {
    expect(normalizeTeamName("Gen.G Esports")).toBe(normalizeTeamName("Gen.G"));
    expect(normalizeTeamName("G2 Esports")).toBe(normalizeTeamName("G2"));
  });

  it("is case-insensitive and strips punctuation", () => {
    expect(normalizeTeamName("t1")).toBe(normalizeTeamName("T1"));
    expect(normalizeTeamName("KT Rolster")).toBe(normalizeTeamName("kt rolster"));
  });
});

describe("expectedRegionForTeam", () => {
  it("maps LCK teams to KR", () => {
    expect(expectedRegionForTeam("T1")).toEqual({ kind: "region", region: "KR" });
    expect(expectedRegionForTeam("Gen.G Esports")).toEqual({ kind: "region", region: "KR" });
    expect(expectedRegionForTeam("Gen.G")).toEqual({ kind: "region", region: "KR" }); // live-confirmed real spelling
    expect(expectedRegionForTeam("Hanwha Life Esports")).toEqual({ kind: "region", region: "KR" });
  });

  it("maps LEC teams to EUW, including both pre- and post-rebrand KOI names", () => {
    expect(expectedRegionForTeam("G2 Esports")).toEqual({ kind: "region", region: "EUW" });
    expect(expectedRegionForTeam("MAD Lions KOI")).toEqual({ kind: "region", region: "EUW" });
    expect(expectedRegionForTeam("Movistar KOI")).toEqual({ kind: "region", region: "EUW" }); // live-confirmed
  });

  it("maps LTA North / LCS teams to NA", () => {
    expect(expectedRegionForTeam("Team Liquid")).toEqual({ kind: "region", region: "NA" });
    expect(expectedRegionForTeam("Cloud9")).toEqual({ kind: "region", region: "NA" });
  });

  it("maps LPL teams (full name or short code) to unreachable", () => {
    expect(expectedRegionForTeam("Bilibili Gaming")).toEqual({ kind: "unreachable" });
    expect(expectedRegionForTeam("BLG")).toEqual({ kind: "unreachable" });
    expect(expectedRegionForTeam("JD Gaming")).toEqual({ kind: "unreachable" });
  });

  it("returns none for null/empty/whitespace team", () => {
    expect(expectedRegionForTeam(null)).toEqual({ kind: "none" });
    expect(expectedRegionForTeam(undefined)).toEqual({ kind: "none" });
    expect(expectedRegionForTeam("")).toEqual({ kind: "none" });
    expect(expectedRegionForTeam("   ")).toEqual({ kind: "none" });
  });

  it("returns unmapped for a present-but-unrecognized team, never a guess", () => {
    expect(expectedRegionForTeam("Witchcraft")).toEqual({ kind: "unmapped" });
    expect(expectedRegionForTeam("Some Random Academy Team")).toEqual({ kind: "unmapped" });
  });

  it("deliberately does NOT map academy/challenger rosters to their parent org's region", () => {
    expect(expectedRegionForTeam("Karmine Corp Blue")).toEqual({ kind: "unmapped" });
    expect(expectedRegionForTeam("Movistar KOI Fénix")).toEqual({ kind: "unmapped" });
  });
});

describe("decideAccountRegionActivation", () => {
  it("region team: activates matching-region accounts, deactivates the rest", () => {
    const { decisions, unmappedTeam } = decideAccountRegionActivation("T1", [
      { puuid: "kr1", region: "KR", active: false },
      { puuid: "euw1", region: "EUW", active: true },
      { puuid: "euw2", region: "EUW", active: true },
    ]);
    expect(unmappedTeam).toBeUndefined();
    expect(decisions).toEqual([
      { puuid: "kr1", active: true, changed: true },
      { puuid: "euw1", active: false, changed: true },
      { puuid: "euw2", active: false, changed: true },
    ]);
  });

  it("region team: marks changed=false for accounts already in the correct state (no wasted write)", () => {
    const { decisions } = decideAccountRegionActivation("T1", [
      { puuid: "kr1", region: "KR", active: true },
      { puuid: "euw1", region: "EUW", active: false },
    ]);
    expect(decisions).toEqual([
      { puuid: "kr1", active: true, changed: false },
      { puuid: "euw1", active: false, changed: false },
    ]);
  });

  it("Faker's exact scenario: 4 EUW accounts, T1/LCK team, no KR account yet -> all 4 deactivated", () => {
    const accounts = [
      { puuid: "e1", region: "EUW", active: true },
      { puuid: "e2", region: "EUW", active: true },
      { puuid: "e3", region: "EUW", active: true },
      { puuid: "e4", region: "EUW", active: true },
    ];
    const { decisions } = decideAccountRegionActivation("T1", accounts);
    expect(decisions.every((d) => d.active === false)).toBe(true);
    expect(decisions.every((d) => d.changed === true)).toBe(true);
  });

  it("unreachable (LPL) team WITH a KR account: only the KR account is active", () => {
    const { decisions } = decideAccountRegionActivation("Bilibili Gaming", [
      { puuid: "kr1", region: "KR", active: false },
      { puuid: "cn1", region: "EUW", active: true }, // some other stray region on file
    ]);
    expect(decisions).toEqual([
      { puuid: "kr1", active: true, changed: true },
      { puuid: "cn1", active: false, changed: true },
    ]);
  });

  it("unreachable (LPL) team with NO KR account: entire set left unchanged", () => {
    const accounts = [
      { puuid: "e1", region: "EUW", active: true },
      { puuid: "e2", region: "EUW", active: false },
    ];
    const { decisions } = decideAccountRegionActivation("JD Gaming", accounts);
    expect(decisions).toEqual([
      { puuid: "e1", active: true, changed: false },
      { puuid: "e2", active: false, changed: false },
    ]);
  });

  it("null team: every account left exactly as-is, even a previously-inactive one (not force-activated)", () => {
    const { decisions, unmappedTeam } = decideAccountRegionActivation(null, [
      { puuid: "a1", region: "EUW", active: true },
      { puuid: "a2", region: "NA", active: false },
    ]);
    expect(unmappedTeam).toBeUndefined();
    expect(decisions).toEqual([
      { puuid: "a1", active: true, changed: false },
      { puuid: "a2", active: false, changed: false },
    ]);
  });

  it("unmapped team: every account left as-is, AND the team name is surfaced for logging", () => {
    const { decisions, unmappedTeam } = decideAccountRegionActivation("Witchcraft", [
      { puuid: "a1", region: "EUW", active: true },
    ]);
    expect(unmappedTeam).toBe("Witchcraft");
    expect(decisions).toEqual([{ puuid: "a1", active: true, changed: false }]);
  });

  it("empty account list: returns an empty decisions array without touching the map lookup outcome", () => {
    const { decisions } = decideAccountRegionActivation("T1", []);
    expect(decisions).toEqual([]);
  });
});
