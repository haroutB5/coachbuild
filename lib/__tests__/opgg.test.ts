import { describe, it, expect, vi } from "vitest";
import {
  opggChampionName,
  opggPosition,
  parseSkillsFromAnalysis,
  extractEnvelopeText,
  extractCall,
  splitTopLevelArgs,
  buildSkillOrderRpc,
  fetchSkillOrder,
  CACHE_TTL_SECONDS,
  type OpggTransport,
} from "@/lib/opgg";
import type { RoleId } from "@/lib/types";
import { buildSkillOrderModel } from "@/lib/skillOrderModel";
import { kitFromMaxRanks } from "@/lib/championKit";
import {
  AHRI_MID_FULL,
  AHRI_MID_SLIM,
  UDYR_JUNGLE_PROD,
  UDYR_JUNGLE,
  APHELIOS_ADC,
  KAYN_JUNGLE,
  AHRI_SUPPORT_LOW_SAMPLE,
  UNKNOWN_CHAMPION_ENVELOPE,
  KHAZIX_JUNGLE,
  JINX_ADC,
  JAYCE_TOP,
} from "./fixtures/opggPayloads";

/** Udyr's real caps: four basics at six ranks each, no true ultimate. */
const UDYR_KIT = kitFromMaxRanks([6, 6, 6, 6])!;

describe("opggChampionName", () => {
  it("upper-snakes a camelCase Riot key", () => {
    expect(opggChampionName("Ahri")).toBe("AHRI");
    expect(opggChampionName("MissFortune")).toBe("MISS_FORTUNE");
    expect(opggChampionName("TwistedFate")).toBe("TWISTED_FATE");
    expect(opggChampionName("XinZhao")).toBe("XIN_ZHAO");
    expect(opggChampionName("JarvanIV")).toBe("JARVAN_IV");
    expect(opggChampionName("DrMundo")).toBe("DR_MUNDO");
    expect(opggChampionName("LeeSin")).toBe("LEE_SIN");
    expect(opggChampionName("AurelionSol")).toBe("AURELION_SOL");
  });

  it("handles the five champions whose key differs from their display name", () => {
    // All five verified live: op.gg accepts the key-derived form.
    expect(opggChampionName("Nunu")).toBe("NUNU");
    expect(opggChampionName("MonkeyKing")).toBe("MONKEY_KING");
    expect(opggChampionName("KogMaw")).toBe("KOG_MAW");
    expect(opggChampionName("RekSai")).toBe("REK_SAI");
    expect(opggChampionName("Renata")).toBe("RENATA");
  });

  it("strips punctuation that Riot keys never carry but data might", () => {
    expect(opggChampionName("Kai'Sa")).toBe("KAISA");
    expect(opggChampionName("Cho'Gath")).toBe("CHOGATH");
    expect(opggChampionName("Bel'Veth")).toBe("BELVETH");
  });
});

describe("opggPosition", () => {
  it("maps the five real lanes", () => {
    const expected: Record<number, string> = {
      0: "top",
      1: "jungle",
      2: "mid",
      3: "adc",
      4: "support",
    };
    for (const [role, pos] of Object.entries(expected)) {
      expect(opggPosition(Number(role) as RoleId)).toBe(pos);
    }
  });

  it("returns null for role 5 — 'all' is advertised upstream but REJECTED", () => {
    // Probed live against all 172 champions: position="all" returns
    // {"position":["The selected position is invalid."]}. Trusting the tool
    // schema's enum here would break every role-5 request.
    expect(opggPosition(5 as RoleId)).toBeNull();
  });
});

describe("splitTopLevelArgs / extractCall", () => {
  it("splits on top-level commas only", () => {
    expect(splitTopLevelArgs('1,2,3')).toEqual(["1", "2", "3"]);
    expect(splitTopLevelArgs('["a","b"],2,Foo(3,4)')).toEqual(['["a","b"]', "2", "Foo(3,4)"]);
  });

  it("ignores commas inside strings", () => {
    expect(splitTopLevelArgs('"a,b",2')).toEqual(['"a,b"', "2"]);
  });

  it("extracts a balanced call body", () => {
    expect(extractCall("X(Foo(1,2),3)", "Foo")?.inner).toBe("1,2");
    expect(extractCall("A(1,B(2,C(3)),4)", "A")?.inner).toBe("1,B(2,C(3)),4");
  });

  it("does not match an identifier that merely ENDS with the name", () => {
    // "MySkills(" must not be found when looking for "Skills(".
    expect(extractCall("MySkills(1)", "Skills")).toBeNull();
    expect(extractCall("MySkills(1),Skills(2)", "Skills")?.inner).toBe("2");
  });

  it("returns null on an unbalanced call", () => {
    expect(extractCall("Foo(1,2", "Foo")).toBeNull();
  });
});

