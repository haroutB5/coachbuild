/**
 * Tests for lib/prostage/teamComps.ts's role-resolution precedence — P4 fix
 * (2026-07-22): a live prod bug report ("jg is twice and lane order is
 * wrong" on a Swain pro game) traced to buildProstageCompsMap preferring
 * `pro_role` (coachbuild.pros.role, a generic/roster-level position) over
 * `role` (this specific game's own Cargo Role column) whenever a tracked
 * pro's row had both. Live-confirmed on prod data: Viper is tagged
 * role=1/jungle in coachbuild.pros (stale/wrong roster attribute) while his
 * per-game Cargo role correctly resolved to role=3/bot — under the old
 * pro_role-first precedence this collided with his team's real jungler
 * (also role=1 for that game), so the side no longer resolved to 5 distinct
 * roles and orderByRole degraded the whole side to source order.
 */
import { describe, it, expect } from "vitest";
import { buildProstageCompsMap, orderedSidesForGame, type ProstageCompRow } from "@/lib/prostage/teamComps";

function row(overrides: Partial<ProstageCompRow>): ProstageCompRow {
  return {
    game_id: "G1",
    team: "T1",
    champion_id: 1,
    role: null,
    pro_role: null,
    player_link: "player",
    final_items: [],
    trinket: null,
    pro_name: null,
    pro_id: null,
    ...overrides,
  };
}

describe("buildProstageCompsMap role resolution", () => {
  it("prefers this game's own role over a tracked pro's stale roster-level pro_role", () => {
    const rows: ProstageCompRow[] = [row({ champion_id: 800, role: 3, pro_role: 1, player_link: "Viper" })];
    const map = buildProstageCompsMap(rows, new Map());
    expect(map.get("G1")!.get("T1")![0].role).toBe(3); // bot, per Cargo — not jungle (pro_role)
  });

  it("falls back to pro_role only when this game's own role is unresolved", () => {
    const rows: ProstageCompRow[] = [row({ champion_id: 103, role: null, pro_role: 2, player_link: "Faker" })];
    const map = buildProstageCompsMap(rows, new Map());
    expect(map.get("G1")!.get("T1")![0].role).toBe(2);
  });

  it("null role when both role and pro_role are unresolved — never guessed", () => {
    const rows: ProstageCompRow[] = [row({ role: null, pro_role: null })];
    const map = buildProstageCompsMap(rows, new Map());
    expect(map.get("G1")!.get("T1")![0].role).toBeNull();
  });
});

describe("orderedSidesForGame — the exact Bilibili Gaming reproduction", () => {
  it("resolves 5 distinct Top-Jg-Mid-Bot-Sup lanes when a tracked pro's stale pro_role would otherwise collide with a teammate's real per-game role", () => {
    // Mirrors 2026 Mid-Season Invitational_Finals_1_4's Bilibili Gaming
    // roster: ON (support, untracked), Knight (mid), Xun (jungle,
    // untracked), Viper (bot per Cargo, but tagged jungle in coachbuild.pros
    // — the live bug), Bin (top).
    const rows: ProstageCompRow[] = [
      row({ champion_id: 72, role: 4, pro_role: null, player_link: "ON", team: "BLG" }), // support
      row({ champion_id: 163, role: 2, pro_role: 2, player_link: "Knight", team: "BLG" }), // mid
      row({ champion_id: 203, role: 1, pro_role: null, player_link: "Xun", team: "BLG" }), // jungle
      row({ champion_id: 800, role: 3, pro_role: 1, player_link: "Viper", team: "BLG" }), // bot — stale pro_role=1
      row({ champion_id: 897, role: 0, pro_role: 0, player_link: "Bin", team: "BLG" }), // top
      // opposing side — any clean 5.
      row({ champion_id: 50, role: 0, pro_role: 0, player_link: "Zeus", team: "HLE" }),
      row({ champion_id: 48, role: 1, pro_role: 1, player_link: "Kanavi", team: "HLE" }),
      row({ champion_id: 4, role: 2, pro_role: 2, player_link: "Zeka", team: "HLE" }),
      row({ champion_id: 22, role: 3, pro_role: 3, player_link: "Gumayusi", team: "HLE" }),
      row({ champion_id: 147, role: 4, pro_role: 4, player_link: "Delight", team: "HLE" }),
    ];
    const map = buildProstageCompsMap(rows, new Map());
    const sides = orderedSidesForGame(map, "G1", "BLG");
    expect(sides).not.toBeNull();
    const roles = sides!.ally.map((p) => p.role);
    expect(roles).toEqual([0, 1, 2, 3, 4]); // Top, Jungle, Mid, Bot, Support — no dupe
    expect(sides!.ally.map((p) => p.championId)).toEqual([897, 203, 163, 800, 72]); // Bin, Xun, Knight, Viper, ON
  });
});
