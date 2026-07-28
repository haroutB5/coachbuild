import { describe, it, expect } from "vitest";
import {
  parseOneTricksRows,
  pickFeaturedOneTrick,
  riotId,
  MIN_CHAMPION_GAMES,
} from "../otp/onetricks";

// Captured live from onetricks.gg on 2026-07-29. Keeping the real strings
// rather than tidied ones is deliberate: the awkward cases here (a tag with a
// space, a name with spaces, the optional trailing OTP marker) are exactly what
// a hand-written fixture would smooth away.
const VIKTOR = [
  "1 Challenger Splash #0 1 EUW1: 2486 LP 33% 722 56% 2.81:1",
  "2 Challenger Dun #NA1 NA1: 2316 LP 67% 627 60% 2.93:1 OTP",
  "3 Grandmaster Die Twice #chris EUW1: 2067 LP 63% 364 58% 2.8:1 OTP",
  "4 Grandmaster Rip Van Winkle #POL EUW1: 1927 LP 70% 395 58% 3.68:1 OTP",
  "5 Grandmaster Haleboper #EUW EUW1: 1811 LP 42% 236 58% 2.43:1 OTP",
  "6 Challenger Tears of Winter #NA1 NA1: 1805 LP 57% 122 64% 2.81:1 OTP",
  "7 Master Nem #Ag0ny EUW1: 1779 LP 26% 243 51% 2.14:1",
  "8 Master Kraken #Abuse EUW1: 1761 LP 40% 81 72% 3.78:1 OTP",
];

const AKSHAN = [
  "1 Challenger Phanta #107 EUW1: 4088 LP 68% 504 63% 4.25:1 OTP",
  "2 Challenger 30pushupperdeath #hard EUW1: 3024 LP 74% 997 56% 3.18:1 OTP",
  "3 Challenger Phantasm #TWTV0 EUW1: 2982 LP 49% 117 77% 4.72:1",
  "4 Challenger dmoney #401K NA1: 2227 LP 26% 66 62% 3.4:1",
];

describe("parseOneTricksRows", () => {
  it("reads every field off a real row", () => {
    const [row] = parseOneTricksRows([VIKTOR[1]]);
    expect(row).toEqual({
      rank: 2,
      tier: "Challenger",
      gameName: "Dun",
      tagLine: "NA1",
      server: "NA1",
      lp: 2316,
      championSharePct: 67,
      games: 627,
      winratePct: 60,
      kda: 2.93,
      isOtp: true,
    });
  });

  it("keeps a tag that contains a space", () => {
    // "Splash #0 1 EUW1:" — a greedy tag match swallows the server and yields
    // nonsense, so this is the case the anchor exists for.
    const [row] = parseOneTricksRows([VIKTOR[0]]);
    expect(row.gameName).toBe("Splash");
    expect(row.tagLine).toBe("0 1");
    expect(row.server).toBe("EUW1");
    expect(row.isOtp).toBe(false);
  });

  it("keeps a name that contains spaces", () => {
    const [row] = parseOneTricksRows([VIKTOR[5]]);
    expect(row.gameName).toBe("Tears of Winter");
    expect(row.tagLine).toBe("NA1");
  });

  it("drops unparseable rows instead of guessing", () => {
    expect(parseOneTricksRows(["", "garbage", "1 Challenger NoHashHere NA1: 100 LP"])).toEqual([]);
    // A near-miss: everything present but the KDA shape changed.
    expect(parseOneTricksRows(["2 Challenger Dun #NA1 NA1: 2316 LP 67% 627 60% 2.93 OTP"])).toEqual([]);
  });

  it("parses a whole captured page without losing rows", () => {
    expect(parseOneTricksRows(VIKTOR)).toHaveLength(VIKTOR.length);
    expect(parseOneTricksRows(AKSHAN)).toHaveLength(AKSHAN.length);
  });
});

describe("pickFeaturedOneTrick", () => {
  it("picks Dun for Viktor, not the higher-LP non-one-trick above him", () => {
    // Splash has more LP (2486 vs 2316) and more games, but only 33% of his
    // games are Viktor and the site does not flag him OTP. This is the exact
    // disagreement that made op.gg unusable as the selection source.
    const featured = pickFeaturedOneTrick(parseOneTricksRows(VIKTOR));
    expect(riotId(featured!)).toBe("Dun#NA1");
  });

  it("picks Phanta for Akshan", () => {
    const featured = pickFeaturedOneTrick(parseOneTricksRows(AKSHAN));
    expect(riotId(featured!)).toBe("Phanta#107");
  });

  it("excludes a flagged one-trick below the games floor", () => {
    // Tears of Winter: OTP-flagged, 64% winrate, but 122 games.
    const rows = parseOneTricksRows(VIKTOR).filter((r) => r.gameName === "Tears of Winter");
    expect(rows[0].games).toBeLessThan(MIN_CHAMPION_GAMES);
    expect(pickFeaturedOneTrick(rows)).toBeNull();
  });

  it("excludes a high-LP account that is not flagged as a one-trick", () => {
    const rows = parseOneTricksRows(VIKTOR).filter((r) => r.gameName === "Splash");
    expect(rows[0].games).toBeGreaterThan(MIN_CHAMPION_GAMES);
    expect(pickFeaturedOneTrick(rows)).toBeNull();
  });

  it("re-sorts by LP rather than trusting the source order", () => {
    const shuffled = [...parseOneTricksRows(VIKTOR)].reverse();
    expect(riotId(pickFeaturedOneTrick(shuffled)!)).toBe("Dun#NA1");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickFeaturedOneTrick([])).toBeNull();
    expect(pickFeaturedOneTrick(parseOneTricksRows(["4 Challenger dmoney #401K NA1: 2227 LP 26% 66 62% 3.4:1"]))).toBeNull();
  });
});
