import { describe, it, expect, vi } from "vitest";
import {
  buildAccountRow,
  buildAccountRows,
  failureNeedsSecret,
  formatLastSeen,
  isMenuNavigationKey,
  linkDetectedAccount,
  pickerFailureMessage,
  pickerModeFor,
  resolveDetectPrompt,
  resolveMenuKeydown,
  switchAccount,
} from "@/components/hextech/mystats/accountPickerModel";
import type { AccountSummary, AccountsCallOutcome } from "@/components/live/mystatsAccount";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");

function account(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 1,
    riotId: "MunsterHunter#EUW",
    gameName: "MunsterHunter",
    tagLine: "EUW",
    region: "EUW",
    active: true,
    lastSeenAt: null,
    games: 138,
    // engy §1a rank fields (2026-07-30). Defaulted to the UNKNOWN state — "we
    // have never read this account's rank" — because that is what the picker
    // sees for any account that has not been active, and because the alternative
    // default (rankUnknown:false) would assert an unranked standing this fixture
    // has not earned.
    tier: null,
    division: null,
    lp: null,
    rankWins: null,
    rankLosses: null,
    rankUnknown: true,
    rankCheckedAt: null,
    ...over,
  };
}

function okOutcome(over: Partial<AccountsCallOutcome & { result: unknown }> = {}): AccountsCallOutcome {
  return {
    ok: true,
    result: {
      accounts: [account()],
      activeId: 1,
      riotId: "MunsterHunter#EUW",
      created: false,
      switched: true,
      ...((over as { result?: object }).result ?? {}),
    },
  } as AccountsCallOutcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THAT MATTERS: switched:true MUST re-fetch the summary.
// ─────────────────────────────────────────────────────────────────────────────

describe("switchAccount — the re-fetch invariant", () => {
  it("re-fetches the summary when the active account actually changed", async () => {
    const refetchSummary = vi.fn();
    const select = vi.fn(async () => okOutcome({ result: { switched: true } } as never));

    const result = await switchAccount(2, { select, refetchSummary });

    expect(select).toHaveBeenCalledWith(2);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.switched).toBe(true);
    // The whole point of the multi-account backend change: every number on
    // /mystats is account-scoped, so a switch invalidates all of them.
    expect(refetchSummary).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-fetch when the server says nothing changed", async () => {
    const refetchSummary = vi.fn();
    const select = vi.fn(async () => okOutcome({ result: { switched: false } } as never));

    const result = await switchAccount(1, { select, refetchSummary });

    expect(result.status === "ok" && result.switched).toBe(false);
    expect(refetchSummary).not.toHaveBeenCalled();
  });

  it("does NOT re-fetch on a failure, and reports the reason", async () => {
    const refetchSummary = vi.fn();
    for (const reason of ["unauthorized", "no-secret", "no-such-account", "network-error"]) {
      const select = vi.fn(async () => ({ ok: false, reason }) as AccountsCallOutcome);
      const result = await switchAccount(2, { select, refetchSummary });
      expect(result).toEqual({ status: "failed", reason });
    }
    expect(refetchSummary).not.toHaveBeenCalled();
  });

  it("hands back the server's fresh list, never a locally-patched one", async () => {
    const fresh = [account({ id: 2, riotId: "K1ayer#swift", active: true }), account({ id: 1, active: false })];
    const select = async () =>
      okOutcome({ result: { accounts: fresh, activeId: 2, riotId: "K1ayer#swift", switched: true } } as never);
    const result = await switchAccount(2, { select, refetchSummary: () => {} });
    expect(result.status === "ok" && result.accounts).toBe(fresh);
    expect(result.status === "ok" && result.activeId).toBe(2);
  });
});

