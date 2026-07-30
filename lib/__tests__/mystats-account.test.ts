/**
 * Tests for lib/mystats/account.ts -- the linked-account registry (migration
 * 0020). sql and the Riot client are mocked; nothing here touches a network or a
 * database.
 *
 * Two properties matter most and neither is obvious from reading the code:
 *
 *  1. THE RIOT-CALL BUDGET. linkAccount is called on every My Stats page view,
 *     and the Riot key is shared with every other pipeline in this app (CLAUDE.md
 *     gotcha (d)). An already-linked account must cost ZERO Riot calls; only a
 *     genuinely new puuid may spend one. A regression here is invisible until the
 *     key is suspended.
 *  2. REGION IS RESOLVED, NEVER GUESSED. An unmapped platform must REFUSE to
 *     write rather than fall back to a default region -- a wrong region points
 *     match-v5 at the wrong cluster and reports "no games" as if it were true.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRegionByPuuid = vi.fn();
const mockGetAccountByRiotId = vi.fn();
vi.mock("@/lib/pro/riot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pro/riot")>("@/lib/pro/riot");
  return {
    ...actual,
    getRegionByPuuid: (...a: unknown[]) => mockGetRegionByPuuid(...a),
    getAccountByRiotId: (...a: unknown[]) => mockGetAccountByRiotId(...a),
  };
});

import {
  getActiveAccount,
  listAccounts,
  linkAccount,
  setActiveAccount,
  splitRiotId,
  formatRiotId,
} from "@/lib/mystats/account";
import { RiotRequestError } from "@/lib/pro/riot";
import { RiotUnavailableError } from "@/lib/pro/errors";

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("|");
}

/** The Neon HTTP driver's `sql` is a FUNCTION WITH A `.transaction()` PROPERTY,
 *  and setActiveAccount uses it (2026-07-30 — its two UPDATEs must both land or
 *  neither; see that function's doc comment). A bare vi.fn() has no such
 *  property, so every sql mock in this file is built here instead.
 *
 *  The stand-in EXECUTES the queries it is handed. With the real driver a
 *  tagged-template call is lazy and only runs inside the transaction; with a
 *  vi.fn it has already run by the time transaction() sees it. Either way the
 *  statements are recorded in source order, which is what the ordering
 *  assertions below actually care about. */
function sqlMock(impl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) {
  const fn = vi.fn(impl) as ReturnType<typeof vi.fn> & {
    transaction: ReturnType<typeof vi.fn>;
  };
  fn.transaction = vi.fn((queries: unknown[]) => Promise.all(queries as Promise<unknown>[]));
  return fn;
}

describe("splitRiotId / formatRiotId", () => {
  it("round-trips a normal region tag", () => {
    expect(splitRiotId("MunsterHunter#EUW")).toEqual({ gameName: "MunsterHunter", tagLine: "EUW" });
    expect(formatRiotId("MunsterHunter", "EUW")).toBe("MunsterHunter#EUW");
  });

  it("round-trips a CUSTOM tag -- the user's own second account", () => {
    expect(splitRiotId("K1ayer#swift")).toEqual({ gameName: "K1ayer", tagLine: "swift" });
  });

  it("null on a malformed id rather than a half-parsed one", () => {
    expect(splitRiotId("nohash")).toBeNull();
    expect(splitRiotId("#EUW")).toBeNull();
    expect(splitRiotId("name#")).toBeNull();
  });

  it("splits on the FIRST hash only, so the remainder stays intact rather than being truncated", () => {
    expect(splitRiotId("a#b#c")).toEqual({ gameName: "a", tagLine: "b#c" });
  });
});

describe("getActiveAccount", () => {
  it("selects WHERE active, and resolves routing from the stored region", async () => {
    let seenText = "";
    const sql = sqlMock((strings: TemplateStringsArray) => {
      seenText = sqlText(strings);
      return Promise.resolve([{ id: 1, riot_id: "MunsterHunter#EUW", puuid: "p1", region: "EUW" }]);
    });
    const account = await getActiveAccount(sql as never);
    expect(seenText).toContain("WHERE active");
    expect(account).toEqual({
      id: 1,
      puuid: "p1",
      riotId: "MunsterHunter#EUW",
      gameName: "MunsterHunter",
      tagLine: "EUW",
      region: "EUW",
      routing: { platform: "euw1", regional: "europe" },
    });
  });

  it("null when nothing is active -- callers must show the empty state, never fall back to unscoped data", async () => {
    const sql = sqlMock(() => Promise.resolve([]));
    expect(await getActiveAccount(sql as never)).toBeNull();
  });

  it("null (not a guessed routing) when the stored region is unmapped", async () => {
    const sql = sqlMock(() => Promise.resolve([{ id: 1, riot_id: "X#swift", puuid: "p1", region: "swift" }]));
    expect(await getActiveAccount(sql as never)).toBeNull();
  });
});

