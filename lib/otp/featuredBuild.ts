// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/featuredBuild.ts — turning ONE one-trick's per-game inventories into
// the four things the featured card shows: a completed-item list, a boots slot,
// an opener, and A FULL BUILD.
//
// The first three are partitions of a frequency ranking and are mechanical.
// The fourth is the only judgement call in this file, and it is the one that
// can lie, so it is documented at length below.
//
// This is the pure half. It fetches nothing and renders nothing; it takes the
// per-game item sets the route now returns (`FeaturedBuildModel.gameItems`),
// the per-item rates beside them, and the ddragon item metadata the CLIENT
// holds (`getItemDetailMap`) — the server deliberately does not classify items,
// see the route header.
//
// ── Why item classification lives here and not in the card ─────────────────
// FeaturedOtpCard.tsx had its own local `isCompleted`, and proConsensus.ts has
// `isBuildItem`, and itemSetBody.ts has `isFullItem`. Three rules for one
// question is how Doran's Bow shipped inside completed build lines (v0.56.0
// P0-A) — the guard everyone believed was live was one layer away from where it
// mattered. This module owns the featured card's classification outright so the
// four slots below cannot disagree with each other about what an item IS.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FULL BUILD, AND WHY IT CARRIES ITS OWN METHOD LABEL
// ═══════════════════════════════════════════════════════════════════════════
// User directive, 2026-07-29: "show at least one FULL build... most built I
// guess over multiple games. Make the build make sense."
//
// There are exactly two ways to answer that, and they are not equally honest:
//
//   (a) THE MOST FREQUENT COMPLETE FINAL SET. Group the player's games by the
//       exact set of items they finished holding, take the biggest group. This
//       is a build they DEMONSTRABLY played, N times. Its weakness is sample:
//       we hold ~37 games for a typical featured account, six-slot inventories
//       vary by one situational item constantly, and the modal exact set is
//       often n=1 or n=2. "Most built" over a sample of one is not most built.
//
//   (b) ASSEMBLE FROM PER-ITEM FREQUENCY. Top boot plus the top five non-boot
//       items by build rate. Every component rests on the full sample, so the
//       numbers are strong — but the COMBINATION is a synthesis. It is entirely
//       possible, and on a champion with two divergent builds it is likely,
//       that the player never finished a single game holding those six items
//       together. The card would be showing a build nobody played while looking
//       exactly like a build somebody played.
//
// (b) is not "wrong", it is UNLABELLED. This repo shipped v0.73.1 over precisely
// this class of mistake — a number quoted against a denominator it did not come
// from — so the fix is structural rather than editorial:
//
//   `FeaturedFullBuild` is a DISCRIMINATED UNION on `method`, and the
//   synthesised branch types `games` as `null`. Not 0, not optional: `null`,
//   which TypeScript forces every caller to handle and which there is no way to
//   render as "played N times". The UI cannot caption a synthesis as a real
//   game because there is no number there to caption it with.
//
// WHICH METHOD WINS: (a) when the modal exact set repeats at least
// `EXACT_SET_MIN_GAMES` times, otherwise (b). See that constant for the
// threshold's reasoning. Both branches carry `sampleGames` — the player's whole
// stored sample — so a caller always has the honest denominator, and the
// exact-set branch additionally carries `games`, the size of the group that
// actually produced it.
//
// ── "Make the build make sense" — what that does and does NOT mean here ────
// ORDER IS BY THE PLAYER'S OWN BUILD RATE, most-built first, ties broken by
// item id. It is NOT purchase order, and nothing on this card may imply that it
// is: `coachbuild.otp_matches` is written from Riot match-v5 detail only, with
// NO timeline call (lib/otp/ingest.ts, and CLAUDE.md's OTP pipeline note says so
// explicitly), so purchase order is not merely unavailable — it was never
// fetched. The same card already says this out loud about skill order, in those
// words, and this file holds the same line. A plausible-looking buy order we
// cannot evidence is exactly the fabrication HARD RULE 4 bans.
//
// The sense the build DOES make: it is six real slots, exactly one pair of
// boots, no starters, no snowball stacks, no components — a legal inventory,
// which the raw frequency list was not.
// ─────────────────────────────────────────────────────────────────────────────

