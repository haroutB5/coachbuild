import { describe, it, expect } from "vitest";
import type { AccountSummary } from "@/components/live/mystatsAccount";
import type { RankInput as RankInputLike } from "@/components/hextech/mystats/profileModel";
import type { MyStatsChampionRow } from "@/components/hextech/myStats";
import {
  isLiveGamePhase,
  buildProfileTabs,
  buildMostPlayedStrip,
  buildChampionPerformanceRows,
  csRateIsQuotable,
  formatRank,
  buildAccountCards,
  resolveAccountWinrate,
  computeLastActiveMs,
  formatRelativeTime,
  buildMatchPerformanceChips,
  formatPct,
  formatCsPerMin,
  formatCsNote,
  formatRegionChip,
  PROFILE_ACCOUNT_CARD_LIMIT,
} from "@/components/hextech/mystats/profileModel";

function champRow(over: Partial<MyStatsChampionRow> = {}): MyStatsChampionRow {
  return {
    championId: 112,
    role: 2,
    roleLabel: "Mid",
    name: "Viktor",
    icon: "https://cdn/champion/Viktor.webp",
    games: 15,
    wins: 8,
    losses: 7,
    winrate: 8 / 15,
    lowSample: false,
    csPerMin: 7.4,
    csGames: 13,
    ...over,
  };
}

function account(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 1,
    riotId: "MunsterHunter#EUW",
    gameName: "MunsterHunter",
    tagLine: "EUW",
    region: "euw1",
    active: true,
    lastSeenAt: null,
    games: 138,
    tier: "EMERALD",
    division: "II",
    lp: 47,
    rankWins: 61,
    rankLosses: 54,
    rankUnknown: false,
    rankCheckedAt: "2026-07-30T14:05:00.000Z",
    ...over,
  };
}

/** engy's UNKNOWN_RANK as it reaches the client — the state a linked-but-never-
 *  active account sits in, and the one that must never render as "Unranked". */
const UNKNOWN_RANK = {
  tier: null,
  division: null,
  lp: null,
  rankWins: null,
  rankLosses: null,
  rankUnknown: true,
  rankCheckedAt: null,
} as const;

// ── Live-game detection ─────────────────────────────────────────────────────

describe("isLiveGamePhase", () => {
  it("is live only while a game is actually running", () => {
    expect(isLiveGamePhase("InProgress")).toBe(true);
    expect(isLiveGamePhase("GameStart")).toBe(true);
  });

  it("is NOT live during champ select — picks are minutes away from a game", () => {
    expect(isLiveGamePhase("ChampSelect")).toBe(false);
    expect(isLiveGamePhase("ReadyCheck")).toBe(false);
    expect(isLiveGamePhase("Matchmaking")).toBe(false);
    expect(isLiveGamePhase("Lobby")).toBe(false);
  });

  it("is NOT live on the post-game screens", () => {
    expect(isLiveGamePhase("WaitingForStats")).toBe(false);
    expect(isLiveGamePhase("EndOfGame")).toBe(false);
  });

  // Silence is never evidence of a live game.
  it("never infers live from an absent or unknown phase", () => {
    expect(isLiveGamePhase(null)).toBe(false);
    expect(isLiveGamePhase(undefined)).toBe(false);
    expect(isLiveGamePhase("")).toBe(false);
    expect(isLiveGamePhase("None")).toBe(false);
    expect(isLiveGamePhase("SomethingRiotAddsLater")).toBe(false);
  });
});

// ── Tab strip ───────────────────────────────────────────────────────────────

