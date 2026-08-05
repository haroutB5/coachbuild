/**
 * Tests for lib/pro/extract.ts — patch parsing, purchase-order undo handling,
 * skill-order dedupe (the documented 15.17+ duplicate-event bug), rune
 * extraction, and role-skip behavior. Pure functions — no network/DB.
 */
import { describe, it, expect } from "vitest";
import {
  patchFromGameVersion,
  buildPurchaseOrder,
  buildSkillOrder,
  extractRunes,
  extractMatch,
  extractGameStats,
  extractTeamComps,
  extractTeamPlayers,
  orderChampionIdsByRole,
  orderByRole,
} from "../pro/extract";
import type { RiotMatch, RiotParticipant, RiotTimeline } from "../pro/types";

function participant(overrides: Partial<RiotParticipant> = {}): RiotParticipant {
  return {
    puuid: "puuid-1",
    participantId: 1,
    teamId: 100,
    championId: 112,
    championName: "Viktor",
    teamPosition: "MIDDLE",
    win: true,
    kills: 5,
    deaths: 2,
    assists: 7,
    totalMinionsKilled: 180,
    neutralMinionsKilled: 20,
    totalDamageDealtToChampions: 22000,
    goldEarned: 13500,
    item0: 6655,
    item1: 4645,
    item2: 3020,
    item3: 0,
    item4: 0,
    item5: 0,
    item6: 3364,
    summoner1Id: 4,
    summoner2Id: 14,
    perks: {
      statPerks: { defense: 5001, flex: 5008, offense: 5008 },
      styles: [
        {
          description: "primaryStyle",
          style: 8200,
          selections: [{ perk: 8210 }, { perk: 8226 }, { perk: 8210 }, { perk: 8237 }],
        },
        {
          description: "subStyle",
          style: 8300,
          selections: [{ perk: 8345 }, { perk: 8347 }],
        },
      ],
    },
    ...overrides,
  };
}

function match(overrides: Partial<RiotMatch["info"]> = {}, participants?: RiotParticipant[]): RiotMatch {
  return {
    metadata: { matchId: "EUW1_123" },
    info: {
      gameCreation: 1752000000000,
      gameDuration: 1800,
      gameVersion: "16.13.567.1234",
      participants: participants ?? [participant()],
      ...overrides,
    },
  };
}

function timeline(events: RiotTimeline["info"]["frames"][number]["events"] = []): RiotTimeline {
  return { info: { frames: [{ timestamp: 0, events }] } };
}

function levelTimeline(rLevels: readonly number[], lastLevel: number): RiotTimeline {
  const rSet = new Set(rLevels);
  let basicSlot = 1;
  const events = Array.from({ length: lastLevel }, (_, i) => {
    const level = i + 1;
    const skillSlot = rSet.has(level) ? 4 : basicSlot;
    if (!rSet.has(level)) basicSlot = basicSlot === 3 ? 1 : basicSlot + 1;
    return {
      type: "SKILL_LEVEL_UP",
      participantId: 1,
      skillSlot,
      levelUpType: "NORMAL",
      timestamp: level * 100,
    };
  });
  return timeline(events);
}

describe("patchFromGameVersion", () => {
  it("keeps only major.minor", () => {
    expect(patchFromGameVersion("16.13.567.1234")).toBe("16.13");
    expect(patchFromGameVersion("14.1.1.1")).toBe("14.1");
  });
});