import type { ItemDetail } from "@/components/itemDetail";
import { isSnowballStackItem } from "@/lib/snowballStacks";
import { STARTING_ITEM_ALLOWLIST } from "@/lib/startingItems";

/** One item and how often this player finishes a game holding it — the shape
 *  `/api/otp/featured` already returns (`ItemBuildRate`), restated here so this
 *  module has no dependency on the route. */
export interface FeaturedItemRate {
  itemId: number;
  games: number;
  pct: number;
}

/** What an item id IS, for this card's four slots. Exactly one value per id —
 *  the classifier is a total function, so no id can land in two slots or none.
 *  - `completed` — a real, finished, non-boots build slot.
 *  - `boots`     — finished footwear; its own slot since 2026-07-29.
 *  - `starter`   — an opener (HARD RULE 2: never inside a completed list).
 *  - `snowball`  — Mejai's/Dark Seal (lib/snowballStacks.ts); shown nowhere.
 *  - `excluded`  — component, consumable, trinket, unpurchasable, or an id we
 *                  have no metadata for. Never assumed to be finished. */
export type FeaturedItemClass = "completed" | "boots" | "starter" | "snowball" | "excluded";

/**
 * Classify one item id for the featured card.
 *
 * PRECEDENCE IS LOAD-BEARING and reads top to bottom.
 *
 * STARTER BEATS SNOWBALL, and the order of those two lines is the whole
 * argument. Dark Seal (1082) is in both families, and it classifies `starter`.
 * The snowball rule exists to keep a stack out of BUILD SLOTS — that is what
 * the user's directive says, and it names Mejai's, which is not allowlisted and
 * so still classifies `snowball` and is still excluded from every build slot.
 * An OPENER is not a build slot: Dark Seal in an "Opens" row is a real read on
 * how a player plays the lane, which is why that row exists at all.
 *
 * This was the other way round when first written, which contradicted
 * lib/snowballStacks.ts's own stated contract ("must NOT be applied to the
 * starter partition") and silently made the featured card disagree with the Pro
 * card about the same item — Pro keeps Dark Seal in its Starting slot
 * (2026-07-22 directive, regression-tested in proConsensus.test.ts) while the
 * featured card hid it. Two answers for one item on two surfaces of the same
 * kind is the bug; the swap is what makes them agree. Caught by fronty on
 * review, 2026-07-29.
 *
 * Starter then beats boots and completed (HARD RULE 2). No metadata means
 * `excluded`, never a guess — the same posture proConsensus.ts's `isBuildItem`
 * and itemSetBody.ts's `isFullItem` both take.
 *
 * The completed/boots rules mirror proConsensus.ts's `isBuildItem` +
 * `isBootsFinal` exactly, INCLUDING the `from.length > 0` clause on the boots
 * branch, which is not decoration: raw tier-1 Boots (1001) is Boots-tagged and
 * built from nothing, and without that clause it would classify as a real boots
 * pick and could take a slot in the boots list AND in a "full build". It is a
 * mid-build component. With the clause it falls through to the `into` rule,
 * which excludes it (1001 upgrades into every tier-2 boot).
 */
export function classifyFeaturedItem(itemId: number, meta: ItemDetail | undefined): FeaturedItemClass {
  if (STARTING_ITEM_ALLOWLIST.has(itemId)) return "starter";
  if (isSnowballStackItem(itemId)) return "snowball";
  if (!meta) return "excluded";
  if (meta.purchasable === false) return "excluded";
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.includes("Consumable") || tags.includes("Trinket")) return "excluded";
  const from = Array.isArray(meta.from) ? meta.from : [];
  if (tags.includes("Boots") && from.length > 0) return "boots";
  return Array.isArray(meta.into) && meta.into.length === 0 ? "completed" : "excluded";
}