describe("buildProfileTabs", () => {
  it("renders exactly the two tabs that lead somewhere real", () => {
    expect(buildProfileTabs().map((t) => t.value)).toEqual(["accounts", "history"]);
  });

  // The whole point of the tab-strip decision — a dead tab is a promise.
  // "Live Game" is here too: the companion provider exposes no live-game data,
  // so that tab could only restate the global nav's champ-select chip.
  it("never emits a Decay, VODs or Live Game tab", () => {
    const labels = buildProfileTabs().map((t) => t.label.toLowerCase());
    expect(labels).not.toContain("decay");
    expect(labels).not.toContain("vods");
    expect(labels).not.toContain("live game");
  });

  it("is shaped for HextechTabs so the ARIA keyboard contract is inherited, not rebuilt", () => {
    for (const tab of buildProfileTabs()) {
      expect(typeof tab.value).toBe("string");
      expect(typeof tab.label).toBe("string");
    }
  });
});

// ── Most-played portrait strip ──────────────────────────────────────────────

describe("buildMostPlayedStrip", () => {
  it("sums a champion across roles so the same face never appears twice", () => {
    const strip = buildMostPlayedStrip([
      champRow({ championId: 112, role: 2, games: 15 }),
      champRow({ championId: 112, role: 0, games: 4, roleLabel: "Top" }),
      champRow({ championId: 50, role: 2, games: 10, name: "Swain" }),
    ]);
    expect(strip.map((c) => c.championId)).toEqual([112, 50]);
    expect(strip[0].games).toBe(19);
  });

  it("re-sorts by the SUMMED total, not by the incoming per-role order", () => {
    // Swain leads on a single row (10 > 8) but Viktor wins once roles are summed.
    const strip = buildMostPlayedStrip([
      champRow({ championId: 50, role: 2, games: 10, name: "Swain" }),
      champRow({ championId: 112, role: 2, games: 8 }),
      champRow({ championId: 112, role: 0, games: 7, roleLabel: "Top" }),
    ]);
    expect(strip[0].championId).toBe(112);
    expect(strip[0].games).toBe(15);
  });

  it("caps at the limit and handles an empty pool", () => {
    const many = Array.from({ length: 9 }, (_, i) => champRow({ championId: i + 1, games: 20 - i }));
    expect(buildMostPlayedStrip(many)).toHaveLength(5);
    expect(buildMostPlayedStrip(many, 3)).toHaveLength(3);
    expect(buildMostPlayedStrip([])).toEqual([]);
    expect(buildMostPlayedStrip(many, 0)).toEqual([]);
  });
});

// ── Champion performance rows ───────────────────────────────────────────────

describe("buildChampionPerformanceRows", () => {
  it("keeps the server's order and does not re-sort", () => {
    const rows = buildChampionPerformanceRows([
      champRow({ championId: 112, games: 15 }),
      champRow({ championId: 50, games: 3, name: "Swain", lowSample: true }),
    ]);
    expect(rows.map((r) => r.championId)).toEqual([112, 50]);
  });

  it("carries engy's CS pair through untouched, denominator included", () => {
    const rows = buildChampionPerformanceRows([champRow({ csPerMin: 7.4, csGames: 13 })]);
    expect(rows[0].csPerMin).toBe(7.4);
    expect(rows[0].csGames).toBe(13);
  });

  it("keeps a null rate null rather than manufacturing a 0", () => {
    const rows = buildChampionPerformanceRows([champRow({ csPerMin: null, csGames: 0 })]);
    expect(rows[0].csPerMin).toBeNull();
  });

  it("carries lowSample through so the UI can mute an unreliable rate", () => {
    expect(buildChampionPerformanceRows([champRow({ lowSample: true })])[0].lowSample).toBe(true);
  });
});

describe("csRateIsQuotable", () => {
  it("quotes a rate backed by enough games", () => {
    expect(csRateIsQuotable(7.4, 13)).toBe(true);
    expect(csRateIsQuotable(7.4, 10)).toBe(true);
  });

  // engy §1b: csGames is routinely far smaller than games. A rate over 3 games
  // must not render like one over 300.
  it("refuses a rate over a thin denominator", () => {
    expect(csRateIsQuotable(7.4, 9)).toBe(false);
    expect(csRateIsQuotable(7.4, 0)).toBe(false);
  });

  it("refuses when there is no rate at all", () => {
    expect(csRateIsQuotable(null, 400)).toBe(false);
    expect(csRateIsQuotable(NaN, 400)).toBe(false);
  });

  it("quotes a genuine 0.0 CS/min — a real reading, not an absence", () => {
    expect(csRateIsQuotable(0, 40)).toBe(true);
  });
});