describe("buildPurchaseOrder", () => {
  it("keeps chronological purchases including consumables/wards, ts converted ms->seconds", () => {
    const tl = timeline([
      { type: "ITEM_PURCHASED", participantId: 1, itemId: 1054, timestamp: 65000 },
      { type: "ITEM_PURCHASED", participantId: 1, itemId: 2003, timestamp: 200000 },
      { type: "ITEM_PURCHASED", participantId: 2, itemId: 9999, timestamp: 250000 }, // other participant, ignored
    ]);
    expect(buildPurchaseOrder(tl, 1)).toEqual([
      { itemId: 1054, ts: 65 },
      { itemId: 2003, ts: 200 },
    ]);
  });

  it("removes the undone purchase on ITEM_UNDO (must handle)", () => {
    const tl = timeline([
      { type: "ITEM_PURCHASED", participantId: 1, itemId: 1054, timestamp: 100000 },
      { type: "ITEM_PURCHASED", participantId: 1, itemId: 1058, timestamp: 200000 },
      { type: "ITEM_UNDO", participantId: 1, beforeId: 1058, afterId: 0, timestamp: 210000 },
      { type: "ITEM_PURCHASED", participantId: 1, itemId: 3020, timestamp: 300000 },
    ]);
    expect(buildPurchaseOrder(tl, 1)).toEqual([
      { itemId: 1054, ts: 100 },
      { itemId: 3020, ts: 300 },
    ]);
  });

  it("ITEM_SOLD does not remove from the purchase log (it's a build-order log, not live inventory)", () => {
    const tl = timeline([
      { type: "ITEM_PURCHASED", participantId: 1, itemId: 1054, timestamp: 100000 },
      { type: "ITEM_SOLD", participantId: 1, itemId: 1054, timestamp: 500000 },
    ]);
    expect(buildPurchaseOrder(tl, 1)).toEqual([{ itemId: 1054, ts: 100 }]);
  });

  it("undo with no matching prior purchase is a no-op (defensive)", () => {
    const tl = timeline([{ type: "ITEM_UNDO", participantId: 1, beforeId: 9999, timestamp: 50000 }]);
    expect(buildPurchaseOrder(tl, 1)).toEqual([]);
  });
});

describe("buildSkillOrder", () => {
  it("maps skillSlot to Q/W/E/R in timestamp order", () => {
    const tl = timeline([
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 1, levelUpType: "NORMAL", timestamp: 100 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 2, levelUpType: "NORMAL", timestamp: 200 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 1, levelUpType: "NORMAL", timestamp: 300 },
    ]);
    expect(buildSkillOrder(tl, 1)).toEqual(["Q", "W", "Q"]);
  });

  it("dedupes exact-duplicate SKILL_LEVEL_UP events (15.17+ known bug)", () => {
    const tl = timeline([
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 1, levelUpType: "NORMAL", timestamp: 100 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 1, levelUpType: "NORMAL", timestamp: 100 }, // exact dupe
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 2, levelUpType: "NORMAL", timestamp: 200 },
    ]);
    expect(buildSkillOrder(tl, 1)).toEqual(["Q", "W"]);
  });

  it("ignores interleaved EVOLVE events without shifting later NORMAL events", () => {
    const tl = timeline([
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 1, levelUpType: "NORMAL", timestamp: 100 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 3, levelUpType: "EVOLVE", timestamp: 150 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 2, timestamp: 200 }, // missing type = NORMAL
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 1, levelUpType: "EVOLVE", timestamp: 250 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 3, levelUpType: "NORMAL", timestamp: 300 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 4, levelUpType: "EVOLVE", timestamp: 350 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 4, levelUpType: "NORMAL", timestamp: 400 },
    ]);
    expect(buildSkillOrder(tl, 1)).toEqual(["Q", "W", "E", "R"]);
  });

  it("keeps Viego R at legal positions 6/11/16 instead of first-arrival positions", () => {
    const order = buildSkillOrder(
      levelTimeline([6, 7, 8, 9, 11, 15, 16], 16),
      1,
      { championId: 234, championName: "Viego" }
    );
    expect(order.filter((ability) => ability === "R")).toHaveLength(3);
    // The compact output has no holes for skipped phantoms; the source event
    // positions represented here are still levels 6, 11, and 16.
    expect(order).toEqual(["Q", "W", "E", "Q", "W", "R", "E", "R", "Q", "W", "E", "R"]);
  });

  it("drops a standard-ultimate R event at level 5", () => {
    const order = buildSkillOrder(levelTimeline([5], 5), 1, { championId: 234, championName: "Viego" });
    expect(order).not.toContain("R");
  });

  it("keeps a banked-point R taken at level 8", () => {
    const order = buildSkillOrder(levelTimeline([8], 8), 1, { championId: 234, championName: "Viego" });
    expect(order[7]).toBe("R");
  });

  it("keeps all six Udyr R events because R is a six-rank basic-like slot", () => {
    const tl = timeline(
      Array.from({ length: 6 }, (_, i) => ({
        type: "SKILL_LEVEL_UP",
        participantId: 1,
        skillSlot: 4,
        levelUpType: "NORMAL",
        timestamp: (i + 1) * 100,
      }))
    );
    expect(buildSkillOrder(tl, 1, { championId: 77, championName: "Udyr" })).toHaveLength(6);
  });

  it("uses the R4 form-swap schedule and leaves the R1 auto-R shape ungated", () => {
    const formOrder = buildSkillOrder(
      levelTimeline([6, 11, 16], 16),
      1,
      { championId: 60, championName: "Elise" }
    );
    expect(formOrder.filter((ability) => ability === "R")).toHaveLength(3);
    expect(formOrder).toEqual(buildSkillOrder(levelTimeline([6, 11, 16], 16), 1, { championId: 60, championName: "Elise" }));

    const jayceTimeline = timeline([
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 4, levelUpType: "NORMAL", timestamp: 100 },
      { type: "SKILL_LEVEL_UP", participantId: 1, skillSlot: 4, levelUpType: "NORMAL", timestamp: 200 },
    ]);
    expect(buildSkillOrder(jayceTimeline, 1, { championId: 126, championName: "Jayce" })).toEqual(["R"]);
  });

  it("keeps the standard cap for a measured champion and stores fallback kits raw", () => {
    const tl = levelTimeline([6, 11, 16, 17], 17);
    expect(buildSkillOrder(tl, 1, { championId: 234, championName: "Viego" }).filter((a) => a === "R")).toHaveLength(3);
    // Viktor is not in the measured synchronous table: the compatibility
    // STANDARD_KIT fallback must not silently clip a future rework.
    expect(buildSkillOrder(tl, 1, { championId: 112, championName: "Viktor" }).filter((a) => a === "R")).toHaveLength(4);
    // No identity still means the pre-guard behavior.
    expect(buildSkillOrder(tl, 1).filter((a) => a === "R")).toHaveLength(4);
    expect(buildSkillOrder(tl, 1, { championId: 234, championName: "Viego", kit: null }).filter((a) => a === "R")).toHaveLength(4);
  });

  it("caps at 18 entries as a second safety net", () => {
    const events = Array.from({ length: 25 }, (_, i) => ({
      type: "SKILL_LEVEL_UP",
      participantId: 1,
      skillSlot: 1,
      levelUpType: "NORMAL",
      timestamp: i * 10, // distinct timestamps -> not deduped by key
    }));
    const tl = timeline(events);
    expect(buildSkillOrder(tl, 1)).toHaveLength(18);
  });
});

