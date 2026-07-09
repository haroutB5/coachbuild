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
} from "../pro/extract";
import type { RiotMatch, RiotParticipant, RiotTimeline } from "../pro/types";

function participant(overrides: Partial<RiotParticipant> = {}): RiotParticipant {
  return {
    puuid: "puuid-1",
    participantId: 1,
    championId: 112,
    championName: "Viktor",
    teamPosition: "MIDDLE",
    win: true,
    kills: 5,
    deaths: 2,
    assists: 7,
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
});
