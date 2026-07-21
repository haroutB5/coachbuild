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
});
