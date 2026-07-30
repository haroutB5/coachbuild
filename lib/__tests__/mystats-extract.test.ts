import { describe, it, expect } from "vitest";
import { extractMyMatch } from "@/lib/mystats/extract";
import type { MyRiotMatch, MyRiotParticipant } from "@/lib/mystats/types";

const SELF_PUUID = "self-puuid";

function participant(overrides: Partial<MyRiotParticipant>): MyRiotParticipant {
  return {
    puuid: "p",
    teamId: 100,
    championId: 1,
    teamPosition: "TOP",
    win: true,
    kills: 5,
    deaths: 2,
    assists: 7,
    item0: 3078,
    item1: 3072,
    item2: 3053,
    item3: 3006,
    item4: 3025,
    item5: 0,
    perks: { styles: [{ description: "primaryStyle", selections: [{ perk: 8005 }] }, { description: "subStyle", selections: [{ perk: 8226 }] }] },
    // Migration 0021 — the two halves of creep score. 180 + 20 = 200 CS.
    totalMinionsKilled: 180,
    neutralMinionsKilled: 20,
    ...overrides,
  };
}

function match(participants: MyRiotParticipant[], overrides: Partial<MyRiotMatch["info"]> = {}): MyRiotMatch {
  return {
    metadata: { matchId: "EUW1_1" },
    info: {
      gameCreation: 1_700_000_000_000,
      gameVersion: "16.13.567.1234",
      queueId: 420,
      gameDuration: 1800, // SECONDS (30 min) — see MyRiotMatch's doc comment
      participants,
      ...overrides,
    },
  };
}

