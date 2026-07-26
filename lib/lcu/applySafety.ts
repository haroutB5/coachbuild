// ─────────────────────────────────────────────────────────────────────────────
// applySafety.ts — the rune-page / item-set write rules, as pure functions.
//
// WHY THIS FILE EXISTS. These rules are the actual enforcement of CLAUDE.md's
// Hard rule 5 ("Companion page/set ownership"). They have lived only inside
// `public/companion.ps1`, pinned by its ~850-line `-SelfTest`, and every one of
// them is a scar from a live-reported bug:
//
//   • the 5-page / 0-CoachBuild fixture that must produce ZERO DELETE calls
//     (auto mode never deletes a page it does not own),
//   • edit-in-place on an exact title match, because the LCU refuses to DELETE
//     the currently-selected page (v1.6.2),
//   • EXACT-title matching, not prefix, so the WPA page and its "… Pro" sibling
//     never collide (v1.6.3),
//   • the O(1) item-set prune that fixed a real HTTP 413 (v1.6.1),
//   • the title gates on both payload paths — the rune one existed in the docs
//     for months before it existed in the code (v1.6.x), which is precisely why
//     a rule asserted in prose and absent from the source is worse than no rule.
//
// The desktop shell (electron/) is a second implementation of the same wire
// contract. Porting the transport is routine; porting THESE by hand a second
// time is how ten fixed bugs come back. So the decisions live here, pure and
// unit-tested in the repo's normal `npm test` gate, and both the shell and any
// future host call into them rather than re-deriving them.
//
// Pure by construction: no I/O, no LCU, no Electron. Everything that talks to a
// socket lives in the caller; everything that decides what may be written lives
// here.
// ─────────────────────────────────────────────────────────────────────────────

/** The one literal that separates "ours, may be replaced or pruned" from
 *  "the user's own, never touched". Deliberately the generic prefix and not a
 *  champion-scoped one: it drops a strict superset of what any champ-scoped
 *  prefix would, which is exactly the payload bounding the 413 fix needed. */
export const COACHBUILD_TITLE_PREFIX = "CoachBuild";

/** The web side sends at most 3 ("top 3 if available"); the bridge does not
 *  trust that on its own. */
export const MAX_ITEM_SETS_PER_WRITE = 3;

export interface RuneApplyBody {
  name: string;
  primaryStyleId: number;
  subStyleId: number;
  selectedPerkIds: number[];
  current?: boolean;
  /** Champ-scoped stale-removal prefix. Optional — an older web build omits it. */
  replacePrefix?: string | null;
}

export interface LcuRunePage {
  id: number;
  name?: string | null;
  isDeletable?: boolean;
  isEditable?: boolean;
  current?: boolean;
}

export interface ItemSet {
  title?: string | null;
  [key: string]: unknown;
}

/** The GET'd item-sets object. Only `.itemSets` is ever rebuilt — every other
 *  top-level field the client emits (accountId, timestamp, anything future)
 *  passes through untouched, because the PUT replaces the WHOLE object. */
export interface ItemSetsDocument {
  itemSets?: ItemSet[] | null;
  [key: string]: unknown;
}

const startsWithCoachBuild = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith(COACHBUILD_TITLE_PREFIX);

/** Rune-side title gate. A POST of `{name: "Ranked Page 1", mode: "auto"}` used
 *  to exact-title match the user's OWN page and PUT-overwrite its perks in
 *  place — no DELETE, which is why a DELETE-shaped test suite never caught it.
 *
 *  `replacePrefix` gets the identical treatment: an explicit stale-removal
 *  prefix can touch arbitrary existing pages, so a present-but-wrong prefix is
 *  rejected while an absent one (older web build) passes. */
export const isValidRunePayload = (body: RuneApplyBody | null | undefined): boolean => {
  if (!body) return false;
  if (!startsWithCoachBuild(body.name)) return false;
  if (body.replacePrefix != null && body.replacePrefix !== "" && !startsWithCoachBuild(body.replacePrefix)) {
    return false;
  }
  return true;
};

/** Item-set title gate: every incoming set must be ours, and there must be
 *  between 1 and MAX_ITEM_SETS_PER_WRITE of them. A compromised or simply buggy
 *  client cannot smuggle an arbitrarily titled set into the user's client. */
export const isValidItemSetsPayload = (
  sets: ItemSet[] | null | undefined,
  replacePrefix?: string | null,
): boolean => {
  const arr = Array.isArray(sets) ? sets : [];
  if (arr.length < 1 || arr.length > MAX_ITEM_SETS_PER_WRITE) return false;
  for (const set of arr) {
    if (!set || !startsWithCoachBuild(set.title)) return false;
  }
  if (replacePrefix != null && replacePrefix !== "" && !startsWithCoachBuild(replacePrefix)) return false;
  return true;
};