describe("linkDetectedAccount", () => {
  it("re-fetches on switched:true, same rule as a switch", async () => {
    const refetchSummary = vi.fn();
    const result = await linkDetectedAccount({
      select: async () => okOutcome(),
      refetchSummary,
      link: async () => okOutcome({ result: { switched: true, created: true } } as never),
    });
    expect(result.status === "ok" && result.created).toBe(true);
    expect(refetchSummary).toHaveBeenCalledTimes(1);
  });

  it("treats nothing-to-report as a failure, not a silent success", async () => {
    const refetchSummary = vi.fn();
    const result = await linkDetectedAccount({
      select: async () => okOutcome(),
      refetchSummary,
      link: async () => ({ ok: false as const, reason: "nothing-to-report" }),
    });
    expect(result).toEqual({ status: "failed", reason: "nothing-to-report" });
    expect(refetchSummary).not.toHaveBeenCalled();
  });

  it("never calls select — linking goes through the detect POST only", async () => {
    const select = vi.fn(async () => okOutcome());
    await linkDetectedAccount({
      select,
      refetchSummary: () => {},
      link: async () => okOutcome({ result: { switched: true } } as never),
    });
    expect(select).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("pickerModeFor", () => {
  it("distinguishes empty / single / menu", () => {
    expect(pickerModeFor([])).toBe("empty");
    expect(pickerModeFor([account()])).toBe("single");
    expect(pickerModeFor([account(), account({ id: 2, active: false })])).toBe("menu");
  });
});

describe("resolveMenuKeydown", () => {
  it("moves down and up, wrapping at both ends", () => {
    expect(resolveMenuKeydown("ArrowDown", 0, 3)).toBe(1);
    expect(resolveMenuKeydown("ArrowDown", 2, 3)).toBe(0);
    expect(resolveMenuKeydown("ArrowUp", 0, 3)).toBe(2);
    expect(resolveMenuKeydown("ArrowUp", 2, 3)).toBe(1);
  });

  it("jumps to the ends with Home/End", () => {
    expect(resolveMenuKeydown("Home", 2, 3)).toBe(0);
    expect(resolveMenuKeydown("End", 0, 3)).toBe(2);
  });

  it("ignores the horizontal arrows the tablist owns, and every other key", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "Enter", " ", "Tab", "Escape", "a"]) {
      expect(resolveMenuKeydown(key, 0, 3)).toBeNull();
      expect(isMenuNavigationKey(key)).toBe(false);
    }
  });

  it("never returns NaN for an out-of-range index or an empty list", () => {
    expect(resolveMenuKeydown("ArrowDown", 99, 3)).toBe(1);
    expect(resolveMenuKeydown("ArrowUp", -4, 3)).toBe(2);
    expect(resolveMenuKeydown("ArrowDown", 0, 0)).toBeNull();
  });

  it("agrees with isMenuNavigationKey about which keys it owns", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(isMenuNavigationKey(key)).toBe(true);
      expect(resolveMenuKeydown(key, 0, 2)).not.toBeNull();
    }
  });
});

