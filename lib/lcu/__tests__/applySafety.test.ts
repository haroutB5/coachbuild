import { describe, expect, it } from "vitest";
import {
  COACHBUILD_TITLE_PREFIX,
  decideRuneApply,
  isValidItemSetsPayload,
  isValidRunePayload,
  mergeItemSets,
  type ItemSet,
  type LcuRunePage,
  type RuneApplyBody,
} from "../applySafety";

// These are the companion's -SelfTest invariants, ported. They are the actual
// enforcement of CLAUDE.md Hard rule 5, and each one is a scar: the desktop
// shell is a second implementation of the same wire contract, and porting the
// transport without porting these is how ten fixed bugs come back at once.
//
// The adversarial fixture that matters most is the last describe block: five
// rune pages, none of them ours, auto mode — the correct behaviour is to write
// NOTHING and delete NOTHING.

const runeBody = (overrides: Partial<RuneApplyBody> = {}): RuneApplyBody => ({
  name: "CoachBuild Teemo Top",
  primaryStyleId: 8000,
  subStyleId: 8100,
  selectedPerkIds: [8005, 9111, 9104, 8014],
  current: true,
  ...overrides,
});

const page = (id: number, name: string | null, extra: Partial<LcuRunePage> = {}): LcuRunePage => ({
  id,
  name,
  isDeletable: true,
  isEditable: true,
  ...extra,
});

describe("isValidRunePayload — the gate that only existed in the docs", () => {
  it("accepts a CoachBuild-titled page", () => {
    expect(isValidRunePayload(runeBody())).toBe(true);
  });

  it("REJECTS a page titled like the user's own — the hole that had no DELETE and so no test", () => {
    expect(isValidRunePayload(runeBody({ name: "Ranked Page 1" }))).toBe(false);
  });

  it("rejects a missing or empty name", () => {
    expect(isValidRunePayload(runeBody({ name: "" }))).toBe(false);
    expect(isValidRunePayload(null)).toBe(false);
    expect(isValidRunePayload(undefined)).toBe(false);
  });

  it("rejects a present-but-wrong replacePrefix, since it can touch arbitrary pages", () => {
    expect(isValidRunePayload(runeBody({ replacePrefix: "Ranked " }))).toBe(false);
  });

  it("accepts an ABSENT replacePrefix — an older web build simply omits it", () => {
    expect(isValidRunePayload(runeBody({ replacePrefix: null }))).toBe(true);
    expect(isValidRunePayload(runeBody({ replacePrefix: undefined }))).toBe(true);
  });

  it("is prefix-anchored, not substring — a title merely containing the word is not ours", () => {
    expect(isValidRunePayload(runeBody({ name: "My CoachBuild copy" }))).toBe(false);
  });
});

describe("isValidItemSetsPayload", () => {
  const set = (title: string | null): ItemSet => ({ title, blocks: [] });

  it("accepts 1 to 3 CoachBuild-titled sets", () => {
    expect(isValidItemSetsPayload([set("CoachBuild Jinx Bot")])).toBe(true);
    expect(isValidItemSetsPayload([set("CoachBuild A"), set("CoachBuild B"), set("CoachBuild C")])).toBe(true);
  });

  it("rejects an empty write and one over the cap", () => {
    expect(isValidItemSetsPayload([])).toBe(false);
    expect(isValidItemSetsPayload([1, 2, 3, 4].map((n) => set(`CoachBuild ${n}`)))).toBe(false);
  });

  it("rejects the batch if ANY set is not ours — no partial trust", () => {
    expect(isValidItemSetsPayload([set("CoachBuild Jinx Bot"), set("My Own Set")])).toBe(false);
  });

  it("rejects a null-titled set", () => {
    expect(isValidItemSetsPayload([set(null)])).toBe(false);
  });

  it("validates replacePrefix the same way as a title", () => {
    expect(isValidItemSetsPayload([set("CoachBuild Jinx Bot")], "Ranked ")).toBe(false);
    expect(isValidItemSetsPayload([set("CoachBuild Jinx Bot")], "CoachBuild Jinx ")).toBe(true);
    expect(isValidItemSetsPayload([set("CoachBuild Jinx Bot")], null)).toBe(true);
  });
});

