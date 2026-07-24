import { describe, it, expect } from "vitest";
import { mapProRecentRow, type ProRecentRow } from "@/lib/pros/recentModel";

function row(over: Partial<ProRecentRow> = {}): ProRecentRow {
  return {
    game_id: "LEC_2026_Summer_1_1",
    player_link: "Faker",
    team: "T1",
    champion_id: 103,
    champion_name: "Ahri",
    role: 2,
    win: true,
    kills: 8,
    deaths: 1,
    assists: 10,
    tournament_display: "LEC 2026 Summer",
    pro_name: null,
    pro_team: null,
    ...over,
  };
}

describe("mapProRecentRow", () => {
  it("prefers tracked pros.name/team when present", () => {
    const g = mapProRecentRow(row({ pro_name: "Hide on bush", pro_team: "T1" }));
    expect(g.playerName).toBe("Hide on bush");
    expect(g.team).toBe("T1");
  });

  it("falls back to a CLEANED player_link/team for an untracked player", () => {
    const g = mapProRecentRow(row({ player_link: "Bwipo (Gabriël Rau)", team: "Fnatic (2026)", pro_name: null, pro_team: null }));
    expect(g.playerName).toBe("Bwipo");
    expect(g.team).toBe("Fnatic");
  });

  it("null team stays null when both pro_team and raw team are absent", () => {
    const g = mapProRecentRow(row({ team: null, pro_team: null }));
    expect(g.team).toBeNull();
  });

  it("unresolved role degrades to the -1 sentinel, not dropped", () => {
    const g = mapProRecentRow(row({ role: null }));
    expect(g.role).toBe(-1);
  });

  it("event is exactly tournament_display -- no round/patch suffix (no such columns exist)", () => {
    const g = mapProRecentRow(row({ tournament_display: "MSI 2026" }));
    expect(g.event).toBe("MSI 2026");
  });

  it("passes through identity/stat fields verbatim", () => {
    const g = mapProRecentRow(row());
    expect(g).toMatchObject({
      gameId: "LEC_2026_Summer_1_1",
      playerLink: "Faker",
      championId: 103,
      championName: "Ahri",
      win: true,
      kills: 8,
      deaths: 1,
      assists: 10,
    });
  });
});
