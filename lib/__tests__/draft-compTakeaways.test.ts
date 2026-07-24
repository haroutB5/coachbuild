import { describe, it, expect } from "vitest";
import { deriveTakeaways } from "../draft/compTakeaways";
import type { AggregatedComp } from "../draft/compRatings";

function comp(over: Partial<AggregatedComp>): AggregatedComp {
  return { cc: 0, damage: 0, tankiness: 0, mobility: 0, utility: 0, engage: 0, estimatedCount: 0, ...over };
}

describe("deriveTakeaways", () => {
  it("all-neutral comp -> no takeaways", () => {
    expect(deriveTakeaways(comp({ mobility: 1.5 }))).toEqual([]);
  });

  it("heavy CC (>= 2.2) -> Cleanse/Tenacity line", () => {
    expect(deriveTakeaways(comp({ cc: 2.2, mobility: 1.5 }))).toEqual(["Heavy CC — consider Cleanse or Tenacity"]);
  });

  it("just under the CC floor does not fire", () => {
    expect(deriveTakeaways(comp({ cc: 2.19, mobility: 1.5 }))).toEqual([]);
  });

  it("strong engage (>= 2.4) -> respect all-ins line", () => {
    expect(deriveTakeaways(comp({ engage: 2.4, mobility: 1.5 }))).toEqual(["Strong engage — respect all-ins"]);
  });

  it("front-to-back requires BOTH tankiness >= 2.2 AND damage >= 2.0", () => {
    expect(deriveTakeaways(comp({ tankiness: 2.2, damage: 1.9, mobility: 1.5 }))).toEqual([]);
    expect(deriveTakeaways(comp({ tankiness: 2.2, damage: 2.0, mobility: 1.5 }))).toEqual([
      "Front-to-back comp — anti-tank shred values up",
    ]);
  });

  it("low mobility (<= 1.2) -> poke-is-safe line", () => {
    expect(deriveTakeaways(comp({ mobility: 1.2 }))).toEqual(["Low mobility — long-range poke is safe"]);
  });

  it("high utility (>= 2.4) -> peel/disengage line", () => {
    expect(deriveTakeaways(comp({ utility: 2.4, mobility: 1.5 }))).toEqual(["High utility — expect peel and disengage"]);
  });

  it("orders multiple firing signals as CC, engage, front-to-back, mobility, utility", () => {
    const c = comp({ cc: 3, engage: 3, tankiness: 3, damage: 3, mobility: 0, utility: 3 });
    expect(deriveTakeaways(c)).toEqual([
      "Heavy CC — consider Cleanse or Tenacity",
      "Strong engage — respect all-ins",
      "Front-to-back comp — anti-tank shred values up",
    ]);
  });

  it("caps at 3 even when all 5 signals fire", () => {
    const c = comp({ cc: 3, engage: 3, tankiness: 3, damage: 3, mobility: 0, utility: 3 });
    expect(deriveTakeaways(c).length).toBe(3);
  });

  it("estimatedCount never affects which takeaways fire", () => {
    const a = deriveTakeaways(comp({ cc: 3, mobility: 1.5, estimatedCount: 0 }));
    const b = deriveTakeaways(comp({ cc: 3, mobility: 1.5, estimatedCount: 5 }));
    expect(a).toEqual(b);
  });
});