describe("extractRunes", () => {
  it("splits keystone from the remaining 3 primary runes, and reads shards in offense/flex/defense order", () => {
    const runes = extractRunes(participant());
    expect(runes).toEqual({
      primaryTree: 8200,
      keystone: 8210,
      primary: [8226, 8210, 8237],
      secondaryTree: 8300,
      secondary: [8345, 8347],
      shards: [5008, 5008, 5001],
    });
  });
});

describe("extractMatch", () => {
  it("returns null when the participant's role can't be mapped (never store a guessed role)", () => {
    const m = match({}, [participant({ teamPosition: "" })]);
    expect(extractMatch(m, timeline(), "puuid-1")).toBeNull();
  });

  it("returns null when the puuid isn't in the match", () => {
    const m = match();
    expect(extractMatch(m, timeline(), "someone-else")).toBeNull();
  });

  it("filters 0s out of finalItems and nulls an empty trinket slot", () => {
    const m = match({}, [participant({ item3: 0, item4: 0, item5: 0, item6: 0 })]);
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.finalItems).toEqual([6655, 4645, 3020]);
    expect(row?.trinket).toBeNull();
  });

  it("maps role, patch, and spells correctly for a full row", () => {
    const m = match();
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row).toMatchObject({
      matchId: "EUW1_123",
      championId: 112,
      role: 2, // MIDDLE
      patch: "16.13",
      spells: [4, 14],
      win: true,
    });
  });

  it("threads the participant champion into the skill-order cap guard", () => {
    const m = match({}, [participant({ championId: 234, championName: "Viego" })]);
    const row = extractMatch(m, levelTimeline([6, 11, 16], 16), "puuid-1");
    expect(row?.skillOrder.filter((a) => a === "R")).toHaveLength(3);
  });

  it("computes cs/damage/gold from the participant and teamKills from same-team participants only", () => {
    const teammate = participant({
      puuid: "puuid-2",
      participantId: 2,
      teamId: 100,
      kills: 3,
    });
    const enemy = participant({
      puuid: "puuid-3",
      participantId: 3,
      teamId: 200,
      kills: 9, // must NOT count toward puuid-1's teamKills
    });
    const m = match({}, [participant(), teammate, enemy]);
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.cs).toBe(200); // 180 + 20
    expect(row?.damageChampions).toBe(22000);
    expect(row?.gold).toBe(13500);
    expect(row?.teamKills).toBe(8); // 5 (self) + 3 (teammate), enemy's 9 excluded
  });
});