describe("formatLastSeen", () => {
  it("returns null when there is nothing honest to say", () => {
    expect(formatLastSeen(null, NOW)).toBeNull();
    expect(formatLastSeen("not-a-date", NOW)).toBeNull();
  });

  it("bands minutes / hours / days / months / years", () => {
    expect(formatLastSeen(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
    expect(formatLastSeen(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    expect(formatLastSeen(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago");
    expect(formatLastSeen(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe("5d ago");
    expect(formatLastSeen(new Date(NOW - 60 * 86_400_000).toISOString(), NOW)).toBe("2mo ago");
    expect(formatLastSeen(new Date(NOW - 400 * 86_400_000).toISOString(), NOW)).toBe("1y ago");
  });

  it("clamps a future timestamp instead of printing a negative age", () => {
    expect(formatLastSeen(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("buildAccountRow", () => {
  it("omits the last-seen segment entirely when never seen", () => {
    const row = buildAccountRow(account({ lastSeenAt: null }), NOW);
    expect(row.meta).toBe("EUW · 138 games");
    expect(row.meta).not.toMatch(/seen|never/);
  });

  it("includes it when there is one", () => {
    const row = buildAccountRow(account({ lastSeenAt: new Date(NOW - 2 * 3_600_000).toISOString() }), NOW);
    expect(row.meta).toBe("EUW · 138 games · seen 2h ago");
  });

  it("singularises one game and says 0 rather than hiding it", () => {
    expect(buildAccountRow(account({ games: 1 }), NOW).meta).toBe("EUW · 1 game");
    expect(buildAccountRow(account({ games: 0 }), NOW).meta).toBe("EUW · 0 games");
  });

  it("spells the meta out for a screen reader, and marks the active row", () => {
    const row = buildAccountRow(account({ active: true }), NOW);
    expect(row.srLabel).toBe("MunsterHunter#EUW, region EUW, 138 games stored, currently active");
    expect(buildAccountRow(account({ active: false }), NOW).srLabel).not.toMatch(/currently active/);
  });

  it("keeps the server's order — active first — instead of re-sorting", () => {
    const rows = buildAccountRows(
      [account({ id: 5, riotId: "B#EUW", active: true }), account({ id: 1, riotId: "A#EUW", active: false })],
      NOW
    );
    expect(rows.map((r) => r.id)).toEqual([5, 1]);
  });

  it("carries no puuid field into the view model", () => {
    const row = buildAccountRow(account(), NOW) as unknown as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(["id", "riotId", "active", "meta", "metaSegments", "srLabel"]);
  });

  it("exposes the meta line as unjoined segments so a narrow row wraps between them", () => {
    const row = buildAccountRow(account({ region: "EUW", games: 156, lastSeenAt: "2026-07-29T11:00:00.000Z" }), NOW);
    expect(row.metaSegments).toEqual(["EUW", "156 games", "seen 1h ago"]);
    expect(row.metaSegments.join(" · ")).toBe(row.meta);
  });

  it("omits an absent segment from metaSegments rather than padding it", () => {
    const row = buildAccountRow(account({ region: "NA1", games: 1, lastSeenAt: null }), NOW);
    expect(row.metaSegments).toEqual(["NA1", "1 game"]);
  });
});

describe("resolveDetectPrompt", () => {
  const munster = account({ id: 1, riotId: "MunsterHunter#EUW", active: true });
  const k1ayer = account({ id: 2, riotId: "K1ayer#swift", gameName: "K1ayer", tagLine: "swift", active: false });

  it("offers nothing when there is no identity to report", () => {
    expect(resolveDetectPrompt(null, [munster], "MunsterHunter#EUW")).toEqual({ kind: "none" });
  });

  it("offers nothing when the client already matches the active account", () => {
    expect(
      resolveDetectPrompt({ gameName: "MunsterHunter", tagLine: "EUW" }, [munster], "MunsterHunter#EUW")
    ).toEqual({ kind: "none" });
  });

  it("offers a SWITCH, by opaque id, when the client's account is already linked", () => {
    expect(resolveDetectPrompt({ gameName: "K1ayer", tagLine: "swift" }, [munster, k1ayer], "MunsterHunter#EUW")).toEqual(
      { kind: "switch", id: 2, riotId: "K1ayer#swift" }
    );
  });

  it("offers a LINK when the client's account is not linked", () => {
    expect(resolveDetectPrompt({ gameName: "K1ayer", tagLine: "swift" }, [munster], "MunsterHunter#EUW")).toEqual({
      kind: "link",
      riotId: "K1ayer#swift",
    });
  });

  it("offers a link when nothing is active yet (accountUnresolved)", () => {
    expect(resolveDetectPrompt({ gameName: "K1ayer", tagLine: "swift" }, [], null)).toEqual({
      kind: "link",
      riotId: "K1ayer#swift",
    });
  });

  it("never offers a switch to the row already flagged active (list/label disagreement)", () => {
    // A summary response in flight can leave `activeRiotId` behind the list.
    expect(
      resolveDetectPrompt({ gameName: "K1ayer", tagLine: "swift" }, [account({ id: 2, riotId: "K1ayer#swift", active: true })], "MunsterHunter#EUW")
    ).toEqual({ kind: "none" });
  });

  it("treats a custom tagLine as a tag, never as a region", () => {
    const p = resolveDetectPrompt({ gameName: "K1ayer", tagLine: "swift" }, [], null);
    expect(p.kind === "link" && p.riotId).toBe("K1ayer#swift");
  });
});

describe("pickerFailureMessage", () => {
  it("distinguishes the three failures whose FIXES differ", () => {
    expect(pickerFailureMessage("no-secret")).toMatch(/enter your account secret/i);
    expect(pickerFailureMessage("unauthorized")).toMatch(/rejected/i);
    expect(pickerFailureMessage("not-configured")).toMatch(/server/i);
  });

  it("says nothing changed for every failure where nothing was written", () => {
    for (const reason of ["region-unresolved", "riot-unavailable", "network-error", "malformed-response"]) {
      expect(pickerFailureMessage(reason)).toMatch(/nothing changed/i);
    }
  });

  it("degrades to generic text plus the token for an unknown reason", () => {
    expect(pickerFailureMessage("http-418")).toBe("Couldn't switch accounts (http-418).");
  });

  it("only the two secret failures re-open the secret field", () => {
    expect(failureNeedsSecret("no-secret")).toBe(true);
    expect(failureNeedsSecret("unauthorized")).toBe(true);
    for (const reason of ["not-configured", "no-such-account", "network-error", "region-unresolved"]) {
      expect(failureNeedsSecret(reason)).toBe(false);
    }
  });
});
