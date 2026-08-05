import { describe, expect, it } from "vitest";
import type { ChampionRef } from "@/lib/types";
import { CHAMPION_ALIASES, matchChampions } from "../championSearch";

const champion = (key: string, name: string, id = 1): ChampionRef => ({
  id,
  key,
  name,
  icon: "",
});

const CHAMPIONS: ChampionRef[] = [
  champion("JarvanIV", "Jarvan IV", 59),
  champion("MissFortune", "Miss Fortune", 21),
  champion("AurelionSol", "Aurelion Sol", 136),
  champion("KhaZix", "Kha'Zix", 121),
  champion("ChoGath", "Cho'Gath", 31),
  champion("DrMundo", "Dr. Mundo", 36),
  champion("LeeSin", "Lee Sin", 64),
  champion("KaiSa", "Kai'Sa", 145),
  champion("Akshan", "Akshan", 166),
  champion("Mordekaiser", "Mordekaiser", 82),
];

// These names mirror the real champion names returned by /api/champions for
// every alias target. Keeping the target roster explicit makes the alias table
// test fail if an entry is ever changed to an invented champion.
const API_CHAMPION_NAMES = [
  "Jarvan IV",
  "Miss Fortune",
  "Warwick",
  "Twisted Fate",
  "Katarina",
  "Aurelion Sol",
  "Kha'Zix",
  "Cho'Gath",
  "Dr. Mundo",
  "Tahm Kench",
  "Gangplank",
  "LeBlanc",
  "Ezreal",
  "Cassiopeia",
  "Tryndamere",
  "Master Yi",
  "Vladimir",
  "Malzahar",
  "Mordekaiser",
  "Nautilus",
  "Nocturne",
  "Sejuani",
  "Shyvana",
  "Viktor",
  "Volibear",
  "Rek'Sai",
  "Kog'Maw",
  "Vel'Koz",
  "Hecarim",
  "Orianna",
  "Pantheon",
  "Renekton",
  "Tristana",
  "Xin Zhao",
  "Akshan",
];
API_CHAMPION_NAMES.forEach((name, index) => {
  if (CHAMPIONS.some((entry) => entry.name === name)) return;
  CHAMPIONS.push(champion(name.replace(/[^a-z0-9]/gi, ""), name, 1000 + index));
});

describe("matchChampions", () => {
  it("accepts the curated aliases only when their real API champion is present", () => {
    const available = new Set(CHAMPIONS.flatMap((entry) => [entry.key, entry.name].map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""))));

    for (const target of Object.values(CHAMPION_ALIASES)) {
      expect(available.has(target.toLowerCase().replace(/[^a-z0-9]/g, ""))).toBe(true);
      expect(API_CHAMPION_NAMES).toContain(target);
    }

    expect(matchChampions("j4", CHAMPIONS)[0]?.name).toBe("Jarvan IV");
    expect(matchChampions("mf", CHAMPIONS)[0]?.name).toBe("Miss Fortune");
    expect(matchChampions("asol", CHAMPIONS)[0]?.name).toBe("Aurelion Sol");
    expect(matchChampions("kha", CHAMPIONS)[0]?.name).toBe("Kha'Zix");
  });

  it("matches compacted spaces, apostrophes, punctuation, and word initials", () => {
    expect(matchChampions("leesin", CHAMPIONS).map((entry) => entry.name)).toContain("Lee Sin");
    expect(matchChampions("kaisa", CHAMPIONS).map((entry) => entry.name)).toContain("Kai'Sa");
    expect(matchChampions("chogath", CHAMPIONS).map((entry) => entry.name)).toContain("Cho'Gath");
    expect(matchChampions("drmundo", CHAMPIONS).map((entry) => entry.name)).toContain("Dr. Mundo");
    expect(matchChampions("lee s", CHAMPIONS).map((entry) => entry.name)).toContain("Lee Sin");
  });

  it("ranks aliases and exact/prefix matches before mid-string includes", () => {
    const champions = [
      champion("Mordekaiser", "Mordekaiser", 82),
      champion("Akshan", "Akshan", 166),
      champion("AurelionSol", "Aurelion Sol", 136),
    ];

    expect(matchChampions("akshan", champions).map((entry) => entry.name)).toEqual(["Akshan"]);
    expect(matchChampions("a", champions).map((entry) => entry.name)).toEqual(["Akshan", "Aurelion Sol", "Mordekaiser"]);
    expect(matchChampions("orde", champions).map((entry) => entry.name)).toEqual(["Mordekaiser"]);
  });

  it("returns the original ordering for an empty query", () => {
    expect(matchChampions("  ", CHAMPIONS)).toEqual(CHAMPIONS);
  });
});