describe("parseSkillsFromAnalysis — real payloads", () => {
  it("parses the FULL response (class Skills: order,play,win,pick_rate)", () => {
    expect(AHRI_MID_FULL).toContain("class Skills: order,play,win,pick_rate");
    const s = parseSkillsFromAnalysis(AHRI_MID_FULL)!;
    expect(s).toBeTruthy();
    expect(s.order.join("")).toBe("WQEQQRQWQWRWWEE");
    expect(s.play).toBe(71667);
    expect(s.win).toBe(41408);
    expect(s.pickRate).toBe(0.57);
    expect(s.priorityIds).toEqual(["Q", "W", "E"]);
  });

  it("parses the SLIM response, whose fields are REORDERED", () => {
    // This is the test that catches positional parsing. Same champion, same
    // data, different declared field order.
    expect(AHRI_MID_SLIM).toContain("class Skills: order,pick_rate,play,win");
    const s = parseSkillsFromAnalysis(AHRI_MID_SLIM)!;
    expect(s).toBeTruthy();
    expect(s.play).toBe(71667);
    expect(s.win).toBe(41408);
    expect(s.pickRate).toBe(0.57);
  });

  it("parses the FOUR-field SkillMasteries — the shape production actually receives", () => {
    // Added 2026-07-27 after an audit found every fixture declared the FIVE-field
    // masteries header (…,builds), which is what an UNRESTRICTED call returns.
    // `buildSkillOrderRpc` always sends desired_output_fields, and that response
    // declares four. So the one shape production always sees was the one shape no
    // test covered.
    expect(UDYR_JUNGLE_PROD).toContain("class SkillMasteries: ids,play,win,pick_rate");
    expect(UDYR_JUNGLE_PROD).not.toContain("builds");

    const s = parseSkillsFromAnalysis(UDYR_JUNGLE_PROD)!;
    expect(s).toBeTruthy();
    expect(s.order.join("")).toBe("QRWEQQQEQEQEEEW");
    expect(s.play).toBe(9670);
    expect(s.win).toBe(5927);
    // The load-bearing assertion: the priority SURVIVES this shape. If the field
    // set ever drifts outside MASTERIES_FIELD_SETS this goes undefined, and Udyr
    // regresses to the user's original "only published to level 15" refusal.
    expect(s.priorityIds).toEqual(["Q", "E", "W", "R"]);
  });

  it("the production shape carries Udyr all the way to a completed 18-level order", () => {
    // End-to-end through the real assembler, on the real wire shape, for the
    // champion whose bug started this. Guards the whole chain in one assertion:
    // parse -> priorityIds -> surplus gate -> allocator.
    const s = parseSkillsFromAnalysis(UDYR_JUNGLE_PROD)!;
    const m = buildSkillOrderModel(s, UDYR_KIT);
    expect(m).toBeTruthy();
    expect(m!.completed).toBe(true);
    expect(m!.completionBasis).toBe("published");
    expect(m!.order.join("")).toBe("QRWEQQQEQEQEEEWWWW");
    expect(m!.observedLevels).toBe(15);
  });

  it("agrees between the two field orderings — byte-different, value-identical", () => {
    const full = parseSkillsFromAnalysis(AHRI_MID_FULL)!;
    const slim = parseSkillsFromAnalysis(AHRI_MID_SLIM)!;
    expect(AHRI_MID_FULL).not.toBe(AHRI_MID_SLIM);
    expect(slim).toEqual(full);
  });

  it("takes the TOP-LEVEL skills entry, not a skill_masteries build variant", () => {
    const s = parseSkillsFromAnalysis(AHRI_MID_FULL)!;
    // The first build variant shares this order+counts; the SECOND variant is
    // a different order with 12917 plays. Picking a variant would be a wrong
    // answer that still renders, so pin the primary explicitly.
    expect(s.play).toBe(71667);
    expect(s.play).not.toBe(12917);
    expect(AHRI_MID_FULL).toContain("12917");
  });

  it("parses the non-standard champions' raw values faithfully", () => {
    const udyr = parseSkillsFromAnalysis(UDYR_JUNGLE)!;
    expect(udyr.order.join("")).toBe("QRWEQQQEQEQEEEW");
    expect(udyr.priorityIds).toEqual(["Q", "E", "W", "R"]);

    const aph = parseSkillsFromAnalysis(APHELIOS_ADC)!;
    expect(aph.order.join("")).toBe("QQQEQREQEQEEREW");

    const kayn = parseSkillsFromAnalysis(KAYN_JUNGLE)!;
    expect(kayn.order.join("")).toBe("QEWQQRQWQWRWWEE");
  });

  it("parses a genuinely tiny sample without filtering it away", () => {
    const s = parseSkillsFromAnalysis(AHRI_SUPPORT_LOW_SAMPLE)!;
    expect(s.play).toBe(77);
    expect(s.win).toBe(53);
  });

  it("REJECTS Kha'Zix's evolution-suffixed ultimate tokens rather than guessing", () => {
    // The only champion of 172 whose order contains "R-Q"/"R-W" instead of
    // "R". Normalising them to "R" would produce a clean, plausible, and
    // information-losing 5/5/5/3 path — so we refuse the payload entirely.
    expect(KHAZIX_JUNGLE).toContain('"R-Q"');
    expect(KHAZIX_JUNGLE).toContain('"R-W"');
    expect(parseSkillsFromAnalysis(KHAZIX_JUNGLE)).toBeNull();
  });

  it("parses Jinx, whose ultimate is published at the ILLEGAL level 12", () => {
    const s = parseSkillsFromAnalysis(JINX_ADC)!;
    expect(s).toBeTruthy();
    // R at levels 6 and 12 — proof the feed is a per-level modal aggregate,
    // not one legal path. Passed through verbatim, never "corrected".
    const rLevels = s.order.map((a, i) => (a === "R" ? i + 1 : 0)).filter(Boolean);
    expect(rLevels).toEqual([6, 12]);
  });

  it("parses Jayce's over-cap order (refusal happens in the model, not here)", () => {
    const s = parseSkillsFromAnalysis(JAYCE_TOP)!;
    expect(s).toBeTruthy();
    expect(s.order.filter((a) => a === "Q")).toHaveLength(6);
    expect(s.order.filter((a) => a === "R")).toHaveLength(0);
  });
});

