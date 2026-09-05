// ─────────────────────────────────────────────────────────────────────────────
// perkSlots.ts — the rune tree SLOT STRUCTURE (which rune id lives in which
// keystone/minor row of which tree). Pure static data + two lookups, no fetch,
// no DOM — importable from a plain .ts test file.
//
// WHY THIS EXISTS (2026-07-22 pro-rune slot-coherence fix): a valid LCU rune
// page needs EXACTLY one rune per slot — 1 keystone + one primary minor per row
// (rows 0/1/2) + 2 secondary picks from 2 DIFFERENT secondary rows. The pro-
// consensus page was assembled from a FLAT top-N-by-frequency aggregate
// (proConsensus.ts's primaryMinors/secondaryPicks), which does NOT guarantee
// one-per-row — on a thin or split sample it can emit two runes from the same
// row (and miss a row), so the client silently drops the duplicate/invalid id
// and renders that minor slot EMPTY (live user report: "CoachBuild Ashe Bot
// Pro" applied with empty primary-tree slots). This map is what lets the apply
// path resolve each candidate rune to its row and pick exactly one modal per
// row — the same one-rune-per-row guarantee lib/recommend.ts's `rowPicks`
// already gives the WPA page (which is why the WPA "Apply runes" button never
// had this bug).
//
// SOURCE: a live CommunityDragon perkstyles.json pull (2026-07-22):
//   https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/
//   global/default/v1/perkstyles.json
// Every id below is copied verbatim from that fetch, matching the pinned
// fixture in components/__tests__/runeApplyBody.test.ts. CDragon serves
// "latest" only (not patch-keyed), same as components/runeDetail.ts's rune
// tooltip source — so this is a snapshot of the CURRENT rune trees.
//
// DRIFT (documented, graceful): rune-tree structure changes rarely (a keystone
// rework keeps its id; whole-row reworks are years apart). If Riot renames/adds
// a rune id this map doesn't know, `primaryMinorRow` returns null for it — the
// apply path then treats that row as "no consensus rune from this source" and
// either fills it from another sampled game (soloq pages are read positionally,
// so a brand-new id still slots by row) or, if genuinely uncoverable, DISABLES
// the pro-apply button with a reason rather than writing a broken page. Never a
// wrong slot, only a (rare, self-healing on the next map refresh) missing one.
// To refresh: re-pull the URL above and replace the arrays below.
// ─────────────────────────────────────────────────────────────────────────────

export interface TreeSlots {
  /** Keystone slot (row 0 of the primary tree). A tree has 3 or 4 keystones. */
  keystones: number[];
  /** The 3 minor rows, in row order (index 0 = first minor row under the
   *  keystone). Each row is the set of runes selectable in that slot. When this
   *  tree is used as the SECONDARY tree these are the same rows a secondary
   *  pick comes from (secondary just can't use the keystone row). */
  minorRows: [number[], number[], number[]];
}

/** Current stat-mod slots, in the client's Offense / Flex / Defense order. */
export const SHARD_ROWS: number[][] = [
  [5008, 5005, 5007],
  [5008, 5010, 5001],
  [5011, 5013, 5001],
];

/** All 5 rune trees, keyed by Riot style id (lib/types.ts's TreeId). */
export const PERK_TREES: Record<number, TreeSlots> = {
  8000: {
    // Precision
    keystones: [8005, 8008, 8021, 8010],
    minorRows: [
      [9101, 9111, 8009], // Heroism
      [9104, 9105, 9103], // Legend
      [8014, 8017, 8299], // Combat
    ],
  },
  8100: {
    // Domination
    keystones: [8112, 8128, 9923],
    minorRows: [
      [8126, 8139, 8143],
      [8137, 8140, 8141],
      [8135, 8105, 8106],
    ],
  },
  8200: {
    // Sorcery
    keystones: [8214, 8229, 8230, 8992],
    minorRows: [
      [8224, 8226, 8275], // Artifact
      [8210, 8234, 8233], // Excellence
      [8237, 8232, 8236], // Power
    ],
  },
  8300: {
    // Inspiration
    keystones: [8351, 8360, 8369],
    minorRows: [
      [8306, 8304, 8321],
      [8313, 8352, 8345],
      [8347, 8410, 8316],
    ],
  },
  8400: {
    // Resolve
    keystones: [8437, 8439, 8465],
    minorRows: [
      [8446, 8463, 8401],
      [8429, 8444, 8473],
      [8451, 8453, 8242],
    ],
  },
};

/** The minor-row index (0, 1, or 2) a rune id occupies within `treeId`'s three
 *  minor rows, or null if the id isn't a known minor of that tree (a keystone,
 *  a rune of a different tree, a stat shard, or an id newer than this map).
 *  Works whether `treeId` is the page's primary OR secondary tree — a tree's
 *  minor rows are the same set of slots in either role. */
export function primaryMinorRow(treeId: number, runeId: number): 0 | 1 | 2 | null {
  const tree = PERK_TREES[treeId];
  if (!tree) return null;
  for (let r = 0; r < 3; r++) {
    if (tree.minorRows[r].includes(runeId)) return r as 0 | 1 | 2;
  }
  return null;
}

/** True when `runeId` is a keystone of `treeId` (the row-0 slot). Used to
 *  validate the displayed keystone actually belongs to the page's primary
 *  tree before it's written. */