describe("setActiveAccount", () => {
  it("deactivates the others then activates the target, and re-reads the result", async () => {
    const statements: string[] = [];
    const sql = sqlMock((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      statements.push(text);
      if (text.includes("SELECT id FROM coachbuild.my_account WHERE id")) return Promise.resolve([{ id: 2 }]);
      if (text.includes("WHERE active") && text.includes("SELECT")) {
        return Promise.resolve([{ id: 2, riot_id: "K1ayer#swift", puuid: "p2", region: "EUW" }]);
      }
      return Promise.resolve([]);
    });

    const account = await setActiveAccount(sql as never, 2);
    expect(account?.id).toBe(2);
    const deactivate = statements.findIndex((s) => s.includes("SET active = false"));
    const activate = statements.findIndex((s) => s.includes("SET active = true"));
    expect(deactivate).toBeGreaterThanOrEqual(0);
    expect(activate).toBeGreaterThan(deactivate); // order matters: the partial unique index rejects the reverse
  });

  it("runs BOTH updates in ONE transaction -- not two independent round trips", async () => {
    // The partial unique index already makes TWO active rows impossible. What it
    // cannot prevent is a crash between the two statements leaving ZERO active,
    // which renders the accountUnresolved empty state for an account the user
    // definitely linked. Two statements that must both land are a transaction, so
    // this pins that they are actually issued as one.
    const sql = sqlMock((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("SELECT id FROM coachbuild.my_account WHERE id")) return Promise.resolve([{ id: 2 }]);
      if (text.includes("WHERE active") && text.includes("SELECT")) {
        return Promise.resolve([{ id: 2, riot_id: "K1ayer#swift", puuid: "p2", region: "EUW" }]);
      }
      return Promise.resolve([]);
    });

    await setActiveAccount(sql as never, 2);

    expect(sql.transaction).toHaveBeenCalledTimes(1);
    const [queries] = sql.transaction.mock.calls[0] as [unknown[]];
    expect(queries).toHaveLength(2); // deactivate + activate, nothing else smuggled in
  });

  it("null for an unknown id, and writes NOTHING", async () => {
    const statements: string[] = [];
    const sql = sqlMock((strings: TemplateStringsArray) => {
      statements.push(sqlText(strings));
      return Promise.resolve([]); // the existence check finds no row
    });
    expect(await setActiveAccount(sql as never, 99)).toBeNull();
    expect(statements.some((s) => s.includes("SET active"))).toBe(false);
    expect(sql.transaction).not.toHaveBeenCalled();
  });
});