/** One slot of the full build. `games`/`pct` are this player's OVERALL build
 *  rate for the item across their whole stored sample — deliberately NOT a rate
 *  "within the build", which would be 100% for every slot of an exact set and
 *  therefore say nothing. */
export interface FullBuildItem {
  itemId: number;
  games: number;
  pct: number;
  isBoots: boolean;
}

/**
 * The full build, tagged with how it was derived. See the module header.
 *
 * The `games: null` on the synthesised branch is not an oversight and must not
 * be "tidied" into 0 or made optional: it is the type-level guarantee that a UI
 * cannot print a game count beside a build nobody played.
 */
export type FeaturedFullBuild =
  | {
      /** The player finished `games` separate games holding EXACTLY these
       *  items. A real, observed build. */
      method: "most-played-exact";
      games: number;
      sampleGames: number;
      items: FullBuildItem[];
    }
  | {
      /** ASSEMBLED from per-item build rates. No single game is claimed. Every
       *  item's own `games`/`pct` is real; the COMBINATION is not evidenced. */
      method: "assembled-from-rates";
      games: null;
      sampleGames: number;
      items: FullBuildItem[];
    };

export interface FeaturedBuildView {
  /** Completed, non-boots items, most-built first, already truncated to
   *  `itemLimit`. Snowball stacks and starters are removed BEFORE the
   *  truncation, so the freed slot is backfilled by the next-most-built item
   *  rather than left empty (the user's "put another full item in its place"). */
  items: FeaturedItemRate[];
  /** Top boots by how often this player FINISHED a game holding them, over the
   *  same denominator as every other percentage on the card (their stored
   *  games). Up to `bootsLimit`; shorter, or empty, when they have not built
   *  that many — never padded. */
  boots: FeaturedItemRate[];
  /** Openers, most-built first. Dark Seal IS here — the snowball rule governs
   *  build slots, not openers, so it classifies `starter` (see
   *  `classifyFeaturedItem`'s precedence note and lib/snowballStacks.ts). That
   *  keeps this card and the Pro card's Starting slot saying the same thing
   *  about the same item, which is the point. Mejai's is not allowlisted and
   *  never reaches this list. */
  starters: FeaturedItemRate[];
  /** Null when the sample yields no legal build at all (no completed item ever
   *  reached, e.g. a brand-new account) — absent, not empty, the same
   *  convention proConsensus.ts's `boots`/`starters` use. */
  fullBuild: FeaturedFullBuild | null;
}

/** Slots in a League inventory, and therefore the hard cap on a full build.
 *  Same number as itemSetBody.ts's `LINE_LEN`, same reason: a build line is a
 *  real target loadout, not a shopping progression (CLAUDE.md HARD RULE 1). */
const FULL_BUILD_SLOTS = 6;

/**
 * Fewest items a game must have finished with to vote for an exact set.
 *
 * A 15-minute surrender leaves two items, and those short games are numerous
 * and identical to each other — left eligible they would win the modal vote
 * outright and the card would present "their most-built build" as two items.
 * Five (five legendaries, or four plus boots) is the point where a game has
 * committed to a build rather than been abandoned during one.
 */
const EXACT_SET_MIN_ITEMS = 5;

/**
 * Times the modal exact set must REPEAT before it is allowed to be called "the
 * build they build most".
 *
 * The steer here was: prefer the truthful method when an exact set repeats
 * enough to mean anything, else fall back and label it. Three is where that
 * line sits, and the reasoning is about what each count would let a reader
 * conclude, not about a significance test we do not have the sample for:
 *   n=1 — one game. Calling it "most built" is false on its face.
 *   n=2 — the same six items twice out of ~37 is roughly what an unremarkable
 *         player produces by accident; it evidences the build happened twice,
 *         not that it is their build.
 *   n=3 — a deliberate repeat. On a 37-game sample that is ~8% of their games
 *         landing on one exact inventory out of the many an item pool allows,
 *         which is a real preference rather than coincidence.
 * Below it the assembled build is BETTER data (every item rests on the whole
 * sample) and is labelled as a synthesis, so nothing is lost by falling back —
 * which is why the threshold errs high rather than low.
 */