describe("formatCsNote (2026-07-31 audit P2 re-score follow-up)", () => {
  it("no CS recorded at all", () => {
    expect(formatCsNote(0, 20)).toBe("no CS recorded");
  });

  it("a genuine subset -- csGames smaller than the real season total -- says 'only'", () => {
    expect(formatCsNote(15, 20)).toBe("only 15g with CS");
  });

  // Live bug (2026-07-31): an account with exactly 2 games this season, BOTH
  // carrying CS, read "only 2g with CS" -- "only" out of what, when 2 IS the
  // whole season? Full coverage must never say "only", regardless of how small
  // the count is.
  it("full coverage -- csGames equals the total season games -- drops 'only' even when the count is tiny", () => {
    expect(formatCsNote(2, 2)).toBe("2g this season");
    expect(formatCsNote(1, 1)).toBe("1g this season");
  });

  it("csGames somehow exceeding the total (defensive) is still treated as full coverage, never 'only'", () => {
    expect(formatCsNote(5, 3)).toBe("5g this season");
  });

  it("uses the coverage-aware season phrase when history is still collecting", () => {
    expect(formatCsNote(2, 2, "so far this season")).toBe("2g so far this season");
  });
});

// ── Ranked standing ─────────────────────────────────────────────────────────

describe("formatRank", () => {
  // The single most important distinction in this ship.
  it("distinguishes 'never read' from 'genuinely unranked'", () => {
    const unknown = formatRank({ ...UNKNOWN_RANK });
    const unranked = formatRank({ ...UNKNOWN_RANK, rankUnknown: false });
    expect(unknown.state).toBe("unknown");
    expect(unranked.state).toBe("unranked");
    expect(unknown.label).not.toBe(unranked.label);
  });

  it("never renders a blank label in any state", () => {
    const cases: RankInputLike[] = [
      { ...UNKNOWN_RANK },
      { ...UNKNOWN_RANK, rankUnknown: false },
      { tier: "EMERALD", division: "II", lp: 47, rankWins: 61, rankLosses: 54, rankUnknown: false, rankCheckedAt: null },
    ];
    for (const c of cases) expect(formatRank(c).label.length).toBeGreaterThan(0);
  });

  it("says 'not synced', never 'Unranked', for an unread account", () => {
    expect(formatRank({ ...UNKNOWN_RANK }).label.toLowerCase()).not.toContain("unranked");
  });

  it("formats a normal tier with its division and LP", () => {
    const r = formatRank({ tier: "EMERALD", division: "II", lp: 47, rankWins: 61, rankLosses: 54, rankUnknown: false, rankCheckedAt: null });
    expect(r).toMatchObject({ state: "ranked", label: "Emerald II", lp: "47 LP", record: "61W 54L" });
  });

  // Riot always sends "I" for the apex tiers, where it means nothing.
  it("drops the meaningless division on Master, Grandmaster and Challenger", () => {
    for (const tier of ["MASTER", "GRANDMASTER", "CHALLENGER"]) {
      const r = formatRank({ tier, division: "I", lp: 412, rankWins: 200, rankLosses: 180, rankUnknown: false, rankCheckedAt: null });
      expect(r.label).not.toContain(" I");
      expect(r.lp).toBe("412 LP");
    }
    expect(formatRank({ tier: "CHALLENGER", division: "I", lp: 1, rankWins: null, rankLosses: null, rankUnknown: false, rankCheckedAt: null }).label).toBe("Challenger");
  });

  it("survives a missing division or LP on a real tier", () => {
    const r = formatRank({ tier: "GOLD", division: null, lp: null, rankWins: null, rankLosses: null, rankUnknown: false, rankCheckedAt: null });
    expect(r).toMatchObject({ state: "ranked", label: "Gold", lp: null, record: null });
  });

  it("mentions the last-read timestamp so nothing implies a live reading", () => {
    const r = formatRank({ tier: "GOLD", division: "I", lp: 0, rankWins: 1, rankLosses: 1, rankUnknown: false, rankCheckedAt: "2026-07-30T14:05:00.000Z" });
    expect(r.title).toContain("2026-07-30T14:05:00.000Z");
  });

  it("renders a real 0 LP rather than treating it as missing", () => {
    expect(formatRank({ tier: "SILVER", division: "IV", lp: 0, rankWins: 0, rankLosses: 0, rankUnknown: false, rankCheckedAt: null }).lp).toBe("0 LP");
  });
});