describe("extractTeamComps", () => {
  // P3(a) fix (2026-07-17): each side must role-resolve CLEANLY (5 distinct
  // known roles) or extractTeamComps now omits the whole comps object — so
  // this fixture assigns explicit, DISTINCT teamPositions in TOP/JUNGLE/
  // MIDDLE/BOTTOM/UTILITY array order (self stays at index 0 = TOP so the
  // existing [112, 2, 3, 4, 5] expected array is unchanged: source order
  // happens to equal role order here by construction). Before this fix, the
  // helper left every participant on the base fixture's default "MIDDLE"
  // teamPosition — a degenerate (duplicate-role) input that only coincided
  // with "in source order" because of orderByRole's OLD fallback behavior.
  function fullTenParticipants(): RiotParticipant[] {
    // puuid-1 (self, championId 112) + 4 allies on teamId 100, 5 enemies on teamId 200.
    return [
      participant({ teamPosition: "TOP" }), // puuid-1, teamId 100, championId 112
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "JUNGLE" }),
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "MIDDLE" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
  }

  it("splits a clean 5v5 match into ally (incl. self) + enemy champion ids, role-ordered (source order here by construction)", () => {
    const m = match({}, fullTenParticipants());
    expect(extractTeamComps(m, "puuid-1")).toEqual({
      allyChampionIds: [112, 2, 3, 4, 5],
      enemyChampionIds: [6, 7, 8, 9, 10],
    });
  });

  it("returns null when the puuid isn't in the match", () => {
    const m = match({}, fullTenParticipants());
    expect(extractTeamComps(m, "someone-else")).toBeNull();
  });

  it("returns null when either side doesn't have exactly 5 champions (never store a partial side)", () => {
    const short = fullTenParticipants().slice(0, 9); // only 4 enemies
    const m = match({}, short);
    expect(extractTeamComps(m, "puuid-1")).toBeNull();
  });

  it("role-sorts each side into Top/Jungle/Mid/Bot/Support order regardless of source order — the mid-laner's champion lands at index 2", () => {
    const participants = [
      participant({ puuid: "ally-jgl", participantId: 2, teamId: 100, championId: 21, teamPosition: "JUNGLE" }),
      participant({ teamPosition: "MIDDLE" }), // self, puuid-1, championId 112 (default)
      participant({ puuid: "ally-top", participantId: 3, teamId: 100, championId: 23, teamPosition: "TOP" }),
      participant({ puuid: "ally-sup", participantId: 4, teamId: 100, championId: 24, teamPosition: "UTILITY" }),
      participant({ puuid: "ally-bot", participantId: 5, teamId: 100, championId: 25, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-sup", participantId: 6, teamId: 200, championId: 34, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-top", participantId: 7, teamId: 200, championId: 31, teamPosition: "TOP" }),
      participant({ puuid: "enemy-jgl", participantId: 8, teamId: 200, championId: 32, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-bot", participantId: 9, teamId: 200, championId: 35, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-mid", participantId: 10, teamId: 200, championId: 33, teamPosition: "MIDDLE" }),
    ];
    const m = match({}, participants);
    const comps = extractTeamComps(m, "puuid-1");
    expect(comps?.allyChampionIds).toEqual([23, 21, 112, 25, 24]); // TOP JUNGLE MID BOT SUPPORT
    expect(comps?.allyChampionIds?.[2]).toBe(112); // self (mid) at index 2
    expect(comps?.enemyChampionIds).toEqual([31, 32, 33, 35, 34]);
  });

  it("P3(a) fix: omits comps ENTIRELY (both sides null) when a side has a duplicate role — never a reordered-lie array a consumer would index by role", () => {
    // Regression for the 2026-07-17 Fable review finding: consumers index
    // enemyChampionIds[role] to find "the enemy laner in my role" — a
    // source-ordered (unsorted) array under that same field name silently
    // produced a WRONG laner with no signal anything had degraded.
    const participants = [
      participant({ teamPosition: "MIDDLE" }), // self, championId 112
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "MIDDLE" }), // dup MID
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "TOP" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
    const m = match({}, participants);
    expect(extractTeamComps(m, "puuid-1")).toBeNull();
  });

  it("P3(a) fix: omits comps entirely when a side has an unresolved (empty) teamPosition, even though the OTHER side is clean (both-or-neither)", () => {
    const participants = [
      participant({ teamPosition: "" }), // self, championId 112, unresolved role
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "JUNGLE" }),
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "TOP" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
    const m = match({}, participants);
    // enemy side alone would resolve cleanly, but the ally side's degrade
    // must sink the WHOLE comps object, not just its own side.
    expect(extractTeamComps(m, "puuid-1")).toBeNull();
  });
});