describe("mergeItemSets — the user's own sets are sacred", () => {
  it("keeps every non-CoachBuild set byte for byte", () => {
    const mine: ItemSet = { title: "My Lethality Page", blocks: [{ items: [1, 2] }] };
    const merged = mergeItemSets({ itemSets: [mine] }, [{ title: "CoachBuild Jinx Bot" }]);

    expect(merged.itemSets).toHaveLength(2);
    expect(merged.itemSets![0]).toEqual(mine);
  });

  it("drops EVERY pre-existing CoachBuild set — the O(1) prune that fixed the 413", () => {
    const existing = {
      itemSets: [
        { title: "CoachBuild Ahri Mid" },
        { title: "CoachBuild Teemo Top" },
        { title: "CoachBuild Jinx Bot" },
        { title: "Keep me" },
      ],
    };
    const merged = mergeItemSets(existing, [{ title: "CoachBuild Viktor Mid" }]);

    expect(merged.itemSets!.map((s) => s.title)).toEqual(["Keep me", "CoachBuild Viktor Mid"]);
  });

  it("treats a null/empty title as NOT ours and keeps it — we only prune what we can identify", () => {
    const merged = mergeItemSets({ itemSets: [{ title: null }, { title: "" }] }, [{ title: "CoachBuild X" }]);
    expect(merged.itemSets).toHaveLength(3);
  });

  it("passes every other top-level field through untouched — the PUT replaces the WHOLE object", () => {
    const merged = mergeItemSets(
      { accountId: 12345, timestamp: "2026-07-26", somethingFuture: true, itemSets: [] },
      [{ title: "CoachBuild X" }],
    );

    expect(merged.accountId).toBe(12345);
    expect(merged.timestamp).toBe("2026-07-26");
    expect(merged.somethingFuture).toBe(true);
  });

  it("does not mutate the document it was given", () => {
    const existing = { itemSets: [{ title: "Keep me" }] };
    mergeItemSets(existing, [{ title: "CoachBuild X" }]);
    expect(existing.itemSets).toHaveLength(1);
  });

  it("handles a client that has no itemSets array at all", () => {
    expect(mergeItemSets({}, [{ title: "CoachBuild X" }]).itemSets).toHaveLength(1);
    expect(mergeItemSets(null, [{ title: "CoachBuild X" }]).itemSets).toHaveLength(1);
  });
});

