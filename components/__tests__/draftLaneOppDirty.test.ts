// ─────────────────────────────────────────────────────────────────────────────
// Structural pin (same technique as mystats-queue-invariant.test.ts): marking
// the lane opponent on /draft must NEVER latch the manual-dirty flag.
//
// Live repro 2026-09-05: the user tagged Vladimir as lane opponent at 3/5
// enemies picked; handleToggleLaneOpponent latched `dirty`, which makes
// resolveDraftLiveTarget return null, so enemy picks 4 and 5 never auto-filled
// and THE CALL was computed against a 3-enemy comp. Live sync never writes
// laneOpponentId, so the latch protected nothing — pure loss.
//
// These tests read the page source because the latch lives in component
// handlers (app/draft/page.tsx), not in the pure draftLiveSync module.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "../../desktop/ui/DraftPage.tsx"), "utf8");

function handlerBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists in app/draft/page.tsx`).toBeGreaterThan(-1);
  // Handlers here are short and brace-balanced; walk to the matching close.
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

describe("lane-opponent selection never detaches /draft from live", () => {
  it("handleToggleLaneOpponent does not latch dirty (re-adding setDirty(true) recreates the 2026-09-05 freeze)", () => {
    expect(handlerBody("handleToggleLaneOpponent")).not.toContain("setDirty(true)");
  });

  it("control: genuinely conflicting manual edits still latch dirty", () => {
    // These overwrite fields live sync DOES write (lane/enemies/hover), so
    // they must keep latching — this is the absence-assertion's control.
    for (const name of ["handleLaneChange", "handleAddEnemy", "handleRemoveEnemy", "handleHoverChange", "handleClearHover"]) {
      expect(handlerBody(name), `${name} still latches dirty`).toContain("setDirty(true)");
    }
  });

  it("live enemy updates clear a lane-opponent tag whose champion left the list", () => {
    // Because the tag survives live sync now, the sync effect must apply the
    // same stale-tag guard handleRemoveEnemy applies to manual removal.
    const effect = source.slice(source.indexOf("resolveDraftLiveTarget({"), source.indexOf("}, [status, dirty])"));
    expect(effect).toMatch(/setLaneOpponentId\(current =>.*\? current : null\)/);
    expect(effect).toMatch(/target\.enemies\.includes\(/);
  });
});
