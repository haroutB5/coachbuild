/**
 * Pure-logic tests for lib/prostage/liveIngest.ts.
 *
 * Both functions here encode a bug that actually shipped to the DB on the first
 * live run and had to be deleted and re-ingested:
 *   - decideWinnerSide: the final-frame window was fetched with an UNALIGNED
 *     startingTime, so every frame came back empty and every game was skipped
 *     as "winner undecidable". The refusal to guess is the behaviour worth
 *     pinning — a wrong win/loss is worse than a missing game.
 *   - stripTeamPrefix: team was originally derived from game.teams[].side ->
 *     team id, which does NOT line up with the livestats blue/red arrays. Every
 *     IG player was written as team "WBG" and vice versa, and because the code
 *     was wrong the prefix never stripped, so "IGTheShy" was never findable as
 *     "TheShy". Team is now derived from the name prefix itself.
 */
import { describe, it, expect } from "vitest";
import { decideWinnerSide, stripTeamPrefix } from "../prostage/liveIngest";

describe("decideWinnerSide", () => {
  it("takes the majority of inhibitors/towers/gold", () => {
    expect(
      decideWinnerSide(
        { inhibitors: 2, towers: 9, totalGold: 60000 },
        { inhibitors: 0, towers: 3, totalGold: 48000 },
      ),
    ).toBe("blue");
  });

  it("lets two of three outvote the third", () => {
    // Blue is BEHIND on gold but ahead on inhibitors and towers — 2 votes to 1.
    expect(
      decideWinnerSide(
        { inhibitors: 1, towers: 8, totalGold: 50000 },
        { inhibitors: 0, towers: 4, totalGold: 52000 },
      ),
    ).toBe("blue");
  });

  it("returns null on an all-zero frame rather than guessing", () => {
    // This is exactly what an unaligned startingTime produced: a real response
    // shape with no data in it. Must NOT be read as a blue win.
    expect(
      decideWinnerSide(
        { inhibitors: 0, towers: 0, totalGold: 0 },
        { inhibitors: 0, towers: 0, totalGold: 0 },
      ),
    ).toBeNull();
  });

  it("returns null when a side is missing entirely", () => {
    expect(decideWinnerSide(undefined, { inhibitors: 1, towers: 2, totalGold: 3 })).toBeNull();
    expect(decideWinnerSide({ inhibitors: 1, towers: 2, totalGold: 3 }, undefined)).toBeNull();
  });

  it("returns null on a dead tie", () => {
    expect(
      decideWinnerSide(
        { inhibitors: 1, towers: 5, totalGold: 50000 },
        { inhibitors: 1, towers: 5, totalGold: 50000 },
      ),
    ).toBeNull();
  });
});

describe("stripTeamPrefix", () => {
  it("strips the team code from a prefixed summoner name", () => {
    expect(stripTeamPrefix("IGTheShy", "IG")).toBe("TheShy");
    expect(stripTeamPrefix("WBGXiaohu", "WBG")).toBe("Xiaohu");
  });

  it("is case-insensitive on the code", () => {
    expect(stripTeamPrefix("igTheShy", "IG")).toBe("TheShy");
  });

  it("leaves the name alone when the prefix does not match", () => {
    // The inverted-mapping bug: stripping IGTheShy with WBG must not mangle it.
    expect(stripTeamPrefix("IGTheShy", "WBG")).toBe("IGTheShy");
  });

  it("leaves the name alone when no code is known", () => {
    expect(stripTeamPrefix("Caps", undefined)).toBe("Caps");
  });

  it("never strips a name down to nothing", () => {
    // A name identical to the code must survive rather than becoming "".
    expect(stripTeamPrefix("IG", "IG")).toBe("IG");
  });
});