describe("extractMyMatch", () => {
  it("returns null when the puuid isn't a participant in the match", () => {
    const m = match([participant({ puuid: "someone-else" })]);
    expect(extractMyMatch(m, SELF_PUUID)).toBeNull();
  });

  it("resolves a clean 1v1 lane opponent by matching teamPosition on the other team", () => {
    const m = match([
      participant({ puuid: SELF_PUUID, teamId: 100, championId: 10, teamPosition: "MIDDLE", win: true }),
      participant({ puuid: "ally2", teamId: 100, championId: 20, teamPosition: "TOP" }),
      participant({ puuid: "enemy-mid", teamId: 200, championId: 99, teamPosition: "MIDDLE" }),
      participant({ puuid: "enemy2", teamId: 200, championId: 30, teamPosition: "TOP" }),
    ]);
    const row = extractMyMatch(m, SELF_PUUID);
    expect(row).not.toBeNull();
    expect(row!.championId).toBe(10);
    expect(row!.role).toBe(2); // MIDDLE
    expect(row!.oppChampionId).toBe(99);
    expect(row!.win).toBe(true);
    expect(row!.queueId).toBe(420);
    expect(row!.patch).toBe("16.13");
    expect(row!.matchId).toBe("EUW1_1");
  });

  describe("v0.51 additions: KDA/items/keystone/split", () => {
    it("pulls kills/deaths/assists and the 6 final item slots verbatim (trinket excluded)", () => {
      const m = match([participant({ puuid: SELF_PUUID, kills: 8, deaths: 3, assists: 12 })]);
      const row = extractMyMatch(m, SELF_PUUID)!;
      expect(row.kills).toBe(8);
      expect(row.deaths).toBe(3);
      expect(row.assists).toBe(12);
      expect(row.itemIds).toEqual([3078, 3072, 3053, 3006, 3025, 0]); // item6/trinket never read
    });

    it("resolves the primary-tree keystone (first selection of the primaryStyle row)", () => {
      const m = match([
        participant({
          puuid: SELF_PUUID,
          perks: {
            styles: [
              { description: "subStyle", selections: [{ perk: 8210 }] },
              { description: "primaryStyle", selections: [{ perk: 8005 }, { perk: 9111 }] },
            ],
          },
        }),
      ]);
      expect(extractMyMatch(m, SELF_PUUID)!.primaryKeystone).toBe(8005);
    });

    it("missing/malformed perks degrade to a null primaryKeystone, never a throw", () => {
      const m = match([participant({ puuid: SELF_PUUID, perks: undefined })]);
      expect(extractMyMatch(m, SELF_PUUID)!.primaryKeystone).toBeNull();
    });

    it("tags the row with its split (pure function of gameCreation)", () => {
      const m = match([participant({ puuid: SELF_PUUID })], { gameCreation: Date.UTC(2026, 5, 1) }); // 2026-06-01, within split 2
      expect(extractMyMatch(m, SELF_PUUID)!.split).toBe(2);
    });
  });

  it("ARAM / missing-position: blank teamPosition on every participant -> role -1, oppChampionId null, row still stored", () => {
    const m = match(
      [
        participant({ puuid: SELF_PUUID, teamId: 100, championId: 10, teamPosition: "", win: false }),
        participant({ puuid: "enemy", teamId: 200, championId: 55, teamPosition: "" }),
      ],
      { queueId: 450 }
    );
    const row = extractMyMatch(m, SELF_PUUID);
    expect(row).not.toBeNull();
    expect(row!.role).toBe(-1);
    expect(row!.oppChampionId).toBeNull();
    expect(row!.queueId).toBe(450);
    expect(row!.win).toBe(false);
  });

  it("resolved role but NO enemy shares that teamPosition -> oppChampionId null (never guess)", () => {
    const m = match([
      participant({ puuid: SELF_PUUID, teamId: 100, championId: 10, teamPosition: "JUNGLE" }),
      participant({ puuid: "enemy", teamId: 200, championId: 55, teamPosition: "TOP" }),
    ]);
    const row = extractMyMatch(m, SELF_PUUID);
    expect(row!.role).toBe(1);
    expect(row!.oppChampionId).toBeNull();
  });

  it("resolved role but TWO enemies share that teamPosition (duplicate/ambiguous) -> oppChampionId null", () => {
    const m = match([
      participant({ puuid: SELF_PUUID, teamId: 100, championId: 10, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy1", teamId: 200, championId: 55, teamPosition: "BOTTOM" }),
      participant({ puuid: "enemy2", teamId: 200, championId: 77, teamPosition: "BOTTOM" }),
    ]);
    const row = extractMyMatch(m, SELF_PUUID);
    expect(row!.role).toBe(3);
    expect(row!.oppChampionId).toBeNull();
  });

  it("unrecognized teamPosition string -> role -1, not a crash", () => {
    const m = match([
      participant({ puuid: SELF_PUUID, teamId: 100, championId: 10, teamPosition: "SOMETHING_NEW" }),
      participant({ puuid: "enemy", teamId: 200, championId: 55, teamPosition: "SOMETHING_NEW" }),
    ]);
    const row = extractMyMatch(m, SELF_PUUID);
    expect(row!.role).toBe(-1);
    expect(row!.oppChampionId).toBeNull();
  });

  // ── Migration 0021: CS + duration ─────────────────────────────────────────
  it("extracts CS as lane minions PLUS neutral monsters, and duration in seconds", () => {
    const m = match([
      participant({ puuid: SELF_PUUID, totalMinionsKilled: 210, neutralMinionsKilled: 34 }),
    ]);
    const row = extractMyMatch(m, SELF_PUUID)!;
    expect(row.cs).toBe(244); // NOT 210 — jungle monsters count
    expect(row.gameDurationSec).toBe(1800);
  });

  it("uses the SAME formula as the pro pipeline", async () => {
    // Guards the shared-helper decision: if someone re-writes an inline
    // `a + b` in lib/mystats/extract.ts, this still passes — but if the two
    // pipelines ever disagree on what CS means, creepScore is the one place
    // that has to change, and this asserts My Stats actually routes through it.
    const { creepScore } = await import("@/lib/pro/extract");
    const p = { totalMinionsKilled: 210, neutralMinionsKilled: 34 };
    const row = extractMyMatch(match([participant({ puuid: SELF_PUUID, ...p })]), SELF_PUUID)!;
    expect(row.cs).toBe(creepScore(p));
  });

  it("STORES a 3-minute remake rather than dropping it — filtering is the aggregator's job", () => {
    // Same posture this file's header sets out for role/queue: extraction never
    // makes a filtering decision. lib/mystats/cs.ts excludes it from RATES.
    const m = match(
      [participant({ puuid: SELF_PUUID, totalMinionsKilled: 12, neutralMinionsKilled: 0 })],
      { gameDuration: 221 }
    );
    const row = extractMyMatch(m, SELF_PUUID)!;
    expect(row).not.toBeNull();
    expect(row.cs).toBe(12);
    expect(row.gameDurationSec).toBe(221);
  });

  it("extracts a genuine 0-CS game as 0, never as null", () => {
    // 0 is a measurement; null means NOT measured. Conflating them is what
    // would let a real zero be dropped from a denominator it belongs in.
    const m = match([
      participant({ puuid: SELF_PUUID, totalMinionsKilled: 0, neutralMinionsKilled: 0 }),
    ]);
    expect(extractMyMatch(m, SELF_PUUID)!.cs).toBe(0);
  });
});