describe("parseSkillsFromAnalysis — refuses rather than mis-parses", () => {
  it("rejects empty / non-string input", () => {
    expect(parseSkillsFromAnalysis("")).toBeNull();
    expect(parseSkillsFromAnalysis(undefined as unknown as string)).toBeNull();
    expect(parseSkillsFromAnalysis(null as unknown as string)).toBeNull();
  });

  it("rejects a payload whose declared Skills fields CHANGED", () => {
    // A renamed field, an added field, a dropped field: all "shape changed".
    const renamed = AHRI_MID_FULL.replace(
      "class Skills: order,play,win,pick_rate",
      "class Skills: order,plays,win,pick_rate"
    );
    expect(parseSkillsFromAnalysis(renamed)).toBeNull();

    const added = AHRI_MID_FULL.replace(
      "class Skills: order,play,win,pick_rate",
      "class Skills: order,play,win,pick_rate,extra"
    );
    expect(parseSkillsFromAnalysis(added)).toBeNull();

    const dropped = AHRI_MID_FULL.replace(
      "class Skills: order,play,win,pick_rate",
      "class Skills: order,play,win"
    );
    expect(parseSkillsFromAnalysis(dropped)).toBeNull();
  });

  it("rejects a payload with no Skills class at all", () => {
    expect(parseSkillsFromAnalysis("class Data: summary\n\nFoo(1)")).toBeNull();
  });

  it("rejects an arg count that disagrees with the declared field count", () => {
    const broken = AHRI_MID_SLIM.replace(
      'Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.57,71667,41408)',
      'Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.57,71667)'
    );
    expect(broken).not.toBe(AHRI_MID_SLIM);
    expect(parseSkillsFromAnalysis(broken)).toBeNull();
  });

  it("rejects a non-ability token in the order", () => {
    const broken = AHRI_MID_SLIM.replace('["W","Q","E"', '["W","X","E"');
    expect(broken).not.toBe(AHRI_MID_SLIM);
    expect(parseSkillsFromAnalysis(broken)).toBeNull();
  });

  it("rejects a non-numeric or impossible play/win", () => {
    const nan = AHRI_MID_SLIM.replace(",0.57,71667,41408)", ",0.57,abc,41408)");
    expect(parseSkillsFromAnalysis(nan)).toBeNull();

    const zeroPlay = AHRI_MID_SLIM.replace(",0.57,71667,41408)", ",0.57,0,0)");
    expect(parseSkillsFromAnalysis(zeroPlay)).toBeNull();

    // More wins than games is not a sample we should ever render.
    const tooManyWins = AHRI_MID_SLIM.replace(",0.57,71667,41408)", ",0.57,100,999)");
    expect(parseSkillsFromAnalysis(tooManyWins)).toBeNull();
  });

  it("still parses when skill_masteries is absent — priority is optional", () => {
    const noMasteries = AHRI_MID_SLIM.replace(/,SkillMasteries\(.*\)\)\)$/, ")))");
    const s = parseSkillsFromAnalysis(noMasteries);
    expect(s).toBeTruthy();
    expect(s!.play).toBe(71667);
    expect(s!.priorityIds).toBeUndefined();
  });

  // ── The priority is LOAD-BEARING now (it completes Udyr/Yuumi/Aphelios to
  // 18 levels), so it gets the same map-by-name treatment `Skills` has always
  // had. These pin that it is read by NAME and that an unrecognised shape
  // costs the priority only — never the whole card, and never a mis-read.
  it("maps skill_masteries fields BY NAME, not by position", () => {
    // The slim payload declares `ids,pick_rate,play,win,builds`. Swap the
    // first two in BOTH the header and the call, exactly as op.gg has already
    // been observed doing to `Skills`. A reader hardcoding index 0 now picks
    // up `0.92` — a rate — as the priority list. A by-name reader is unmoved.
    const reordered = AHRI_MID_SLIM.replace(
      "class SkillMasteries: ids,pick_rate,play,win,builds",
      "class SkillMasteries: pick_rate,ids,play,win,builds"
    ).replace('SkillMasteries(["Q","W","E"],0.92,', 'SkillMasteries(0.92,["Q","W","E"],');
    expect(reordered).not.toBe(AHRI_MID_SLIM);
    const s = parseSkillsFromAnalysis(reordered);
    expect(s).toBeTruthy();
    expect(s!.priorityIds).toEqual(["Q", "W", "E"]);
  });

  it("drops ONLY the priority when skill_masteries declares an unknown field set", () => {
    // `builds` → `tier`: the field COUNT is unchanged (so the arity check
    // still passes and a laxer parser would happily read ids), but the SET is
    // one we have never seen and therefore do not claim to understand.
    const unknownSet = AHRI_MID_SLIM.replace(
      "class SkillMasteries: ids,pick_rate,play,win,builds",
      "class SkillMasteries: ids,pick_rate,play,win,tier"
    );
    expect(unknownSet).not.toBe(AHRI_MID_SLIM);
    const s = parseSkillsFromAnalysis(unknownSet);
    // The card SURVIVES — the order parsed fine and the model derives a
    // priority from it. Only the published ranking is discarded. That
    // asymmetry against `Skills` (whose unknown set nulls everything) is the
    // point: refuse at the smallest granularity the data allows.
    expect(s).toBeTruthy();
    expect(s!.order).toHaveLength(15);
    expect(s!.play).toBe(71667);
    expect(s!.priorityIds).toBeUndefined();
  });

  it("drops a malformed ids list rather than half-using it", () => {
    for (const bad of ['["Q","Q","W"]', '["Q","X"]', "[]"]) {
      const broken = AHRI_MID_SLIM.replace('SkillMasteries(["Q","W","E"],0.92,', `SkillMasteries(${bad},0.92,`);
      expect(broken, bad).not.toBe(AHRI_MID_SLIM);
      const s = parseSkillsFromAnalysis(broken);
      expect(s, bad).toBeTruthy();
      expect(s!.priorityIds, bad).toBeUndefined();
    }
  });
});

