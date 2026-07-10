/**
 * Pure-logic tests for stripRuneDescriptionHtml — the sanitizer that turns
 * CommunityDragon's perks.json tooltip markup into plain readable text for
 * the rune-detail popover. No JSX rendering, no network — plain function.
 * Fixtures below are lifted verbatim from a live perks.json fetch
 * (2026-07-10) so the tests exercise real tag shapes, not guessed ones.
 *
 * Also covers the localStorage TTL cache (P2 fix, 2026-07-11): a returning
 * user must refetch CDragon's perks.json (which only ever serves /latest/)
 * once the cached copy is older than ~10 days, instead of carrying stale
 * numeric values across patch rebalances forever. No jsdom/RTL in this
 * repo's harness, but the caching module only touches `window.localStorage`
 * and `fetch` as plain globals — `vi.stubGlobal` + `vi.resetModules` (fresh
 * module instance per test, since `memCache`/`inFlight` are module
 * singletons) exercises the real fetch/cache code path without needing a DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripRuneDescriptionHtml, isFreshRuneCachePayload } from "../runeDetail";

const LOCALSTORAGE_KEY = "coachbuild:runedata:v2";

function makeFakeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    _store: store,
  };
}

function fakePerksResponse(entries: { id: number; name: string; longDesc: string }[]) {
  return { ok: true, json: async () => entries };
}

describe("stripRuneDescriptionHtml", () => {
  it("returns empty string for undefined/null/empty input", () => {
    expect(stripRuneDescriptionHtml(undefined)).toBe("");
    expect(stripRuneDescriptionHtml(null)).toBe("");
    expect(stripRuneDescriptionHtml("")).toBe("");
  });

  it("converts <br> tags to newlines", () => {
    expect(stripRuneDescriptionHtml("Line one<br>Line two")).toBe("Line one\nLine two");
    expect(stripRuneDescriptionHtml("Line one<br/>Line two")).toBe("Line one\nLine two");
    expect(stripRuneDescriptionHtml("Line one<br />Line two")).toBe("Line one\nLine two");
  });

  it("keeps real numeric values from Unflinching's longDesc (the placeholder-free case this migration exists for)", () => {
    const raw = "Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).toBe("Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.");
    expect(out).toMatch(/\d/);
  });

  it("strips <lol-uikit-tooltipped-keyword>, <font color=...>, and other real perks.json tags but keeps their text", () => {
    const raw =
      "Hitting a champion with 3 <b>separate</b> attacks or abilities within 3s deals bonus <lol-uikit-tooltipped-keyword key='LinkTooltip_Description_AdaptiveDmg'><font color='#48C4B7'>adaptive damage</font></lol-uikit-tooltipped-keyword>.<br><br>Damage: 70 - 240 (+0.1 bonus AD, +0.05 AP) damage.<br>Cooldown: 20s";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("separate");
    expect(out).toContain("adaptive damage");
    expect(out).toContain("Damage: 70 - 240 (+0.1 bonus AD, +0.05 AP) damage.");
    expect(out).toContain("Cooldown: 20s");
  });

  it("turns <li> list items (Grasp of the Undying's longDesc) into their own bulleted lines", () => {
    const raw =
      "Every 4s in combat, your next basic attack on a champion will:<li>Deal bonus magic damage equal to 3.5% of your max health<li>Heal you for 1.3% of your max health<li>Permanently increase your health by 5<br><rules><i>Ranged Champions:</i> Damage, healing, and permanent health gained are 40% effective.</rules>";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    const lines = out.split("\n");
    expect(lines).toContain("• Deal bonus magic damage equal to 3.5% of your max health");
    expect(lines).toContain("• Heal you for 1.3% of your max health");
    expect(lines).toContain("• Permanently increase your health by 5");
    expect(out).toContain("Ranged Champions:");
  });

  it("converts <hr> (flavor-quote divider, e.g. Triumph/Celestial Body) to a newline break", () => {
    const raw = "Takedowns restore 5% of your missing health.<br><br><hr><br><i>'Flavor quote.'</i>";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("Takedowns restore 5% of your missing health.");
    expect(out).toContain("Flavor quote.");
  });

  it("replaces a leftover @Variable@ placeholder with an ellipsis while keeping the rest of the real text (Unsealed Spellbook)", () => {
    const raw =
      "Each unique Summoner Spell you swap to permanently decreases your swap cooldown by 25s (initial swap cooldown is @f3@ seconds).";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toContain("@f3@");
    expect(out).toContain("…");
    expect(out).toContain("25s");
  });

  it("unescapes the common HTML entities perks.json could emit", () => {
    expect(stripRuneDescriptionHtml("A&amp;B")).toBe("A&B");
    expect(stripRuneDescriptionHtml("A&nbsp;B")).toBe("A B");
    expect(stripRuneDescriptionHtml("&lt;tag&gt;")).toBe("<tag>");
  });

  it("collapses 3+ consecutive newlines down to a max of one blank line", () => {
    expect(stripRuneDescriptionHtml("A<br><br><br><br>B")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripRuneDescriptionHtml("<br>  Hello  <br>")).toBe("Hello");
  });
});

describe("isFreshRuneCachePayload", () => {
  const now = 1_800_000_000_000; // fixed reference instant

  it("accepts a well-shaped payload fetched moments ago", () => {
    expect(isFreshRuneCachePayload({ fetchedAt: now - 1000, entries: { "1": {} } }, now)).toBe(true);
  });

  it("rejects a payload older than the ~10 day TTL", () => {
    const elevenDaysMs = 11 * 24 * 60 * 60 * 1000;
    expect(isFreshRuneCachePayload({ fetchedAt: now - elevenDaysMs, entries: { "1": {} } }, now)).toBe(false);
  });

  it("accepts a payload just under the TTL boundary", () => {
    const nineDaysMs = 9 * 24 * 60 * 60 * 1000;
    expect(isFreshRuneCachePayload({ fetchedAt: now - nineDaysMs, entries: { "1": {} } }, now)).toBe(true);
  });

  it("rejects the old pre-TTL cache shape (flat id->entry map, no fetchedAt)", () => {
    expect(isFreshRuneCachePayload({ "8242": { id: 8242, name: "Unflinching" } }, now)).toBe(false);
  });

  it("rejects non-object / null / undefined payloads", () => {
    expect(isFreshRuneCachePayload(null, now)).toBe(false);
    expect(isFreshRuneCachePayload(undefined, now)).toBe(false);
    expect(isFreshRuneCachePayload("a string", now)).toBe(false);
    expect(isFreshRuneCachePayload(42, now)).toBe(false);
  });

  it("rejects a payload with a non-finite fetchedAt", () => {
    expect(isFreshRuneCachePayload({ fetchedAt: NaN, entries: {} }, now)).toBe(false);
    expect(isFreshRuneCachePayload({ fetchedAt: "yesterday", entries: {} }, now)).toBe(false);
  });

  it("rejects a payload missing entries", () => {
    expect(isFreshRuneCachePayload({ fetchedAt: now }, now)).toBe(false);
  });
});

describe("rune data cache TTL (getRuneDetail end-to-end)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fresh cache hit — resolves from localStorage without hitting the network", async () => {
    const cached = {
      fetchedAt: Date.now() - 1000, // 1s ago, well inside the TTL
      entries: {
        "8242": { id: 8242, name: "Unflinching", descriptionText: "Gain 10 Armor and Magic Resist." },
      },
    };
    vi.stubGlobal("window", { localStorage: makeFakeLocalStorage({ [LOCALSTORAGE_KEY]: JSON.stringify(cached) }) });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getRuneDetail } = await import("../runeDetail");
    const detail = await getRuneDetail(8242, "16.13.1");

    expect(detail?.name).toBe("Unflinching");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expired cache (>10 days old) — refetches from CDragon and overwrites with a fresh timestamp", async () => {
    const elevenDaysMs = 11 * 24 * 60 * 60 * 1000;
    const stale = {
      fetchedAt: Date.now() - elevenDaysMs,
      entries: {
        "8242": { id: 8242, name: "Unflinching (stale)", descriptionText: "old pre-rebalance text" },
      },
    };
    const ls = makeFakeLocalStorage({ [LOCALSTORAGE_KEY]: JSON.stringify(stale) });
    vi.stubGlobal("window", { localStorage: ls });
    const fetchMock = vi.fn().mockResolvedValue(
      fakePerksResponse([
        {
          id: 8242,
          name: "Unflinching",
          longDesc: "Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.",
        },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getRuneDetail } = await import("../runeDetail");
    const detail = await getRuneDetail(8242, "16.13.1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detail?.name).toBe("Unflinching");
    expect(detail?.descriptionText).toContain("10 Armor");

    const written = JSON.parse(ls._store.get(LOCALSTORAGE_KEY) as string);
    expect(written.fetchedAt).toBeGreaterThan(Date.now() - 5000);
    expect(written.entries["8242"].name).toBe("Unflinching");
  });

  it("missing-timestamp shape (old pre-TTL cache format) is a miss — refetches instead of trusting it forever", async () => {
    const oldShapeCache = {
      "8242": { id: 8242, name: "Unflinching (old shape)", descriptionText: "x" },
    };
    vi.stubGlobal("window", { localStorage: makeFakeLocalStorage({ [LOCALSTORAGE_KEY]: JSON.stringify(oldShapeCache) }) });
    const fetchMock = vi.fn().mockResolvedValue(
      fakePerksResponse([
        {
          id: 8242,
          name: "Unflinching",
          longDesc: "Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.",
        },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getRuneDetail } = await import("../runeDetail");
    const detail = await getRuneDetail(8242, "16.13.1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(detail?.name).toBe("Unflinching");
  });

  it("corrupt (unparseable) cache entry is a miss, never throws", async () => {
    vi.stubGlobal("window", { localStorage: makeFakeLocalStorage({ [LOCALSTORAGE_KEY]: "{not valid json" }) });
    const fetchMock = vi.fn().mockResolvedValue(
      fakePerksResponse([
        {
          id: 8242,
          name: "Unflinching",
          longDesc: "Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.",
        },
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getRuneDetail } = await import("../runeDetail");
    await expect(getRuneDetail(8242, "16.13.1")).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
