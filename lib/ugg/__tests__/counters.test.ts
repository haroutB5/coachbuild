import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { rankUggCounters } from "../counters";
import fixture from "../__fixtures__/ahri-mid.json";

const champions = fixture.rows.map(r => ({
  id: r.champion_id, name: String(r.champion_id), key: String(r.champion_id), icon: "",
}));

describe("u.gg CountersContainer parity", () => {
  it("matches the live Ahri page's GD15 top 15 and worst-WR top 10", () => {
    const result = rankUggCounters(fixture.rows, champions);
    expect(result.bestLaneCounters.map(r => r.champId)).toEqual([39, 800, 246, 238, 166, 142, 805, 131, 105, 157, 7, 91, 4, 161, 134]);
    expect(result.worstPicks.map(r => r.champId)).toEqual([3, 268, 34, 69, 777, 84, 90, 136, 13, 61]);
    expect(result.bestLaneCounters[0]).toMatchObject({ champId: 39, goldAt15: 892, games: 3061 });
    expect(result.worstPicks[0]).toMatchObject({ champId: 3, winRate: 0.4539, games: 4263 });
  });

  it("uses u.gg's 0.5% pick-rate floor and retains equal-GD source order", () => {
    const row = fixture.rows[0];
    const input = [{ ...row, champion_id: 39, pick_rate: 0.49, gold_adv_15: -9999 },
      { ...row, champion_id: 161, pick_rate: 0.5, gold_adv_15: -200 },
      { ...row, champion_id: 134, pick_rate: 0.5, gold_adv_15: -200 }];
    expect(rankUggCounters(input, champions).bestLaneCounters.map(r => r.champId)).toEqual([161, 134]);
  });

  it("fails on corrupt numbers or unresolved eligible champions instead of silently shortening lists", () => {
    expect(() => rankUggCounters([{ ...fixture.rows[0], win_rate: NaN }], champions)).toThrow();
    expect(() => rankUggCounters(fixture.rows, [])).toThrow();
  });

  it("runs the actual native reader against the SSR envelope and isolates enemy, lane and bracket", () => {
    const source = readFileSync(join(process.cwd(), "desktop/src/CoachBuild.Desktop/Web/UggCounters.cs"), "utf8");
    const template = source.match(/=> """\r?\n([\s\S]*?)\r?\n\s*"""\.Replace/)![1];
    const script = template.replaceAll("__ENEMY__", "103").replaceAll("__LANE__", '"mid"');
    const state = { [fixture.sourceUrl]: { data: {
      world_emerald_plus_mid: { counters: fixture.rows },
      world_emerald_plus_top: { counters: [] },
    } } };
    const document = { title: "Ahri Counter - LoL Patch 26.17 - U.GG",
      getElementById: () => ({ textContent: "window.__SSR_DATA__ = " + JSON.stringify(state) + "\nwindow.__APOLLO_STATE__ = {}" }) };
    const read = runInNewContext(script, { document });
    expect(read.patch).toBe("26.17");
    expect(read.rows).toHaveLength(41);
    expect(runInNewContext(script.replace("/103/", "/104/"), { document })).toBeNull();
    expect(runInNewContext(script, { document: { ...document, getElementById: () => null } })).toBeNull();
  });
});