describe("extractEnvelopeText", () => {
  it("pulls the text out of a success envelope", () => {
    expect(extractEnvelopeText({ result: { content: [{ text: "hi" }] } })).toBe("hi");
  });

  it("returns null for a JSON-RPC error (which arrives over HTTP 200)", () => {
    const env = JSON.parse(UNKNOWN_CHAMPION_ENVELOPE);
    expect(env.error).toBeTruthy();
    expect(env.error.message).toBe("Unknown champion provided.");
    expect(extractEnvelopeText(env)).toBeNull();
  });

  it("returns null on every malformed envelope", () => {
    for (const bad of [null, undefined, 1, "x", {}, { result: {} }, { result: { content: [] } }, { result: { content: [{}] } }]) {
      expect(extractEnvelopeText(bad)).toBeNull();
    }
  });
});

describe("buildSkillOrderRpc", () => {
  it("asks only for the skills fields", () => {
    const rpc = buildSkillOrderRpc({ champion: "AHRI", position: "mid" }) as any;
    expect(rpc.method).toBe("tools/call");
    expect(rpc.params.name).toBe("lol_get_champion_analysis");
    expect(rpc.params.arguments.champion).toBe("AHRI");
    expect(rpc.params.arguments.position).toBe("mid");
    expect(rpc.params.arguments.game_mode).toBe("ranked");
    expect(rpc.params.arguments.desired_output_fields).toContain(
      "data.skills.{order[],pick_rate,play,win}"
    );
  });
});