describe("orderChampionIdsByRole", () => {
  it("sorts entries by role 0-4 when exactly 5 distinct known roles are present", () => {
    expect(
      orderChampionIdsByRole([
        { championId: 1, role: 2 },
        { championId: 2, role: 0 },
        { championId: 3, role: 4 },
        { championId: 4, role: 1 },
        { championId: 5, role: 3 },
      ])
    ).toEqual([2, 4, 1, 5, 3]);
  });

  it("falls back to input order when any role is null/undefined", () => {
    expect(
      orderChampionIdsByRole([
        { championId: 1, role: 0 },
        { championId: 2, role: null },
        { championId: 3, role: 2 },
      ])
    ).toEqual([1, 2, 3]);
    expect(
      orderChampionIdsByRole([
        { championId: 1, role: 0 },
        { championId: 2, role: undefined },
        { championId: 3, role: 2 },
      ])
    ).toEqual([1, 2, 3]);
  });

  it("falls back to input order on a duplicate role", () => {
    expect(
      orderChampionIdsByRole([
        { championId: 1, role: 0 },
        { championId: 2, role: 0 },
        { championId: 3, role: 2 },
        { championId: 4, role: 3 },
        { championId: 5, role: 4 },
      ])
    ).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("extractMatch team comps integration", () => {
  // See extractTeamComps describe block's fullTenParticipants doc comment —
  // same P3(a) rationale: distinct teamPositions per participant are
  // required for a "clean" (non-degraded) 5v5 fixture now.
  function fullTenParticipants(): RiotParticipant[] {
    return [
      participant({ teamPosition: "TOP" }),
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "JUNGLE" }),
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "MIDDLE" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
  }

  it("populates allyChampionIds/enemyChampionIds on a full 5v5 row", () => {
    const m = match({}, fullTenParticipants());
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.allyChampionIds).toEqual([112, 2, 3, 4, 5]);
    expect(row?.enemyChampionIds).toEqual([6, 7, 8, 9, 10]);
  });

  it("nulls both fields when the match isn't a clean 5v5 (e.g. only 1 participant)", () => {
    const m = match({}, [participant()]);
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.allyChampionIds).toBeNull();
    expect(row?.enemyChampionIds).toBeNull();
  });

  it("P3(a) fix: nulls both fields when a side degrades (5 participants, but not 5 distinct roles) rather than storing a role-position-wrong array", () => {
    const participants = [
      participant({ teamPosition: "MIDDLE" }), // self, championId 112
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "MIDDLE" }), // dup MID
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "TOP" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
    const m = match({}, participants);
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.allyChampionIds).toBeNull();
    expect(row?.enemyChampionIds).toBeNull();
    expect(row?.allyPlayers).toBeNull();
    expect(row?.enemyPlayers).toBeNull();
  });
});

describe("orderByRole (generic form backing orderChampionIdsByRole)", () => {
  it("reorders arbitrary entries by role and preserves the rest of the shape", () => {
    const entries = [
      { championId: 1, role: 2, tag: "mid" },
      { championId: 2, role: 0, tag: "top" },
    ];
    expect(orderByRole(entries)).toEqual([
      { championId: 2, role: 0, tag: "top" },
      { championId: 1, role: 2, tag: "mid" },
    ]);
  });

  it("falls back to input order (a shallow copy, not the same array reference) on a degrade condition", () => {
    const entries = [
      { championId: 1, role: 0 },
      { championId: 2, role: null },
    ];
    const result = orderByRole(entries);
    expect(result).toEqual(entries);
    expect(result).not.toBe(entries);
  });
});