// ── Account cards ───────────────────────────────────────────────────────────

describe("buildAccountCards", () => {
  it("renders both linked accounts with no truncation and offers linking", () => {
    // The real shape of this install: two accounts, nothing hidden, so a
    // "Show all" would be a button that does nothing.
    const model = buildAccountCards([account(), account({ id: 2, riotId: "K1ayer#swift", gameName: "K1ayer", tagLine: "swift", active: false, games: 12 })]);
    expect(model.cards).toHaveLength(2);
    expect(model.hiddenCount).toBe(0);
    expect(model.action).toBe("link-another");
    expect(model.cards[0].active).toBe(true);
    expect(model.cards[1].active).toBe(false);
  });

  it("splits the riot id when gameName/tagLine are empty", () => {
    const [card] = buildAccountCards([account({ gameName: "", tagLine: "" })]).cards;
    expect(card.gameName).toBe("MunsterHunter");
    expect(card.tagLine).toBe("EUW");
  });

  it("truncates past the limit and switches the trailing cell to show-all", () => {
    const many = Array.from({ length: 8 }, (_, i) => account({ id: i + 1, active: i === 0 }));
    const model = buildAccountCards(many);
    expect(model.cards).toHaveLength(PROFILE_ACCOUNT_CARD_LIMIT);
    expect(model.hiddenCount).toBe(3);
    expect(model.action).toBe("show-all");
  });

  it("expanded shows everything but keeps the show-all affordance meaningful", () => {
    const many = Array.from({ length: 8 }, (_, i) => account({ id: i + 1 }));
    const model = buildAccountCards(many, { expanded: true });
    expect(model.cards).toHaveLength(8);
    expect(model.hiddenCount).toBe(0);
    expect(model.action).toBe("show-all");
  });

  it("carries a real ranked standing onto the card", () => {
    const [card] = buildAccountCards([account()]).cards;
    expect(card.rank).toMatchObject({ state: "ranked", label: "Emerald II", lp: "47 LP" });
  });

  // The inactive account is the normal case for this: a Riot call is only ever
  // spent on the ACTIVE account, so the second card is routinely unknown.
  it("shows an un-read account as not-synced, never as Unranked", () => {
    const model = buildAccountCards([
      account(),
      account({ id: 2, riotId: "K1ayer#swift", gameName: "K1ayer", tagLine: "swift", active: false, games: 12, ...UNKNOWN_RANK }),
    ]);
    expect(model.cards[1].rank.state).toBe("unknown");
    expect(model.cards[1].rank.label.toLowerCase()).not.toContain("unranked");
  });

  it("handles zero accounts", () => {
    const model = buildAccountCards([]);
    expect(model.cards).toEqual([]);
    expect(model.hiddenCount).toBe(0);
    expect(model.action).toBe("link-another");
  });
});

// ── Last active ─────────────────────────────────────────────────────────────

