/**
 * Tests for lib/otp/leaderboard.ts — the op.gg champion-leaderboard parser.
 *
 * The fixture below is a REAL captured payload (champion=VIKTOR, region=EUW,
 * 2026-07-28), trimmed to 3 entries. This is where a provider reshape gets
 * caught, so the assertions are about refusing wrong data at least as much as
 * about reading right data.
 */
import { describe, it, expect } from "vitest";
import { buildLeaderboardRpc, fetchOtpCandidates, parseLeaderboard } from "../otp/leaderboard";

const VIKTOR_ID = 112;

const REAL_PAYLOAD = `class LolListChampionLeaderboard: region,champion,leaderboard
class Leaderboard: rank,summoner,most_champion_stat
class Summoner: puuid,game_name,tagline,level,league_stats
class LeagueStat: tier_info
class TierInfo: tier,division,lp
class MostChampionStat: id,play,win,lose,op_score

LolListChampionLeaderboard("EUW","112",[Leaderboard(1,Summoner("y03C9WIycgnDkhuW6CccZzJVGTEKToqay7KXSZVskGfh157tw9_kLWPMYiaQGFlHCryXIzKcjQofUA","Love","KV00",239,[LeagueStat(TierInfo("MASTER",1,820))]),MostChampionStat(112,729,399,330,3830)),Leaderboard(2,Summoner("95z9irEBCfdKrbXhfXcVnLGgXZKOFcb8aYtbqVcjSKOs8ZUQpB5dRXl8lfG_s8_Hpinvv-LaLvFXKQ","Splash","0 1",1382,[LeagueStat(TierInfo("CHALLENGER",1,2486))]),MostChampionStat(112,722,402,320,4158)),Leaderboard(3,Summoner("2SjH3bAvwG9fD4lXc2dyS8om1OZcQb46S5s3WniQ8vCY2wCVYt9tss88cq0wReC2sX8ifA0jKlVsDA","Vork","135",401,[LeagueStat(TierInfo("DIAMOND",2,10)),LeagueStat(TierInfo("EMERALD",4,65))]),MostChampionStat(112,661,344,317,3723))])`;

describe("parseLeaderboard", () => {
  it("reads every entry from a real captured payload", () => {
    const out = parseLeaderboard(REAL_PAYLOAD, VIKTOR_ID);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      rank: 1,
      gameName: "Love",
      tagLine: "KV00",
      championPlays: 729,
      championWins: 399,
      tier: "MASTER",
    });
    expect(out[1].gameName).toBe("Splash");
    // A tagline containing a SPACE is real live data, not a hypothetical —
    // it must survive the quoted-string parse intact.
    expect(out[1].tagLine).toBe("0 1");
    expect(out[1].tier).toBe("CHALLENGER");
    expect(out[2].championPlays).toBe(661);
  });

  it("takes the FIRST tier_info when a player has several", () => {
    // Vork carries both DIAMOND and EMERALD entries; op.gg lists the current
    // solo-queue tier first. Reading the last one would report a stale rank.
    expect(parseLeaderboard(REAL_PAYLOAD, VIKTOR_ID)[2].tier).toBe("DIAMOND");
  });

  it("drops rows whose stat block is for a different champion", () => {
    // If this ever fires, we have misread the payload and the play count
    // would be "games on some other champion" — a plausible-but-wrong number.
    expect(parseLeaderboard(REAL_PAYLOAD, 103)).toEqual([]);
  });

  it("returns [] when the Leaderboard field set changes", () => {
    const reshaped = REAL_PAYLOAD.replace(
      "class Leaderboard: rank,summoner,most_champion_stat",
      "class Leaderboard: rank,summoner,most_champion_stat,extra"
    );
    expect(parseLeaderboard(reshaped, VIKTOR_ID)).toEqual([]);
  });

  it("returns [] when the MostChampionStat field set changes", () => {
    const reshaped = REAL_PAYLOAD.replace(
      "class MostChampionStat: id,play,win,lose,op_score",
      "class MostChampionStat: id,games,win,lose,op_score"
    );
    expect(parseLeaderboard(reshaped, VIKTOR_ID)).toEqual([]);
  });

  it("reads fields BY NAME, so a reordered declaration still parses correctly", () => {
    // op.gg's own analysis tool is live-verified to re-emit the same data with
    // a different field order (see lib/opgg.ts note 2). Positional indices
    // would read `win` as `play` here and render a wrong games count.
    const reordered = REAL_PAYLOAD.replace(
      "class MostChampionStat: id,play,win,lose,op_score",
      "class MostChampionStat: id,win,play,lose,op_score"
    )
      .replace("MostChampionStat(112,729,399,330,3830)", "MostChampionStat(112,399,729,330,3830)")
      .replace("MostChampionStat(112,722,402,320,4158)", "MostChampionStat(112,402,722,320,4158)")
      .replace("MostChampionStat(112,661,344,317,3723)", "MostChampionStat(112,344,661,317,3723)");
    const out = parseLeaderboard(reordered, VIKTOR_ID);
    expect(out[0].championPlays).toBe(729);
    expect(out[0].championWins).toBe(399);
  });

  it("keeps the candidate but drops the tier when TierInfo reshapes", () => {
    // Asymmetric on purpose: an unreadable tier is a missing LABEL, not a
    // reason to lose a real one-trick.
    const reshaped = REAL_PAYLOAD.replace(
      "class TierInfo: tier,division,lp",
      "class TierInfo: tier,division,lp,extra"
    );
    const out = parseLeaderboard(reshaped, VIKTOR_ID);
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.tier === null)).toBe(true);
  });

  it("returns [] for empty or non-string input", () => {
    expect(parseLeaderboard("", VIKTOR_ID)).toEqual([]);
    expect(parseLeaderboard(undefined as unknown as string, VIKTOR_ID)).toEqual([]);
  });
});

describe("buildLeaderboardRpc", () => {
  it("targets the leaderboard tool with the region and champion", () => {
    const rpc = buildLeaderboardRpc("EUW", "VIKTOR") as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(rpc.method).toBe("tools/call");
    expect(rpc.params.name).toBe("lol_list_champion_leaderboard");
    expect(rpc.params.arguments.region).toBe("EUW");
    expect(rpc.params.arguments.champion).toBe("VIKTOR");
    expect(rpc.params.arguments.desired_output_fields).toBeInstanceOf(Array);
  });
});

describe("fetchOtpCandidates", () => {
  it("parses a well-formed JSON-RPC envelope", async () => {
    const out = await fetchOtpCandidates("VIKTOR", VIKTOR_ID, "EUW", async () => ({
      result: { content: [{ type: "text", text: REAL_PAYLOAD }] },
    }));
    expect(out).toHaveLength(3);
  });

  it("returns [] on a JSON-RPC error (which arrives over HTTP 200)", async () => {
    const out = await fetchOtpCandidates("NOTACHAMP", VIKTOR_ID, "EUW", async () => ({
      error: { code: -32603, message: "Unknown champion provided." },
    }));
    expect(out).toEqual([]);
  });

  it("returns [] — never throws — when the transport fails", async () => {
    const out = await fetchOtpCandidates("VIKTOR", VIKTOR_ID, "EUW", async () => {
      throw new Error("network down");
    });
    expect(out).toEqual([]);
  });
});