const EXACT_SET_MIN_GAMES = 3;

const DEFAULT_ITEM_LIMIT = 6;
/** Three, per the user's directive ("show the top three boots with
 *  percentages"). The Pro card shows two; a one-trick's boot choice is a
 *  sharper read on how they play, which is the point of this card. */
const DEFAULT_BOOTS_LIMIT = 3;
const DEFAULT_STARTERS_LIMIT = 2;

export interface FeaturedViewOptions {
  itemLimit?: number;
  bootsLimit?: number;
  starterLimit?: number;
  /**
   * Build rates below this are one or two games — a situational pickup or a
   * game that ended early — and reading them at the same visual weight as a
   * 70% core item is what made the old card feel padded.
   *
   * Applies to `items` ONLY. Two things it deliberately does not touch:
   *
   * - `boots` — see `bootsMinDisplayPct`. A shared floor quietly defeated the
   *   directive: measured on a realistic 37-game sample, a 15% floor cut the
   *   third boot (3/37 = 8%) and the card showed two, not "the top three
   *   boots" the user asked for. A third boot at 8% is not noise on this
   *   card; it is the read that this player has a third option at all.
   * - `fullBuild` — a legal six-slot inventory is worth more than a tidy
   *   threshold, and dropping a slot to honour a display cutoff would produce
   *   a five-item "full build".
   */
  minDisplayPct?: number;
  /** Floor for `boots`, defaulting to 0 so "top three boots" means three.
   *  Separate from `minDisplayPct` on purpose — see that field. */
  bootsMinDisplayPct?: number;
}

function byRateDesc(a: FeaturedItemRate, b: FeaturedItemRate): number {
  return b.games - a.games || a.itemId - b.itemId;
}

/**
 * The featured card's whole item model.
 *
 * @param rates      per-item build rates (`FeaturedBuildModel.items`), any order
 * @param gameItems  per-game deduped inventories (`FeaturedBuildModel.gameItems`)
 * @param sampleGames the stored-game denominator every pct on the card uses
 * @param meta       ddragon item metadata, client-fetched (`getItemDetailMap`)
 *
 * Never throws. An empty/absent metadata map degrades to an empty card rather
 * than to a card full of components — see `classifyFeaturedItem`.
 */
export function buildFeaturedView(
  rates: readonly FeaturedItemRate[],
  gameItems: readonly (readonly number[])[],
  sampleGames: number,
  meta: ReadonlyMap<number, ItemDetail>,
  opts: FeaturedViewOptions = {}
): FeaturedBuildView {
  const itemLimit = opts.itemLimit ?? DEFAULT_ITEM_LIMIT;
  const bootsLimit = opts.bootsLimit ?? DEFAULT_BOOTS_LIMIT;
  const starterLimit = opts.starterLimit ?? DEFAULT_STARTERS_LIMIT;
  const minPct = opts.minDisplayPct ?? 0;
  const bootsMinPct = opts.bootsMinDisplayPct ?? 0;

  const classOf = (id: number): FeaturedItemClass => classifyFeaturedItem(id, meta.get(id));

  // Classify ONCE, partition, THEN truncate. The order is the fix the user
  // asked for: a snowball stack is gone before anything is sliced, so the
  // seventh-most-built item moves into the sixth slot and the list stays six
  // long. Filtering after a slice would leave the hole.
  const sorted = [...rates].sort(byRateDesc);
  const inClass = (c: FeaturedItemClass) => sorted.filter((r) => classOf(r.itemId) === c);

  const items = inClass("completed")
    .filter((r) => r.pct >= minPct)
    .slice(0, itemLimit);
  const boots = inClass("boots")
    .filter((r) => r.pct >= bootsMinPct)
    .slice(0, bootsLimit);
  const starters = inClass("starter").slice(0, starterLimit);

  return {
    items,
    boots,
    starters,
    fullBuild: resolveFullBuild(sorted, gameItems, sampleGames, classOf),
  };
}