describe("computeLastActiveMs", () => {
  it("takes the newest parseable timestamp", () => {
    const ms = computeLastActiveMs([
      { lastPlayed: "2026-07-28T10:00:00.000Z" },
      { lastPlayed: "2026-07-30T09:00:00.000Z" },
      { lastPlayed: "2026-07-29T10:00:00.000Z" },
    ]);
    expect(ms).toBe(Date.parse("2026-07-30T09:00:00.000Z"));
  });

  it("skips unparseable entries rather than poisoning the result", () => {
    expect(computeLastActiveMs([{ lastPlayed: "" }, { lastPlayed: "2026-07-30T09:00:00.000Z" }])).toBe(
      Date.parse("2026-07-30T09:00:00.000Z")
    );
  });

  it("returns null when there is nothing to read", () => {
    expect(computeLastActiveMs([])).toBeNull();
    expect(computeLastActiveMs([{ lastPlayed: "not a date" }])).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const ago = (ms: number) => formatRelativeTime(now - ms, now);

  it("matches the reference's phrasing", () => {
    expect(ago(33 * 60_000)).toBe("33 minutes ago");
  });

  it("singularises", () => {
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(60 * 60_000)).toBe("1 hour ago");
    expect(ago(24 * 60 * 60_000)).toBe("1 day ago");
  });

  it("steps up through the units", () => {
    expect(ago(30_000)).toBe("just now");
    expect(ago(90 * 60_000)).toBe("1 hour ago");
    expect(ago(3 * 24 * 60 * 60_000)).toBe("3 days ago");
    expect(ago(45 * 24 * 60 * 60_000)).toBe("1 month ago");
    expect(ago(400 * 24 * 60 * 60_000)).toBe("1 year ago");
  });

  it("reads a future timestamp as 'just now' instead of counting up", () => {
    // Clock skew between the browser and Riot's gameCreation is real; "in 4
    // minutes" under a Last Active label reads as a bug.
    expect(formatRelativeTime(now + 4 * 60_000, now)).toBe("just now");
  });

  it("null in, null out — the caller renders nothing, never 'never'", () => {
    expect(formatRelativeTime(null, now)).toBeNull();
    expect(formatRelativeTime(NaN, now)).toBeNull();
  });
});

// ── Match-performance chips ─────────────────────────────────────────────────

describe("buildMatchPerformanceChips", () => {
  const rank: RankInputLike = { ...UNKNOWN_RANK };

  it("counts wins and losses over exactly the window passed in", () => {
    const chips = buildMatchPerformanceChips([{ win: true }, { win: true }, { win: false }], rank);
    expect(chips).toMatchObject({ wins: 2, losses: 1, n: 3 });
  });

  it("flags a thin window", () => {
    expect(buildMatchPerformanceChips([{ win: true }], rank).lowSample).toBe(true);
    expect(buildMatchPerformanceChips(Array.from({ length: 20 }, () => ({ win: true })), rank).lowSample).toBe(false);
  });

  // MVP/ACE are uncomputable without storing a full scoreboard for nine other
  // players — dropped from the model entirely, so they cannot be rendered.
  it("carries no MVP or ACE field at all", () => {
    const chips = buildMatchPerformanceChips([{ win: true }], rank);
    expect(Object.keys(chips).sort()).toEqual(["losses", "lowSample", "n", "rank", "wins"]);
  });

  it("attaches the ranked standing through the one shared formatter", () => {
    const chips = buildMatchPerformanceChips([{ win: true }], {
      tier: "EMERALD", division: "II", lp: 47, rankWins: 61, rankLosses: 54, rankUnknown: false, rankCheckedAt: null,
    });
    expect(chips.rank).toMatchObject({ state: "ranked", label: "Emerald II" });
  });

  it("handles an empty window without dividing by anything", () => {
    expect(buildMatchPerformanceChips([], rank)).toMatchObject({ wins: 0, losses: 0, n: 0 });
  });
});

// ── Formatters ──────────────────────────────────────────────────────────────

describe("formatters", () => {
  it("formats a percentage to one decimal", () => {
    expect(formatPct(0.526)).toBe("52.6%");
    expect(formatPct(0)).toBe("0.0%");
    expect(formatPct(1)).toBe("100.0%");
  });

  it("formats CS/min to one decimal, and null stays null", () => {
    expect(formatCsPerMin(7.42)).toBe("7.4");
    expect(formatCsPerMin(0)).toBe("0.0");
    expect(formatCsPerMin(null)).toBeNull();
    expect(formatCsPerMin(NaN)).toBeNull();
  });

  it("upper-cases a region and omits an empty one", () => {
    expect(formatRegionChip("euw1")).toBe("EUW1");
    expect(formatRegionChip("  ")).toBeNull();
    expect(formatRegionChip("")).toBeNull();
  });
});

// ── Per-account win rate ────────────────────────────────────────────────────
//
// The field name on the wire landed in a parallel lane, so the resolver accepts
// more than one shape. These tests pin the two things that must not drift: the
// PRECEDENCE (a count beats a rate, because a count cannot be misread as a
// percentage) and the REFUSALS (anything that could be a percentage in a
// fraction's clothing resolves to null, not to a number).

describe("resolveAccountWinrate", () => {
  it("prefers a wins COUNT and reports the real W-L in the title", () => {
    const r = resolveAccountWinrate({ games: 100, wins: 55 });
    expect(r.pct).toBeCloseTo(0.55, 10);
    expect(r.wins).toBe(55);
    expect(r.games).toBe(100);
    expect(r.title).toContain("55W 45L");
  });

  it("takes a 0-1 fraction when there is no count, and never back-derives wins", () => {
    const r = resolveAccountWinrate({ games: 141, winrate: 0.5106 });
    expect(r.pct).toBeCloseTo(0.5106, 10);
    // NOT Math.round(0.5106 * 141) — a rounded fiction printed as a real W-L.
    expect(r.wins).toBeNull();
  });

  it("accepts the winRate alias", () => {
    expect(resolveAccountWinrate({ games: 40, winRate: 0.25 }).pct).toBeCloseTo(0.25, 10);
  });

  it("REFUSES a percentage arriving in a fraction's field", () => {
    // 52 in a field documented as 0-1 is a unit mismatch. It is not a 5200% win
    // rate, and we have not earned the right to call it 52% either — so we say
    // nothing rather than divide by 100 on a hunch.
    expect(resolveAccountWinrate({ games: 100, winrate: 52 }).pct).toBeNull();
  });

  it("refuses a wins count larger than the denominator", () => {
    expect(resolveAccountWinrate({ games: 10, wins: 11 }).pct).toBeNull();
  });

  it("returns null — never 0% — when the response carried no rate at all", () => {
    const r = resolveAccountWinrate({ games: 138 });
    expect(r.pct).toBeNull();
    expect(r.games).toBe(0);
  });

  it("keeps a real 0% and a real 100% rather than treating them as absent", () => {
    expect(resolveAccountWinrate({ games: 20, wins: 0 }).pct).toBe(0);
    expect(resolveAccountWinrate({ games: 20, wins: 20 }).pct).toBe(1);
  });

  it("has no rate at all when there are no games to divide by", () => {
    expect(resolveAccountWinrate({ games: 0, wins: 0 }).pct).toBeNull();
  });

  it("flags a thin denominator so the card can withhold the good/bad colour", () => {
    expect(resolveAccountWinrate({ games: 3, wins: 2 }).lowSample).toBe(true);
    expect(resolveAccountWinrate({ games: 141, wins: 72 }).lowSample).toBe(false);
  });
});

describe("buildAccountCards — win rate", () => {
  it("puts each account's OWN win rate on its own card", () => {
    const model = buildAccountCards([
      account({ games: 141, wins: 72 }),
      account({ id: 2, riotId: "K1ayer#swift", active: false, games: 28, wins: 11 }),
    ]);
    expect(model.cards[0].record.pct).toBeCloseTo(72 / 141, 10);
    expect(model.cards[1].record.pct).toBeCloseTo(11 / 28, 10);
  });

  it("renders nothing rather than a zero when the wire has no rate yet", () => {
    expect(buildAccountCards([account()]).cards[0].record.pct).toBeNull();
  });
});