describe("extractTeamPlayers", () => {
  function fullTenParticipants(overrides: Partial<RiotParticipant>[] = []): RiotParticipant[] {
    const base = [
      participant(), // puuid-1, teamId 100, championId 112, MIDDLE
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "TOP" }),
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "JUNGLE" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
    return base.map((p, i) => ({ ...p, ...(overrides[i] ?? {}) }));
  }

  it("returns null when the puuid isn't in the match", () => {
    const m = match({}, fullTenParticipants());
    expect(extractTeamPlayers(m, "someone-else")).toBeNull();
  });

  it("returns null when either side doesn't have exactly 5 champions", () => {
    const m = match({}, fullTenParticipants().slice(0, 9));
    expect(extractTeamPlayers(m, "puuid-1")).toBeNull();
  });

  it("role-orders each side (Top/Jungle/Mid/Bot/Support), the tracked player's own slot included", () => {
    const m = match({}, fullTenParticipants());
    const players = extractTeamPlayers(m, "puuid-1");
    expect(players?.allyPlayers.map((p) => p.championId)).toEqual([2, 3, 112, 4, 5]); // top jgl MID bot sup
    expect(players?.allyPlayers[2].championId).toBe(112);
    expect(players?.allyPlayers[2].role).toBe(2);
    expect(players?.enemyPlayers.map((p) => p.championId)).toEqual([6, 7, 8, 9, 10]);
  });

  it("P3(a) fix: returns null entirely when a side's roles don't resolve to 5 distinct known roles (never a reordered lie)", () => {
    const m = match(
      {},
      fullTenParticipants([{}, { teamPosition: "TOP" }, { teamPosition: "TOP" }]) // ally-2 and ally-3 both TOP -> dup
    );
    expect(extractTeamPlayers(m, "puuid-1")).toBeNull();
  });

  it("filters 0s out of items and nulls an empty trinket slot per player", () => {
    const m = match(
      {},
      fullTenParticipants([{ item3: 0, item4: 0, item5: 0, item6: 0 }])
    );
    const players = extractTeamPlayers(m, "puuid-1");
    const self = players?.allyPlayers.find((p) => p.championId === 112);
    expect(self?.items).toEqual([6655, 4645, 3020]);
    expect(self?.trinket).toBeNull();
  });

  it("resolves name from riotIdGameName when present", () => {
    const m = match({}, fullTenParticipants([{ riotIdGameName: "Faker", riotIdTagline: "KR1" }]));
    const players = extractTeamPlayers(m, "puuid-1");
    const self = players?.allyPlayers.find((p) => p.championId === 112);
    expect(self?.name).toBe("Faker");
  });

  it("falls back to summonerName when riotIdGameName is absent/empty", () => {
    const m = match({}, fullTenParticipants([{ riotIdGameName: "", summonerName: "OldStyleName" }]));
    const players = extractTeamPlayers(m, "puuid-1");
    const self = players?.allyPlayers.find((p) => p.championId === 112);
    expect(self?.name).toBe("OldStyleName");
  });

  it("resolves to null when neither riotIdGameName nor summonerName is available (both empty/absent)", () => {
    const m = match({}, fullTenParticipants([{ riotIdGameName: "", summonerName: "" }]));
    const players = extractTeamPlayers(m, "puuid-1");
    const self = players?.allyPlayers.find((p) => p.championId === 112);
    expect(self?.name).toBeNull();
  });

  it("stamps ONLY the tracked player's own slot with the caller-supplied proId — teammates/opponents stay unset (2026-07-11, 'cheap' proId case)", () => {
    const m = match({}, fullTenParticipants());
    const players = extractTeamPlayers(m, "puuid-1", "pro-self-id");
    const self = players?.allyPlayers.find((p) => p.championId === 112);
    expect(self?.proId).toBe("pro-self-id");
    for (const p of [...(players?.allyPlayers ?? []), ...(players?.enemyPlayers ?? [])]) {
      if (p.championId === 112) continue;
      expect(p.proId).toBeUndefined();
    }
  });

  it("omits proId entirely (no key) when no proId is supplied — backward compatible with pre-2026-07-11 callers", () => {
    const m = match({}, fullTenParticipants());
    const players = extractTeamPlayers(m, "puuid-1");
    const self = players?.allyPlayers.find((p) => p.championId === 112);
    expect(self && "proId" in self).toBe(false);
  });

  it("never sets playerLink — soloq has no player_link identity model (2026-07-11, prostage-only field)", () => {
    const m = match({}, fullTenParticipants());
    const players = extractTeamPlayers(m, "puuid-1", "pro-self-id");
    for (const p of [...(players?.allyPlayers ?? []), ...(players?.enemyPlayers ?? [])]) {
      expect(p.playerLink === undefined || p.playerLink === null).toBe(true);
    }
  });
});