describe("linkAccount", () => {
  beforeEach(() => {
    mockGetRegionByPuuid.mockReset();
    mockGetAccountByRiotId.mockReset();
  });

  /** Fake sql over an in-memory account table. */
  function makeSql(rows: { id: number; riot_id: string; puuid: string; region: string; active: boolean }[]) {
    let nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
    const sql = sqlMock((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sqlText(strings);
      // The already-linked fast path keys on riot_id, not puuid: the client can
      // no longer supply a usable puuid (see DetectedIdentity).
      if (text.includes("SELECT puuid, region FROM coachbuild.my_account WHERE riot_id")) {
        return Promise.resolve(
          rows.filter((r) => r.riot_id === values[0]).map((r) => ({ puuid: r.puuid, region: r.region }))
        );
      }
      if (text.includes("INSERT INTO coachbuild.my_account")) {
        const [riotId, puuid, region] = values as [string, string, string];
        const existing = rows.find((r) => r.puuid === puuid);
        if (existing) {
          existing.riot_id = riotId;
          existing.region = region;
        } else {
          rows.push({ id: nextId++, riot_id: riotId, puuid, region, active: false });
        }
        return Promise.resolve([]);
      }
      if (text.includes("SELECT id FROM coachbuild.my_account WHERE puuid")) {
        const row = rows.find((r) => r.puuid === values[0]);
        return Promise.resolve(row ? [{ id: row.id }] : []);
      }
      if (text.includes("SELECT id FROM coachbuild.my_account WHERE id")) {
        const row = rows.find((r) => r.id === values[0]);
        return Promise.resolve(row ? [{ id: row.id }] : []);
      }
      if (text.includes("SET active = false")) {
        for (const r of rows) if (r.id !== values[0]) r.active = false;
        return Promise.resolve([]);
      }
      if (text.includes("SET active = true")) {
        const row = rows.find((r) => r.id === values[0]);
        if (row) row.active = true;
        return Promise.resolve([]);
      }
      if (text.includes("SELECT id, riot_id, puuid, region FROM coachbuild.my_account WHERE active")) {
        const row = rows.find((r) => r.active);
        return Promise.resolve(row ? [{ id: row.id, riot_id: row.riot_id, puuid: row.puuid, region: row.region }] : []);
      }
      return Promise.resolve([]);
    });
    return { sql, rows };
  }

  it("a NEW account resolves its REAL puuid from the Riot ID, then its region -- never the caller's puuid", async () => {
    // The whole point of this test. v0.83.0 passed the client's puuid straight
    // to getRegionByPuuid; the LCU's value is a 36-char local UUID that Riot
    // 400s with "Exception decrypting", so a new account could never link.
    mockGetAccountByRiotId.mockResolvedValueOnce({ puuid: "REAL-78", gameName: "K1ayer", tagLine: "swift" });
    mockGetRegionByPuuid.mockResolvedValueOnce({ puuid: "REAL-78", game: "lol", region: "euw1" });
    const { sql, rows } = makeSql([{ id: 1, riot_id: "MunsterHunter#EUW", puuid: "p1", region: "EUW", active: true }]);

    const result = await linkAccount(sql as never, { gameName: "K1ayer", tagLine: "swift" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.account.riotId).toBe("K1ayer#swift");
    // "swift" is NOT a region -- euw1 came from Riot, mapped through routingForPlatform.
    expect(result.account.region).toBe("EUW");
    expect(result.account.routing.regional).toBe("europe");
    // Resolved by NAME first...
    expect(mockGetAccountByRiotId).toHaveBeenCalledTimes(1);
    expect(mockGetAccountByRiotId).toHaveBeenCalledWith(expect.anything(), "K1ayer", "swift");
    // ...and the region lookup used the RESOLVED puuid, which is the fix.
    expect(mockGetRegionByPuuid).toHaveBeenCalledWith(expect.anything(), "REAL-78");
    expect(rows.find((r) => r.puuid === "p1")!.active).toBe(false); // exactly one active
    expect(rows.find((r) => r.puuid === "REAL-78")!.active).toBe(true);
  });

  it("an ALREADY-LINKED account costs ZERO Riot calls -- this is what makes per-page-view detection safe", async () => {
    const { sql } = makeSql([
      { id: 1, riot_id: "MunsterHunter#EUW", puuid: "p1", region: "EUW", active: false },
      { id: 2, riot_id: "K1ayer#swift", puuid: "p2", region: "EUW", active: true },
    ]);
    const result = await linkAccount(sql as never, { gameName: "MunsterHunter", tagLine: "EUW" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.account.id).toBe(1); // the previously-INACTIVE account is now the active one
    // The fast path keys on riot_id now, so NEITHER call is made.
    expect(mockGetAccountByRiotId).not.toHaveBeenCalled();
    expect(mockGetRegionByPuuid).not.toHaveBeenCalled();
  });

  it("re-linking the ALREADY-ACTIVE account is idempotent and free", async () => {
    const { sql, rows } = makeSql([{ id: 1, riot_id: "MunsterHunter#EUW", puuid: "p1", region: "EUW", active: true }]);
    const result = await linkAccount(sql as never, { gameName: "MunsterHunter", tagLine: "EUW" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.account.id).toBe(1);
    expect(rows).toHaveLength(1);
    // The property that makes per-page-view detection safe against the shared
    // Riot key budget (CLAUDE.md gotcha (d)).
    expect(mockGetAccountByRiotId).not.toHaveBeenCalled();
    expect(mockGetRegionByPuuid).not.toHaveBeenCalled();
  });

  it("a RENAME misses the riot_id fast path, re-resolves to the SAME puuid, and updates in place", async () => {
    // Costs one resolve because the new name is not in the table -- but the
    // puuid comes back identical, so ON CONFLICT (puuid) moves the label and
    // orphans no match history. One call, once, per rename.
    mockGetAccountByRiotId.mockResolvedValueOnce({ puuid: "p1", gameName: "NewName", tagLine: "EUW" });
    mockGetRegionByPuuid.mockResolvedValueOnce({ puuid: "p1", game: "lol", region: "euw1" });
    const { sql, rows } = makeSql([{ id: 1, riot_id: "OldName#EUW", puuid: "p1", region: "EUW", active: true }]);
    const result = await linkAccount(sql as never, { gameName: "NewName", tagLine: "EUW" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.id).toBe(1);
    expect(result.account.riotId).toBe("NewName#EUW");
    expect(rows).toHaveLength(1); // renamed, NOT duplicated -- puuid is the identity
  });

  it("a Riot ID that does not exist is account-not-found, NOT riot-unavailable", async () => {
    // 404 is final and the user fixes it by correcting the name. Reporting it
    // as a transient failure would invite an endless retry; reporting a
    // rate-limited key as this would tell someone their real account is gone.
    mockGetAccountByRiotId.mockRejectedValueOnce(
      new RiotRequestError("https://europe.api.riotgames.com/riot/account/v1/accounts", 404, "Not Found")
    );
    const { sql, rows } = makeSql([]);
    const result = await linkAccount(sql as never, { gameName: "NoSuchPlayer", tagLine: "XXXX" });
    expect(result).toEqual({ ok: false, reason: "account-not-found" });
    expect(rows).toHaveLength(0);
    expect(mockGetRegionByPuuid).not.toHaveBeenCalled(); // never reached
  });

  it.each([400, 403, 429, 503])(
    "HTTP %i while resolving is riot-unavailable -- ours to fix, and retryable",
    async (status) => {
      mockGetAccountByRiotId.mockRejectedValueOnce(
        new RiotRequestError("https://europe.api.riotgames.com/riot/account/v1/accounts", status, "x")
      );
      const { sql, rows } = makeSql([]);
      const result = await linkAccount(sql as never, { gameName: "A", tagLine: "B" });
      expect(result).toEqual({ ok: false, reason: "riot-unavailable" });
      expect(rows).toHaveLength(0); // never write a half-known row
    }
  );

  it("REFUSES to write when Riot returns a platform this app cannot map -- never a default region", async () => {
    mockGetAccountByRiotId.mockResolvedValueOnce({ puuid: "p9", gameName: "Someone", tagLine: "TAG" });
    mockGetRegionByPuuid.mockResolvedValueOnce({ puuid: "p9", game: "lol", region: "zz9" });
    const { sql, rows } = makeSql([]);
    const result = await linkAccount(sql as never, { gameName: "Someone", tagLine: "TAG" });
    expect(result).toEqual({ ok: false, reason: "region-unresolved" });
    expect(rows).toHaveLength(0); // a row with an unknown region would silently never get any games
  });

  it("REGION-step failures: region-unresolved on a definitive rejection, riot-unavailable on a missing key or transient failure", async () => {
    const { sql } = makeSql([]);
    // Each case gets past the resolve step first, so the region step is what is
    // under test here.
    mockGetAccountByRiotId.mockResolvedValue({ puuid: "px", gameName: "A", tagLine: "B" });

    mockGetRegionByPuuid.mockRejectedValueOnce(
      new RiotRequestError("https://europe.api.riotgames.com/riot/account/v1/region", 404, "Not Found")
    );
    expect(await linkAccount(sql as never, { gameName: "A", tagLine: "B" })).toEqual({
      ok: false,
      reason: "region-unresolved",
    });

    mockGetRegionByPuuid.mockRejectedValueOnce(new RiotUnavailableError());
    expect(await linkAccount(sql as never, { gameName: "A", tagLine: "B" })).toEqual({
      ok: false,
      reason: "riot-unavailable",
    });

    mockGetRegionByPuuid.mockRejectedValueOnce(new TypeError("socket hang up"));
    expect(await linkAccount(sql as never, { gameName: "A", tagLine: "B" })).toEqual({
      ok: false,
      reason: "riot-unavailable",
    });
  });

  it("a transport failure while RESOLVING is riot-unavailable, and never reaches the region step", async () => {
    mockGetAccountByRiotId.mockRejectedValueOnce(new TypeError("socket hang up"));
    const { sql, rows } = makeSql([]);
    expect(await linkAccount(sql as never, { gameName: "A", tagLine: "B" })).toEqual({
      ok: false,
      reason: "riot-unavailable",
    });
    expect(mockGetRegionByPuuid).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});

describe("listAccounts", () => {
  it("maps rows to the picker contract, splits the riot id, and never returns a puuid", async () => {
    let text = "";
    const sql = sqlMock((strings: TemplateStringsArray) => {
      text = sqlText(strings);
      return Promise.resolve([
        { id: 2, riot_id: "K1ayer#swift", region: "EUW", active: true, last_seen_at: "2026-07-29T00:00:00.000Z", games: 4 },
        { id: 1, riot_id: "MunsterHunter#EUW", region: "EUW", active: false, last_seen_at: null, games: 138 },
      ]);
    });

    const accounts = await listAccounts(sql as never);
    // The games count must be joined on puuid, not on id -- match rows are keyed
    // by puuid (migration 0020), so joining on anything else would report 0.
    expect(text).toContain("m.puuid = a.puuid");
    expect(accounts).toEqual([
      {
        id: 2,
        riotId: "K1ayer#swift",
        gameName: "K1ayer",
        tagLine: "swift",
        region: "EUW",
        active: true,
        lastSeenAt: "2026-07-29T00:00:00.000Z",
        games: 4,
      },
      {
        id: 1,
        riotId: "MunsterHunter#EUW",
        gameName: "MunsterHunter",
        tagLine: "EUW",
        region: "EUW",
        active: false,
        lastSeenAt: null,
        games: 138,
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain("puuid");
  });
});