export function isKeystoneOf(treeId: number, runeId: number): boolean {
  const tree = PERK_TREES[treeId];
  return !!tree && tree.keystones.includes(runeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY ORDER (2026-07-29 user report, Pro page)
//
// THE BUG: "rune order is wrong — Ultimate Hunter shows 2nd but it is the LAST
// row of Domination." Confirmed against the data path rather than assumed.
// `ProConsensusModel.primaryMinors` is a FLAT frequency aggregate
// (`RuneSlotAccumulator.finalize`, sorted count desc / id asc), so the card was
// rendering minors in PICK-RATE order and calling it a rune page. Ultimate
// Hunter (8106) is `PERK_TREES[8100].minorRows[2][2]` — the third rune of the
// THIRD minor row — and simply happens to be the second-most-picked Domination
// minor on the reported champion. Nothing was mis-parsed; the display never had
// row information to sort by. This is CLAUDE.md gotcha (s) in its display form:
// a flat top-N aggregate must never be assumed positional.
//
// THE SOURCE, and why NOT runesReforged.json. The dispatch brief pointed at
// `lib/prostage/ddragon.ts`, which does iterate `style.slots` and therefore does
// carry row structure. Overridden deliberately, for three reasons: (1) it is
// server-side and fetches ddragon over the network, and the fix is needed in a
// client card whose rune display is explicitly decorative and must never block
// a render on a fetch; (2) `buildDdragonMaps` keys runes by NAME and keeps only
// `{id, parentStyleId}` — it discards the slot index, so it would have to be
// extended anyway; (3) the row structure is ALREADY in this repo, right here, as
// pure static data pulled from CommunityDragon's perkstyles.json — the same map
// the rune-APPLY path has trusted for slot coherence since 2026-07-22. Reusing
// it means display order and apply order can never disagree, which is a
// stronger guarantee than a second source would have given.
//
// DEGRADATION (matches proAssets.ts's posture for rune data): never throws,
// never fetches, never randomises. An id this snapshot doesn't know — a new
// rune, a shard passed in by mistake, a rune of a different tree — sorts to the
// END, deterministically, by id ascending. An unknown/absent `treeId` makes
// EVERY id unknown, so the input falls back to a stable id-ascending order
// rather than an arbitrary one. A wrong ORDER is the failure mode being fixed;
// these helpers can only ever fail by leaving an unrecognised rune at the back.
// ─────────────────────────────────────────────────────────────────────────────

/** Sort position of a perk within its tree: `row` 0 is the keystone row and
 *  1/2/3 are the three minor rows; `col` is the rune's left-to-right index
 *  inside that row, exactly as the in-game page lays it out (PERK_TREES stores
 *  each row in that order). `null` when `treeId` or `runeId` is unknown to this
 *  snapshot — callers sort those to the end rather than guessing a slot. */
export function perkSlotPosition(
  treeId: number | null | undefined,
  runeId: number
): { row: number; col: number } | null {
  if (treeId == null) return null;
  const tree = PERK_TREES[treeId];
  if (!tree) return null;
  const k = tree.keystones.indexOf(runeId);
  if (k >= 0) return { row: 0, col: k };
  for (let r = 0; r < 3; r++) {
    const c = tree.minorRows[r].indexOf(runeId);
    if (c >= 0) return { row: r + 1, col: c };
  }
  return null;
}

/** Sort rank for `runeId` within `treeId` — lower renders first. Known runes
 *  rank by (row, col); unknown ones share a rank past every known slot, and the
 *  comparators below break that tie by id so the result is still deterministic.
 *  Exported for tests and for a caller that wants to bucket rather than sort. */
export function perkSortRank(treeId: number | null | undefined, runeId: number): number {
  const pos = perkSlotPosition(treeId, runeId);
  return pos === null ? Number.MAX_SAFE_INTEGER : pos.row * 10 + pos.col;
}

/**
 * Comparator putting a tree's perks in real page order: keystone row, then
 * minor row 1, row 2, row 3, and left-to-right within each row. Unknown ids
 * land at the end, ordered by id.
 *
 * Total (never returns 0 for two different ids), so the result does not depend
 * on the caller's sort stability or on input order.
 */
export function comparePerksByRow(treeId: number | null | undefined): (a: number, b: number) => number {
  return (a, b) => {
    const ra = perkSortRank(treeId, a);
    const rb = perkSortRank(treeId, b);
    return ra !== rb ? ra - rb : a - b;
  };
}

/** `comparePerksByRow` applied to a plain id list. Returns a NEW array — never
 *  sorts the caller's array in place, since these usually come straight off a
 *  memoised API response. */
export function sortPerkIdsByRow(treeId: number | null | undefined, runeIds: readonly number[]): number[] {
  return [...runeIds].sort(comparePerksByRow(treeId));
}

/** `sortPerkIdsByRow` for a list of objects that each carry a perk id — e.g.
 *  `ProConsensusModel.primaryMinors.entries` (`{ runeId, count, share }`) or the
 *  featured card's own rune page arrays. Keeps every field, only reorders. */
export function sortPerksByRow<T>(
  treeId: number | null | undefined,
  items: readonly T[],
  getRuneId: (item: T) => number
): T[] {
  const cmp = comparePerksByRow(treeId);
  return [...items].sort((a, b) => cmp(getRuneId(a), getRuneId(b)));
}