describe("decideRuneApply — auto mode never touches a page it does not own", () => {
  it("THE adversarial fixture: 5 pages, none ours, slots full, auto -> write nothing, delete nothing", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => page(n, `Ranked Page ${n}`));
    const action = decideRuneApply({
      body: runeBody(),
      pages,
      ownedPageCount: 5,
      currentPageId: 3,
      mode: "auto",
    });

    expect(action).toEqual({ kind: "reject", reason: "slots-full" });
    expect("deleteFirst" in action).toBe(false);
  });

  it("edits IN PLACE on an exact title match — never delete-then-create (the LCU refuses to delete the selected page)", () => {
    const action = decideRuneApply({
      body: runeBody(),
      pages: [page(1, "Ranked Page 1"), page(7, "CoachBuild Teemo Top")],
      ownedPageCount: 2,
      currentPageId: 7,
      mode: "auto",
    });

    expect(action).toEqual({ kind: "edit", deleteFirst: [], pageId: 7 });
  });

  it("matches EXACTLY, so the WPA page and its ' Pro' sibling never overwrite each other", () => {
    const action = decideRuneApply({
      body: runeBody({ name: "CoachBuild Teemo Top" }),
      pages: [page(9, "CoachBuild Teemo Top Pro")],
      ownedPageCount: null,
      currentPageId: 9,
      mode: "auto",
    });

    expect(action.kind).toBe("create"); // NOT an edit of the Pro page
  });

  it("picks the lowest id when our own page somehow exists twice", () => {
    const action = decideRuneApply({
      body: runeBody(),
      pages: [page(12, "CoachBuild Teemo Top"), page(4, "CoachBuild Teemo Top")],
      ownedPageCount: 5,
      currentPageId: null,
      mode: "auto",
    });

    expect(action).toMatchObject({ kind: "edit", pageId: 4 });
  });

  it("creates into a genuinely free slot", () => {
    const action = decideRuneApply({
      body: runeBody(),
      pages: [page(1, "Ranked Page 1")],
      ownedPageCount: 5,
      currentPageId: 1,
      mode: "auto",
    });

    expect(action).toEqual({ kind: "create", deleteFirst: [] });
  });

  it("allows a speculative create when the inventory cap is unavailable — the LCU's rejection is authoritative", () => {
    const action = decideRuneApply({
      body: runeBody(),
      pages: [1, 2, 3, 4, 5].map((n) => page(n, `Ranked Page ${n}`)),
      ownedPageCount: null,
      currentPageId: 1,
      mode: "auto",
    });

    expect(action.kind).toBe("create");
  });

  it("MANUAL mode may replace the selected page — a real click is real consent", () => {
    const action = decideRuneApply({
      body: runeBody(),
      pages: [1, 2].map((n) => page(n, `Ranked Page ${n}`)),
      ownedPageCount: 2,
      currentPageId: 2,
      mode: "manual",
    });

    expect(action).toEqual({ kind: "replace-current", deleteFirst: [], currentPageId: 2 });
  });

  it("rejects a payload that failed the title gate before deciding anything", () => {
    const action = decideRuneApply({
      body: runeBody({ name: "Ranked Page 1" }),
      pages: [page(1, "Ranked Page 1")],
      ownedPageCount: 5,
      currentPageId: 1,
      mode: "manual",
    });

    expect(action).toEqual({ kind: "reject", reason: "bad-payload" });
  });

  describe("champ-scoped stale cleanup", () => {
    it("deletes our stale pages for the same champion, never the exact target", () => {
      const action = decideRuneApply({
        body: runeBody({ name: "CoachBuild Teemo Top", replacePrefix: "CoachBuild Teemo " }),
        pages: [
          page(3, "CoachBuild Teemo Mid"),
          page(4, "CoachBuild Teemo Top"),
          page(5, "CoachBuild Ahri Mid"),
          page(6, "Ranked Page 1"),
        ],
        ownedPageCount: 5,
        currentPageId: 4,
        mode: "auto",
      });

      expect(action).toEqual({ kind: "edit", deleteFirst: [3], pageId: 4 });
    });

    it("never deletes a page outside the CoachBuild prefix even if the champ prefix would match", () => {
      // A caller-supplied prefix that passed the gate still cannot reach a page
      // that is not ours: both gates apply, not either.
      const action = decideRuneApply({
        body: runeBody({ name: "CoachBuild Teemo Top", replacePrefix: "CoachBuild " }),
        pages: [page(1, "Ranked Page 1"), page(2, "My CoachBuild copy")],
        ownedPageCount: 5,
        currentPageId: 1,
        mode: "auto",
      });

      expect(action).toEqual({ kind: "create", deleteFirst: [] });
    });

    it("does no cleanup at all when replacePrefix is absent", () => {
      const action = decideRuneApply({
        body: runeBody({ replacePrefix: null }),
        pages: [page(3, "CoachBuild Teemo Mid")],
        ownedPageCount: 5,
        currentPageId: null,
        mode: "auto",
      });

      expect(action).toEqual({ kind: "create", deleteFirst: [] });
    });

    it("counts freed slots, so cleanup can turn a full inventory into a create", () => {
      const action = decideRuneApply({
        body: runeBody({ name: "CoachBuild Teemo Top", replacePrefix: "CoachBuild Teemo " }),
        pages: [page(1, "CoachBuild Teemo Mid"), page(2, "Ranked Page 1")],
        ownedPageCount: 2,
        currentPageId: 2,
        mode: "auto",
      });

      expect(action).toEqual({ kind: "create", deleteFirst: [1] });
    });
  });

  it("skips pages the client marks non-editable rather than trying to write them", () => {
    const action = decideRuneApply({
      body: runeBody(),
      pages: [page(1, "CoachBuild Teemo Top", { isEditable: false })],
      ownedPageCount: null,
      currentPageId: null,
      mode: "auto",
    });

    expect(action.kind).toBe("create");
  });
});

describe("the prefix constant is the boundary everything keys on", () => {
  it("is the literal generic prefix", () => {
    expect(COACHBUILD_TITLE_PREFIX).toBe("CoachBuild");
  });
});
