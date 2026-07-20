/**
 * Compliance regression guard (plan §3): buildLivePanelModel must NEVER
 * surface a name field (summonerName/riotId/anything else) from the raw
 * Live Client Data payload — only championKey + a normalized position.
 */
import { describe, it, expect } from "vitest";
import { buildLivePanelModel, indexChampionsByKey } from "../live/livePanelModel";
import type { LiveDataRaw } from "../live/companionClient";
import type { ChampionRef } from "@/lib/types";

function fixture(overrides: Partial<{ allPlayers: unknown }> = {}): LiveDataRaw {
  return {
    activePlayer: { championStats: {}, summonerName: "MySecretName#NA1" },
    allPlayers: [
      { championName: "Viktor", team: "ORDER", position: "MIDDLE", summonerName: "MySecretName#NA1", riotId: "MySecretName#NA1" },
      { championName: "LeeSin", team: "ORDER", position: "JUNGLE", summonerName: "AllyOne#NA1" },
      { championName: "Ahri", team: "CHAOS", position: "MIDDLE", summonerName: "EnemyMid#NA1", riotId: "EnemyMid#NA1" },
      { championName: "Nunu", team: "CHAOS", position: "JUNGLE", summonerName: "EnemyJg#NA1" },
      { championName: "Thresh", team: "CHAOS", position: "UTILITY", summonerName: "EnemySup#NA1" },
      { championName: "Jinx", team: "CHAOS", position: "BOTTOM", summonerName: "EnemyAdc#NA1" },
      { championName: "Darius", team: "CHAOS", position: "TOP", summonerName: "EnemyTop#NA1" },
    ],
    ...overrides,
  };
}

describe("buildLivePanelModel — compliance (no name fields, ever)", () => {
  it("never includes any input summonerName/riotId string anywhere in the output", () => {
    const raw = fixture();
    const model = buildLivePanelModel(raw, "Viktor");
    expect(model).not.toBeNull();
    const serialized = JSON.stringify(model);
    for (const row of raw.allPlayers as { summonerName?: string; riotId?: string }[]) {
      if (row.summonerName) expect(serialized).not.toContain(row.summonerName);
      if (row.riotId) expect(serialized).not.toContain(row.riotId);
    }
  });

  it("the output shape has no key that could hold a name (only championKey + position)", () => {
    const model = buildLivePanelModel(fixture(), "Viktor");
    for (const enemy of model!.enemies) {
      expect(Object.keys(enemy).sort()).toEqual(["championKey", "position"]);
    }
  });
});

describe("buildLivePanelModel — behavior", () => {
  it("returns only the OTHER team as enemies, never self or allies", () => {
    const model = buildLivePanelModel(fixture(), "Viktor");
    const keys = model!.enemies.map((e) => e.championKey);
    expect(keys).not.toContain("Viktor"); // self
    expect(keys).not.toContain("LeeSin"); // ally
    expect(keys.sort()).toEqual(["Ahri", "Darius", "Jinx", "Nunu", "Thresh"].sort());
  });

  it("normalizes position to short labels, ordered Top->Jungle->Mid->Bot->Support", () => {
    const model = buildLivePanelModel(fixture(), "Viktor");
    expect(model!.enemies.map((e) => e.position)).toEqual(["Top", "Jg", "Mid", "Bot", "Sup"]);
  });

  it("returns null when allPlayers is missing/malformed", () => {
    expect(buildLivePanelModel({}, "Viktor")).toBeNull();
    expect(buildLivePanelModel({ allPlayers: "not-an-array" }, "Viktor")).toBeNull();
    expect(buildLivePanelModel(null, "Viktor")).toBeNull();
    expect(buildLivePanelModel(undefined, "Viktor")).toBeNull();
  });

  it("returns null when the local player's champion can't be found in the roster", () => {
    expect(buildLivePanelModel(fixture(), "Zed")).toBeNull();
  });

  it("degrades an unrecognized/empty position to null rather than a raw enum string", () => {
    const raw = fixture({
      allPlayers: [
        { championName: "Viktor", team: "ORDER", position: "MIDDLE" },
        { championName: "Ahri", team: "CHAOS", position: "" },
        { championName: "Nunu", team: "CHAOS" }, // ARAM-style: no position field at all
      ],
    });
    const model = buildLivePanelModel(raw, "Viktor");
    expect(model!.enemies.every((e) => e.position === null)).toBe(true);
  });
});

describe("indexChampionsByKey", () => {
  it("indexes by champion key, not id", () => {
    const champs: ChampionRef[] = [
      { id: 112, key: "Viktor", name: "Viktor", icon: "viktor.webp" },
      { id: 64, key: "LeeSin", name: "Lee Sin", icon: "leesin.webp" },
    ];
    const map = indexChampionsByKey(champs);
    expect(map.get("LeeSin")?.name).toBe("Lee Sin");
    expect(map.get("Viktor")?.id).toBe(112);
    expect(map.get("112")).toBeUndefined();
  });
});