/** Rebuilds the item-sets document for a PUT.
 *
 *  HARD INVARIANT: a set whose title does NOT start with "CoachBuild" is never
 *  dropped — the user's hand-made sets pass through byte for byte, always. A
 *  null/empty title counts as NOT ours and is kept: we only prune what we can
 *  positively identify as ours.
 *
 *  Every pre-existing CoachBuild set IS dropped, including this champion's
 *  stale roles and every other champion's accumulation. That bounds our
 *  contribution to the payload at O(1) instead of O(champions ever viewed),
 *  which is what stopped the LCU rejecting the entire write with a 413. */
export const mergeItemSets = (
  existing: ItemSetsDocument | null | undefined,
  newSets: ItemSet[],
): ItemSetsDocument => {
  const document: ItemSetsDocument = existing && typeof existing === "object" ? { ...existing } : {};
  const existingSets = Array.isArray(document.itemSets) ? document.itemSets : [];
  const kept = existingSets.filter((set) => !startsWithCoachBuild(set?.title));
  return { ...document, itemSets: [...kept, ...newSets] };
};

// ── Rune apply decision ─────────────────────────────────────────────────────

export type RuneApplyMode = "auto" | "manual";

export type RuneApplyAction =
  /** Payload failed the title gate. Nothing is written. */
  | { kind: "reject"; reason: "bad-payload" }
  /** Delete these stale champ-scoped pages first (may be empty). */
  | { kind: "edit"; deleteFirst: number[]; pageId: number }
  | { kind: "create"; deleteFirst: number[] }
  /** Manual mode only: the user clicked, so the currently selected page may go. */
  | { kind: "replace-current"; deleteFirst: number[]; currentPageId: number | null }
  /** Auto mode with no free slot and no page of ours: write nothing. */
  | { kind: "reject"; reason: "slots-full" };

export interface RuneApplyDecisionInput {
  body: RuneApplyBody;
  pages: LcuRunePage[];
  /** Rune-page cap from the inventory endpoint; null when unavailable, in which
   *  case a speculative create is allowed and the LCU's own rejection is
   *  authoritative. */
  ownedPageCount: number | null;
  currentPageId: number | null;
  mode: RuneApplyMode;
}

/** The whole "which page may we touch" decision, in one testable place.
 *
 *  Order is load-bearing and matches companion.ps1 step for step:
 *   1. title gate,
 *   2. champ-scoped stale cleanup (only ever OUR pages, never the exact target),
 *   3. EXACT-title match -> edit in place (never delete-then-create: the LCU
 *      refuses to delete the selected page, and overwriting our own page is as
 *      consented as creating it),
 *   4. a genuinely free slot -> create,
 *   5. manual mode only -> replace whatever is selected (a real click is real
 *      consent, and a free account with 2 slots would otherwise have nowhere to
 *      put the page). AUTO MODE STOPS AT 4 AND WRITES NOTHING. */
export const decideRuneApply = (input: RuneApplyDecisionInput): RuneApplyAction => {
  const { body, pages, ownedPageCount, currentPageId, mode } = input;

  if (!isValidRunePayload(body)) {
    return { kind: "reject", reason: "bad-payload" };
  }

  const editable = pages.filter((page) => page.isDeletable !== false && page.isEditable !== false);

  // Stale cleanup is scoped to pages that are BOTH ours by the generic prefix
  // AND match the caller's champ-scoped prefix — and never the exact page we
  // are about to edit. Two gates, because either alone has been wrong before.
  const replacePrefix = body.replacePrefix;
  const deleteFirst =
    replacePrefix && startsWithCoachBuild(replacePrefix)
      ? editable
          .filter(
            (page) =>
              typeof page.name === "string" &&
              startsWithCoachBuild(page.name) &&
              page.name.startsWith(replacePrefix) &&
              page.name !== body.name,
          )
          .map((page) => page.id)
      : [];

  // EXACT equality, not startsWith: "CoachBuild Teemo Top" and "CoachBuild
  // Teemo Top Pro" are two pages by design and must never overwrite each other.
  const exactMatches = editable
    .filter((page) => typeof page.name === "string" && page.name === body.name)
    .sort((a, b) => a.id - b.id);

  if (exactMatches.length > 0) {
    return { kind: "edit", deleteFirst, pageId: exactMatches[0].id };
  }

  const remainingAfterCleanup = pages.length - deleteFirst.length;
  const hasFreeSlot = ownedPageCount == null || remainingAfterCleanup < ownedPageCount;
  if (hasFreeSlot) {
    return { kind: "create", deleteFirst };
  }

  if (mode !== "auto") {
    return { kind: "replace-current", deleteFirst, currentPageId };
  }

  return { kind: "reject", reason: "slots-full" };
};