describe("fetchSkillOrder — degrades to null, never throws", () => {
  const okTransport: OpggTransport = async () => ({
    result: { content: [{ text: AHRI_MID_SLIM }] },
  });

  it("returns a full model on success", async () => {
    const m = await fetchSkillOrder("Ahri", 2 as RoleId, okTransport);
    expect(m).toBeTruthy();
    expect(m!.completed).toBe(true);
    expect(m!.order).toHaveLength(18);
    expect(m!.sampleSize).toBe(71667);
    expect(m!.winRate).toBeCloseTo(41408 / 71667, 10);
  });

  it("returns null for role 5 WITHOUT making a request", async () => {
    const spy = vi.fn(okTransport);
    expect(await fetchSkillOrder("Ahri", 5 as RoleId, spy)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null on a JSON-RPC error envelope", async () => {
    const t: OpggTransport = async () => JSON.parse(UNKNOWN_CHAMPION_ENVELOPE);
    expect(await fetchSkillOrder("Notachampion", 2 as RoleId, t)).toBeNull();
  });

  it("returns null when the transport throws (timeout / network / 5xx)", async () => {
    const t: OpggTransport = async () => {
      throw new Error("boom");
    };
    expect(await fetchSkillOrder("Ahri", 2 as RoleId, t)).toBeNull();
  });

  it("returns null on an unrecognised payload shape", async () => {
    const t: OpggTransport = async () => ({ result: { content: [{ text: "class Foo: bar\n\nFoo(1)" }] } });
    expect(await fetchSkillOrder("Ahri", 2 as RoleId, t)).toBeNull();
  });

  it("sends the derived champion name and position", async () => {
    const spy = vi.fn(okTransport);
    await fetchSkillOrder("MissFortune", 3 as RoleId, spy);
    const sent = spy.mock.calls[0][0] as any;
    expect(sent.params.arguments.champion).toBe("MISS_FORTUNE");
    expect(sent.params.arguments.position).toBe("adc");
  });

  it("returns a model with completed:false for a non-standard champion, never a wrong 18", async () => {
    const t: OpggTransport = async () => ({ result: { content: [{ text: UDYR_JUNGLE }] } });
    const m = await fetchSkillOrder("Udyr", 1 as RoleId, t);
    expect(m).toBeTruthy();
    expect(m!.completed).toBe(false);
    expect(m!.order).toHaveLength(15);
    expect(Math.max(...Object.values(m!.levels).flat())).toBeLessThanOrEqual(15);
  });
});

describe("cache policy", () => {
  it("caches for 6h — patch-scale data, aligned with lib/coachless.ts", () => {
    expect(CACHE_TTL_SECONDS).toBe(21_600);
  });
});
