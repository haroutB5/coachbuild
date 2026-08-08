import { describe, expect, it } from "vitest";
import {
  FEATURED_FLIP_MARGIN,
  rankFeaturedOtpCandidates,
  selectFeaturedOneTrick,
  type FeaturedOtpCandidate,
} from "../onetricks";

function candidate(overrides: Partial<FeaturedOtpCandidate>): FeaturedOtpCandidate {
  return {
    rank: 1,
    tier: "MASTER",
    gameName: "Candidate",
    tagLine: "EUW",
    server: "EUW1",
    lp: 1000,
    championSharePct: 50,
    games: 500,
    winratePct: 50,
    kda: 2,
    isOtp: true,
    ...overrides,
  };
}

describe("featured OTP selection", () => {
  it("selects ozneviik for the Zaahen fixture despite Numbers' small winrate edge", () => {
    const ozneviik = candidate({
      gameName: "twtv ozneviik",
      tagLine: "TWICH",
      puuid: "ozneviik-puuid",
      rank: 6,
      lp: 1344,
      championSharePct: 57,
      games: 917,
      winratePct: 54.5,
      championPlays: 917,
      championWins: 500,
      leaderboardRank: 2,
    });
    const numbers = candidate({
      gameName: "Numbers",
      tagLine: "PLUH",
      puuid: "numbers-puuid",
      rank: 5,
      lp: 1356,
      championSharePct: 40,
      games: 577,
      winratePct: 56,
      championPlays: 579,
      championWins: 324,
      leaderboardRank: 4,
    });

    const ranked = rankFeaturedOtpCandidates([numbers, ozneviik]);
    const selection = selectFeaturedOneTrick([numbers, ozneviik], {
      incumbentKey: numbers.puuid,
    });

    expect(selection?.candidate.gameName).toBe("twtv ozneviik");
    expect(selection?.reason).toBe("challenger-margin");
    expect(ranked[0].candidate.gameName).toBe("twtv ozneviik");
    expect(ranked[0].score).toBeGreaterThan(
      ranked[1].score * (1 + FEATURED_FLIP_MARGIN)
    );
    // The 56% candidate is shrunk toward the same pool mean, so its raw
    // winrate does not overwhelm the deeper sample, share, or better rank.
    expect(ranked[1].shrunkWinratePct).toBeGreaterThan(ranked[0].shrunkWinratePct);
    expect(ranked[1].shrunkWinratePct - ranked[0].shrunkWinratePct).toBeLessThan(2);
  });

  it("keeps the incumbent when a challenger is only within the flip margin", () => {
    const incumbent = candidate({
      gameName: "Incumbent",
      puuid: "incumbent-puuid",
      championPlays: 1000,
      championWins: 540,
      games: 1000,
      leaderboardRank: 2,
      championSharePct: 60,
      winratePct: 54,
    });
    const slightChallenger = candidate({
      gameName: "Slight challenger",
      puuid: "slight-puuid",
      championPlays: 1050,
      championWins: 567,
      games: 1050,
      leaderboardRank: 2,
      championSharePct: 60,
      winratePct: 54,
    });

    const selection = selectFeaturedOneTrick([incumbent, slightChallenger], {
      incumbentKey: incumbent.puuid,
    });

    expect(selection?.candidate.gameName).toBe("Incumbent");
    expect(selection?.reason).toBe("incumbent-hysteresis");
  });

  it("lets a challenger take the slot beyond the margin", () => {
    const incumbent = candidate({
      gameName: "Incumbent",
      puuid: "incumbent-puuid",
      championPlays: 1000,
      championWins: 540,
      games: 1000,
      leaderboardRank: 4,
      championSharePct: 50,
      winratePct: 54,
    });
    const challenger = candidate({
      gameName: "Clear challenger",
      puuid: "clear-puuid",
      championPlays: 2500,
      championWins: 1350,
      games: 2500,
      leaderboardRank: 2,
      championSharePct: 60,
      winratePct: 54,
    });

    const selection = selectFeaturedOneTrick([incumbent, challenger], {
      incumbentKey: incumbent.puuid,
    });

    expect(selection?.candidate.gameName).toBe("Clear challenger");
    expect(selection?.reason).toBe("challenger-margin");
  });

  it("uses plain argmax when a champion has no incumbent", () => {
    const lower = candidate({ gameName: "Lower", championPlays: 500, games: 500 });
    const higher = candidate({ gameName: "Higher", championPlays: 800, games: 800 });

    const selection = selectFeaturedOneTrick([lower, higher]);

    expect(selection?.candidate.gameName).toBe("Higher");
    expect(selection?.reason).toBe("argmax");
  });

  it("does not let a 5000-game versus 4000-game gap become a linear takeover", () => {
    const deep = candidate({ gameName: "Five thousand", championPlays: 5000, games: 5000 });
    const fourThousand = candidate({ gameName: "Four thousand", championPlays: 4000, games: 4000 });
    const ranked = rankFeaturedOtpCandidates([deep, fourThousand]);

    expect(ranked[0].score / ranked[1].score).toBeLessThan(1.1);
  });
});