describe("extractMatch team players integration", () => {
  it("populates allyPlayers/enemyPlayers on a full 5v5 row, in lockstep with allyChampionIds/enemyChampionIds", () => {
    // P3(a) fix (2026-07-17): distinct teamPositions per participant are
    // required now — a degenerate (all-MIDDLE) fixture would make
    // extractTeamComps/extractTeamPlayers omit the whole result (see the
    // "extractTeamComps" describe block's fullTenParticipants doc comment).
    const participants = [
      participant({ teamPosition: "TOP" }), // puuid-1, teamId 100, championId 112
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "JUNGLE" }),
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "MIDDLE" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
    const m = match({}, participants);
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.allyPlayers?.map((p) => p.championId)).toEqual(row?.allyChampionIds);
    expect(row?.enemyPlayers?.map((p) => p.championId)).toEqual(row?.enemyChampionIds);
  });

  it("threads extractMatch's optional 4th proId param through to the tracked player's own allyPlayers slot", () => {
    const participants = [
      participant({ teamPosition: "TOP" }), // puuid-1, teamId 100, championId 112
      participant({ puuid: "ally-2", participantId: 2, teamId: 100, championId: 2, teamPosition: "JUNGLE" }),
      participant({ puuid: "ally-3", participantId: 3, teamId: 100, championId: 3, teamPosition: "MIDDLE" }),
      participant({ puuid: "ally-4", participantId: 4, teamId: 100, championId: 4, teamPosition: "BOTTOM" }),
      participant({ puuid: "ally-5", participantId: 5, teamId: 100, championId: 5, teamPosition: "UTILITY" }),
      participant({ puuid: "enemy-1", participantId: 6, teamId: 200, championId: 6, teamPosition: "TOP" }),
      participant({ puuid: "enemy-2", participantId: 7, teamId: 200, championId: 7, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy-3", participantId: 8, teamId: 200, championId: 8, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy-4", participantId: 9, teamId: 200, championId: 9, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy-5", participantId: 10, teamId: 200, championId: 10, teamPosition: "UTILITY" }),
    ];
    const m = match({}, participants);
    const row = extractMatch(m, timeline(), "puuid-1", "pro-self-id");
    const self = row?.allyPlayers?.find((p) => p.championId === 112);
    expect(self?.proId).toBe("pro-self-id");
    const teammate = row?.allyPlayers?.find((p) => p.championId === 2);
    expect(teammate && "proId" in teammate).toBe(false);
  });

  it("nulls both fields when the match isn't a clean 5v5", () => {
    const m = match({}, [participant()]);
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(row?.allyPlayers).toBeNull();
    expect(row?.enemyPlayers).toBeNull();
  });
});

describe("extractGameStats (shared by extractMatch and scripts/backfill-game-stats.mjs)", () => {
  it("returns null when the puuid isn't in the match — used standalone by the backfill script, so this guard is directly reachable there (unlike inside extractMatch, where the caller already resolved the same puuid)", () => {
    const m = match();
    expect(extractGameStats(m, "someone-else")).toBeNull();
  });

  it("matches extractMatch's own cs/damage/teamKills/gold for the same input", () => {
    const teammate = participant({ puuid: "puuid-2", participantId: 2, teamId: 100, kills: 3 });
    const m = match({}, [participant(), teammate]);
    const stats = extractGameStats(m, "puuid-1");
    const row = extractMatch(m, timeline(), "puuid-1");
    expect(stats).toEqual({
      cs: row?.cs,
      damageChampions: row?.damageChampions,
      teamKills: row?.teamKills,
      gold: row?.gold,
    });
  });
});
