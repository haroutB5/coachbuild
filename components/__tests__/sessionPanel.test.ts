import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SessionPanel from "@/components/hextech/SessionPanel";
import { SESSIONS_LIMIT, type SessionLpDelta, type SessionSummary } from "@/lib/mystats/sessions";

function session(lpDelta: SessionLpDelta, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    startedAt: "2026-08-20T18:00:00.000Z",
    endedAt: "2026-08-20T21:00:00.000Z",
    wins: 5,
    losses: 3,
    lpDelta,
    ...over,
  };
}

function render(sessions: SessionSummary[]): string {
  return renderToStaticMarkup(
    createElement(SessionPanel, { sessions, locale: "en-GB", timeZone: "UTC" })
  );
}

describe("SessionPanel", () => {
  it("renders an exact gain as a plain signed, positive-colour number", () => {
    const html = render([session({ value: 42, confidence: "exact" })]);

    expect(html).toContain("5W 3L");
    expect(html).toContain('class="font-semibold tabular-nums text-good">+42</span>');
    expect(html).not.toContain("≈");
    expect(html).not.toContain("Estimated LP change");
  });

  it("visibly marks an approximate loss and explains its reason and extra games", () => {
    const html = render([
      session({
        value: -18,
        confidence: "approximate",
        reason: "extra-games",
        extraGames: 2,
      }),
    ]);

    expect(html).toContain('class="font-semibold tabular-nums text-bad"');
    expect(html).toContain('<span aria-hidden="true">≈</span> −18');
    expect(html).toContain("The LP readings also bracket games outside this session.");
    expect(html).toContain("2 extra games included.");
  });

  it("renders a dash for unavailable LP and never leaks its numeric field", () => {
    const html = render([
      session({ value: 0, confidence: "unavailable", reason: "no-samples" }),
    ]);

    expect(html).toContain('aria-label="LP change unavailable">—</span>');
    expect(html).not.toContain(">0</span>");
    expect(html).not.toContain("+0");
  });

  it("keeps a midnight-spanning sitting in one row labelled by its start date", () => {
    const html = render([
      session(
        { value: null, confidence: "unavailable", reason: "no-samples" },
        {
          startedAt: "2026-08-14T22:40:00.000Z",
          endedAt: "2026-08-15T01:32:00.000Z",
          wins: 3,
          losses: 2,
        }
      ),
    ]);

    expect(html.match(/<li/g)).toHaveLength(1);
    expect(html).toContain("14 Aug 2026");
    expect(html).toContain("22:40");
    expect(html).toContain("01:32");
    expect(html).toContain("(+1 day)");
    expect(html).not.toContain("15 Aug 2026");
  });

  it("takes the panel cap from the shared sessions contract", () => {
    expect(render([])).toContain(`Last ${SESSIONS_LIMIT}`);
  });
});