/**
 * The full build. Method (a) if an exact set repeats enough, else (b), always
 * labelled. Exported separately so it can be tested against the threshold
 * boundary without building the rest of the card.
 */
export function resolveFullBuild(
  rates: readonly FeaturedItemRate[],
  gameItems: readonly (readonly number[])[],
  sampleGames: number,
  classOf: (itemId: number) => FeaturedItemClass
): FeaturedFullBuild | null {
  // Sorted here as well as by the caller: this is a public export and the
  // assembled branch below picks "the top boot" and "the top five" positionally,
  // so it must not silently depend on the caller having sorted first.
  const ranked = [...rates].sort(byRateDesc);
  const rateOf = new Map<number, FeaturedItemRate>();
  for (const r of ranked) if (!rateOf.has(r.itemId)) rateOf.set(r.itemId, r);

  const toSlot = (itemId: number): FullBuildItem => {
    const r = rateOf.get(itemId);
    return {
      itemId,
      games: r?.games ?? 0,
      pct: r?.pct ?? 0,
      isBoots: classOf(itemId) === "boots",
    };
  };
  // Most-built first, ties by id. NOT purchase order — see the module header.
  const order = (ids: readonly number[]): FullBuildItem[] =>
    ids.map(toSlot).sort((a, b) => b.games - a.games || a.itemId - b.itemId);

  // ── (a) the most frequent COMPLETE final set ──────────────────────────────
  // A game votes only if what it finished with is a plausible finished build:
  // enough slots to be a build at all, and no more than an inventory holds (a
  // malformed row with seven ids is not an exact set anybody played, so it is
  // excluded from the vote rather than silently trimmed into one).
  const setCounts = new Map<string, { ids: number[]; n: number }>();
  for (const raw of gameItems) {
    const kept = Array.from(new Set(raw)).filter((id) => {
      const c = classOf(id);
      return c === "completed" || c === "boots";
    });
    if (kept.length < EXACT_SET_MIN_ITEMS || kept.length > FULL_BUILD_SLOTS) continue;
    const ids = [...kept].sort((a, b) => a - b);
    const key = ids.join(",");
    const g = setCounts.get(key);
    if (g) g.n += 1;
    else setCounts.set(key, { ids, n: 1 });
  }
  // Deterministic without depending on Map insertion order (which follows
  // first-seen game): biggest group wins, ties broken by the set's own key.
  const topSet = Array.from(setCounts.entries()).sort(
    (a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  )[0];

  if (topSet && topSet[1].n >= EXACT_SET_MIN_GAMES) {
    return {
      method: "most-played-exact",
      games: topSet[1].n,
      sampleGames,
      items: order(topSet[1].ids),
    };
  }

  // ── (b) assembled from per-item rates, and SAID SO ────────────────────────
  // Exactly one pair of boots, filled first so a player who always buys boots
  // cannot lose the slot to five higher-rate legendaries; the rest are the
  // most-built completed items. This is a legal inventory, not a game.
  const bestBoots = ranked.find((r) => classOf(r.itemId) === "boots") ?? null;
  const legendaries = ranked
    .filter((r) => classOf(r.itemId) === "completed")
    .slice(0, FULL_BUILD_SLOTS - (bestBoots ? 1 : 0));
  const assembled = [...(bestBoots ? [bestBoots.itemId] : []), ...legendaries.map((r) => r.itemId)];
  if (assembled.length === 0) return null;

  return {
    method: "assembled-from-rates",
    games: null,
    sampleGames,
    items: order(assembled),
  };
}
