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
// That fixed the disagreement WITHIN this card and left the one BETWEEN cards.
// All three modules still asked "is this boots?" separately, all three answered
// `tags.includes("Boots")`, and on 2026-07-29 all three were wrong together
// about 3172 Gunmetal Greaves — a tier-3 boot enchant the live catalog does not
// tag as a boot — so a one-trick line shipped two pairs of boots. The boots
// question now lives in lib/bootsItems.ts and all three call it. Same lesson one
// level up: a rule copied is a rule that will diverge exactly when it matters.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FULL BUILD, AND WHY IT CARRIES ITS OWN METHOD LABEL
// ═══════════════════════════════════════════════════════════════════════════
// User directive, 2026-07-29: "show at least one FULL build... most built I
// guess over multiple games. Make the build make sense." Extended the same day:
// "fetch all the builds from games that have 6 built items then see what the
// most common one is and show it."
//
// A FULL BUILD IS **FIVE FINISHED NON-BOOTS ITEMS PLUS BOOTS** (user directive,
// 2026-07-29, second revision). That is the whole inventory: 5 + 1 = 6, the
// number of slots the game gives you. It is stated as "5 plus boots" rather than
// "6 finished items" because the two are not the same claim — six legendaries
// and no boots is also six finished items, and it is not the build the directive
// describes. See the `full` predicate in `resolveFullBuild`.
//
// THAT BAR ONLY BECAME REACHABLE ON 2026-07-29. `scripts/ingest-otp-featured.mjs`
// requested Riot's FIRST PAGE of 100 match ids and stopped, so a prolific
// account was silently truncated; it now paginates inside the same 90-day
// freshness window. The featured Ahri one-trick went 37 -> 60 -> **232** stored
// games. Measured on those 232 by running THIS MODULE over them
// (scripts/measure-featured-branches.mts 103):
//
//   finished non-boots items per game : 0:2  1:15  2:54  3:77  4:64  5:18  6:2
//   games at 5 non-boots + boots      : 17 of 232
//   six non-boots and NO boots        : 2  (real games; not full builds)
//   sets that repeat                  : 1, four times —
//       Blackfire Torch, Mejai's Soulstealer, Rabadon's Deathcap,
//       Zhonya's Hourglass, Cosmic Drive + Crimson Lucidity (boots)
//
// So the bar is reachable, and it is TIGHT: 17 games in 232, one repeat. The
// earlier "six finished items is unreachable" measurement in this header was
// true of a 60-game sample and is now superseded — it was a fact about how few
// games we had stored, not about the game.
//
// WHAT IS SHOWN — two branches, and the caption must match the branch:
//
//   (a) THE MOST-PLAYED FULL BUILD. Group the games that reached a FULL build by
//       the exact set of finished items they ended holding, take the biggest
//       group. Used when that group has at least `EXACT_SET_MIN_GAMES` games in
//       it — a complete build they demonstrably played more than once, reported
//       with its real count against the real denominator.
//
//   (b) ONE REAL GAME. When no full build repeats, the card shows the finished
//       items from a SINGLE stored game, labelled unmistakably as one game.
//       Never "most common", never with an implied frequency.
//
// THE TWO BRANCHES HAVE DIFFERENT BARS ON PURPOSE, and that is the change of
// 2026-07-29 round 3. Branch (a) demands a full build. Branch (b) does not — it
// asks only for `SHOWABLE_MIN_ITEMS` finished items, the old floor, because a
// player whose history cannot reach a full build must still get a real game
// rather than an empty card. One bar for both would have turned every shallow
// sample into `null`, which is not "we could not find a full build", it is
// "we show you nothing".
//
// COMPARING ON FINISHED ITEMS IS WHAT MAKES (a) REACHABLE AT ALL, and getting
// this wrong is not hypothetical — it was got wrong once already while briefing
// this work, and the wrong answer was "nothing ever repeats, always show one
// game". Compare the RAW inventories and every game looks unique, because a
// half-built Needlessly Large Rod still in the bag makes two otherwise identical
// builds differ. The rod is a fact about when the game ended, not a build
// decision. Drop the components and the repeats appear.
//
// ── THE COST OF THE FULL-BUILD BAR, MEASURED, NOT ESTIMATED ────────────────
// Branch (a) used to be the common case and is now the RARE one, and that is
// accepted rather than worked around. All 172 featured accounts, 2026-07-29,
// both bars run through THIS MODULE (scripts/measure-featured-branches.mts):
//
//                      OLD: 4 finished items    NEW: 5 non-boots + boots
//                           snowball excluded        snowball included
//   most-played-exact            139 (81%)                  18 (10%)
//   single-game                   23 (13%)                 144 (84%)
//   thin-sample                    9 ( 5%)                   9 ( 5%)
//   null                           1 ( 1%)                   1 ( 1%)
//
// Read the 18 carefully before drawing a conclusion from them: FOURTEEN repeat
// a full build exactly TWICE — EXACT_SET_MIN_GAMES, the bare minimum — on
// samples of 25-44 games. The other four repeat 3, 4, 5 and 9 times. So branch
// (a) mostly survives at this bar by a single game, and the real recovery comes
// from the scheduled job accruing depth on the other 171 accounts (Ahri, the one
// account the paginating ingest has run for, holds 232 games against a median of
// 32), not from anything in this file.
//
// DO NOT "FIX" THIS BY LOWERING THE BAR BACK. The 81% -> 10% drop is the honest
// cost of a stricter definition of a complete build, not a regression.
//
// `null` IS observed live, contrary to what this header said before the
// measurement: champion 78 (Poppy, 그렇더라고요, 29 stored games) has no stored
// game that ever ended with four finished items. It is the correct answer for a
// sample of games that all ended early — the card renders no build strip, and
// still renders the opener, runes and slots.
//
// WHAT WAS REMOVED, AND WHY IT MATTERS THAT IT WAS: this used to fall back to
// an ASSEMBLED build — top boot plus the top five legendaries by build rate —
// which is a combination the player may never have finished a game holding. It
// carried a paragraph of disclaimer saying so, and the user's answer to that
// paragraph was "remove the text description there. Not needed." The paragraph
// was load-bearing for the assembled build and ONLY for it, so the honest way
// to remove the text was to remove the thing it was apologising for. A real
// game needs no disclaimer, which is the whole point of the change: the fix for
// a caption nobody wants to read is usually a claim nobody has to make.
//
// Do not reintroduce an assembled branch. If neither (a) nor (b) can be
// produced — no game in the sample ever reached a legal finished build — the
// answer is `null` and the card renders nothing, not a partial build.
//
// Both branches carry `sampleGames`, the player's whole stored sample, so a
// caller always has the honest denominator; branch (a) carries the size of the
// group that produced it and branch (b) carries `games: 1` and the outcome of
// that one game.
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
// The sense the build DOES make: it is real slots, one pair of boots, no
// starters, no components — a legal inventory, which the raw frequency list was
// not.
//
// ═══════════════════════════════════════════════════════════════════════════
// SNOWBALL STACKS ARE **IN** THE PLAYED BUILD, AND **OUT** OF THE SLOT LIST
// ═══════════════════════════════════════════════════════════════════════════
// User decision, 2026-07-29. This file previously stripped Mejai's Soulstealer
// out of a game before that game voted, which put it in agreement with
// `items`/`slots` and with the Pro card. That agreement was wrong, because the
// two surfaces are answering different questions:
//
//   `fullBuild`        — A RECORD. "These are the items they ended this game
//                        holding." Rendering that minus an item they really had
//                        is a false statement about a specific game.
//   `items` / `slots`  — A RECOMMENDATION. "This is what they build." Here the
//                        snowball rule stands, because a build rate cannot tell
//                        a core item apart from an item bought because the game
//                        was already won (lib/snowballStacks.ts's header).
//
// It is not a theoretical split. The ONLY repeating full build the featured Ahri
// one-trick has CONTAINS Mejai's; excluding it drops the qualifying games from
// 16 to 3 with zero repeats, so branch (a) would not fire for a single champion
// in the fleet. The choice is between showing a game as it was played and
// showing no played build at all.
//
// A snowball stack in the strip must not READ as advice. Three carriers, all in
// FeaturedOtpCard.tsx: the tile is ordered LAST regardless of build rate (see
// `order`), it carries a dashed border and a marked title, and the caption gains
// a clause naming it. Do not remove one and assume the other two cover it.
//
// If a future reader arrives here intending to make the two surfaces agree
// again: read lib/snowballStacks.ts's "Two surfaces, two jobs" section first.
// The inconsistency is the design.
// ─────────────────────────────────────────────────────────────────────────────

import type { ItemDetail } from "@/components/itemDetail";
// Type-only, so this stays a pure module with no runtime edge to the ingest
// half of lib/otp — but ONE definition of a stored game rather than a restated
// copy that could drift from what the route actually ships.
import type { FeaturedGame } from "./featured";
import { isSnowballStackItem } from "@/lib/snowballStacks";
import { STARTING_ITEM_ALLOWLIST } from "@/lib/startingItems";
import { resolveBuildSlots, type BuildSlot } from "@/lib/buildSlots";
import { isFinalBootsItem, type ItemCatalog } from "@/lib/bootsItems";
import { isSupportFinalItem } from "@/lib/supportFinalGroup";

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
 * The boots branch is lib/bootsItems.ts's `isFinalBootsItem` — THE boots rule
 * for the whole app, shared with proConsensus.ts and itemSetBody.ts since
 * 2026-07-29. This file used to carry its own `tags.includes("Boots")` copy,
 * and so did the other two, and all three were wrong about 3172 Gunmetal
 * Greaves together (a tier-3 boot the live catalog does not tag as one). Read
 * that module's header before changing anything here.
 *
 * `isFinalBootsItem` keeps the `from.length > 0` clause, which is not
 * decoration: raw tier-1 Boots (1001) is Boots-tagged and built from nothing,
 * and without that clause it would classify as a real boots pick and could take
 * a slot in the boots list AND in a "full build". It is a mid-build component.
 * With the clause it falls through to the `into` rule, which excludes it (1001
 * upgrades into every tier-2 boot).
 *
 * `catalog` is OPTIONAL and additive — supplying it lets the boots rule walk an
 * item's recipe and catch a boot the catalog forgot to tag. A caller that omits
 * it (FeaturedOtpCard.tsx's `include` predicate) still classifies every KNOWN
 * catalog gap correctly, via `BOOTS_ID_EXCEPTIONS`. Pass it where a map is in
 * scope.
 */
export function classifyFeaturedItem(
  itemId: number,
  meta: ItemDetail | undefined,
  catalog?: ItemCatalog
): FeaturedItemClass {
  if (STARTING_ITEM_ALLOWLIST.has(itemId)) return "starter";
  if (isSnowballStackItem(itemId)) return "snowball";
  if (!meta) return "excluded";
  if (meta.purchasable === false) return "excluded";
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.includes("Consumable") || tags.includes("Trinket")) return "excluded";
  if (isFinalBootsItem(itemId, meta, catalog)) return "boots";
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
  /** Mejai's Soulstealer (lib/snowballStacks.ts). TRUE means "they held this",
   *  never "build this" — it is in the strip because the strip is a record of a
   *  game, and it is excluded from `FeaturedBuildView.items`/`slots` in the same
   *  breath because those are a recommendation. The card MUST mark it; see the
   *  module header's three carriers. */
  isSnowball: boolean;
}

/**
 * The full build, tagged with how it was derived. See the module header.
 *
 * BOTH BRANCHES ARE GAMES THE PLAYER ACTUALLY PLAYED, which is the property
 * that let the on-screen disclaimer go away. `games` is therefore a real count
 * on both — never null, never 0 — and any caption built from it is true by
 * construction. The discriminant exists so a caption cannot say "a build they
 * play" about a sample of one.
 */
export type FeaturedFullBuild =
  | {
      /** The player finished `games` separate FULL builds (five finished
       *  non-boots items plus boots) holding EXACTLY these items.
       *  `games >= EXACT_SET_MIN_GAMES`, so it repeated. */
      method: "most-played-exact";
      games: number;
      sampleGames: number;
      items: FullBuildItem[];
    }
  | {
      /** A set the player finished `games` separate games holding, which
       *  REPEATED but is short of a full build — at least
       *  `PARTIAL_BUILD_MIN_NON_BOOTS` finished non-boots items plus boots, but
       *  fewer than `FULL_BUILD_MIN_NON_BOOTS`.
       *
       *  `nonBootsItems` is on the branch, not derivable-and-forgotten, because
       *  this tier's whole risk is being read as a full build. A caption MUST
       *  state this count. The two repeating tiers differ in WHAT THEY ARE, not
       *  merely in how often they happened, so they are separate branches
       *  rather than one branch with a flag. */
      method: "most-played-partial";
      games: number;
      nonBootsItems: number;
      sampleGames: number;
      items: FullBuildItem[];
    }
  | {
      /** ONE stored game. NEITHER repeating tier was reachable, so this is that
       *  game's finished items and nothing more — no frequency is claimed and
       *  `games` is the literal 1, so no caption can inflate it. It is NOT
       *  necessarily a full build: the pool this is drawn from uses
       *  `SHOWABLE_MIN_ITEMS`, deliberately lower. A caption may therefore not
       *  call it complete. */
      method: "single-game";
      games: 1;
      /** Did they win the game shown. `null` ONLY when the response body
       *  predates the per-game outcome field — never a stand-in for a loss,
       *  because "a game they lost" is a fabricated fact and HARD RULE 4 bans
       *  those. A caption may only claim an outcome on `true`/`false`. */
      won: boolean | null;
      sampleGames: number;
      items: FullBuildItem[];
    };

export interface FeaturedBuildView {
  /** Completed, non-boots items, most-built first, already truncated to
   *  `itemLimit` unless the display floor would otherwise leave fewer than
   *  five. Snowball stacks and starters are removed BEFORE the
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
  /** Null when NO stored game ever ended with a legal finished build — a
   *  brand-new account, or a sample of games that all ended early. Absent, not
   *  empty, and never a partial build: the same convention proConsensus.ts's
   *  `boots`/`starters` use. */
  fullBuild: FeaturedFullBuild | null;
  /** 2026-07-29 — the same completed items as `items`, regrouped into SLOTS:
   *  one build decision per entry, with the items that get built INSTEAD of the
   *  go-to attached to it (lib/buildSlots.ts).
   *
   *  ADDITIVE. `items` is unchanged and still the flat ranking, because the two
   *  answer different questions and a card may legitimately want either — and
   *  because changing `items`' type would have broken a wired card for a
   *  presentational choice. Slots are derived from the SAME per-item counts, so
   *  a percentage cannot differ between the two views.
   *
   *  Empty when the sample cannot support the claim — a small sample, or a
   *  genuinely settled build. Both are honest; see `resolveBuildSlots`. */
  slots: BuildSlot[];
}

/** Slots in a League inventory, and therefore the hard cap on a full build.
 *  Same number as itemSetBody.ts's `LINE_LEN`, same reason: a build line is a
 *  real target loadout, not a shopping progression (CLAUDE.md HARD RULE 1). */
const FULL_BUILD_SLOTS = 6;

/**
 * A COMPLETE BUILD: this many finished NON-BOOTS items, plus boots.
 *
 * Five, per the user's directive of 2026-07-29 ("5 finished non-boots items PLUS
 * boots"). Five plus one is `FULL_BUILD_SLOTS`, so a qualifying game is a FULL
 * inventory of finished items and nothing else — no components, no starter, no
 * empty slot.
 *
 * Stated as "5 non-boots + boots" and NOT as ">= 6 finished items", and the
 * difference is real rather than pedantic: six legendaries with no boots also
 * totals six, and it is not the build the directive describes. On the live
 * 232-game Ahri sample two games ended with six finished non-boots items and no
 * boots; they do NOT qualify. That is deliberate — boots are a build decision
 * this card gives its own section to, and a "full build" missing the one item
 * every player buys would be the odd claim, not the strict rule.
 *
 * WHAT IT COSTS, measured (232 stored Ahri games, 2026-07-29):
 *
 *   finished non-boots per game : 0:2  1:15  2:54  3:78  4:63  5:18  6:2
 *   qualifying (5 + boots)      : 16 games
 *   distinct sets               : 13
 *   repeating                   : 1, four times
 *
 * The previous floor was FOUR TOTAL finished items (three legendaries plus
 * boots), chosen when the deepest sample we held was 60 games and five was
 * unreachable. It is not gone — it survives as `SHOWABLE_MIN_ITEMS`, the pool
 * branch (b) draws its one real game from.
 */
const FULL_BUILD_MIN_NON_BOOTS = 5;

/**
 * Fewest finished non-boots items for the MIDDLE tier — a build that repeated
 * but is one item short of the directive's full build.
 *
 * WHY A MIDDLE TIER EXISTS. Raising the bar to five measured its own cost: run
 * over all 172 featured accounts, branch (a) fell from 139 champions to 18, and
 * 144 landed on the one-real-game fallback. The cause is DEPTH, not the rule —
 * the median account holds ~39 stored games and only Ahri has been deepened
 * (232). A build the player repeated four times is more informative than one
 * arbitrary game even when it is a slot short, so the ladder now degrades
 * through it rather than straight past it (user directive 2026-07-29).
 *
 * FOUR IS THE FLOOR, and it is measured rather than picked. At three finished
 * non-boots items the modal set on the Peng04 sample wins thirteen times and is
 * [Blackfire Torch, Crimson Lucidity, Cosmic Drive] — a boot and two items,
 * which is a game that ended early, not a build. Do not add a third rung.
 *
 * The tier is NOT a full build and its caption must never imply one: the union
 * branch below carries `nonBootsItems` precisely so the caption states the size
 * it is actually describing.
 */
const PARTIAL_BUILD_MIN_NON_BOOTS = 4;

/**
 * Fewest FINISHED items a game must have ended with to be SHOWABLE as branch
 * (b)'s one real game. Lower than a full build on purpose — see the module
 * header's "two bars" note.
 *
 * Measured on the 60-game Peng04 Ahri sample, when this was the only bar:
 *
 *   >= 3 : 54 of 60 games qualify and the modal set wins THIRTEEN times — but
 *          it is [Blackfire Torch, Crimson Lucidity, Cosmic Drive], a boot and
 *          two items. That is a game that ended early, not a build, and at this
 *          threshold short games swamp the vote.
 *   >= 4 : 32 qualify, 22 distinct. A real build: three legendaries plus boots,
 *          or four legendaries.
 *
 * A 15-minute surrender leaves two finished items and is still excluded, which
 * is the case this floor exists for.
 *
 * The upper bound is `FULL_BUILD_SLOTS` — a row claiming seven finished items
 * is malformed and is dropped rather than silently trimmed into a set nobody
 * played.
 */
const SHOWABLE_MIN_ITEMS = 4;

/**
 * Times the modal exact set must REPEAT before it is preferred over showing one
 * real game.
 *
 * TWO, and the number moved from three when the fallback changed. That is the
 * whole argument, so it is worth stating plainly: the old fallback was a build
 * ASSEMBLED from per-item rates, where every item rested on the entire sample,
 * so at n=2 the synthesis was genuinely the stronger data and the threshold
 * erred high to reach it. The fallback is now a SINGLE GAME — n=1. Against
 * that, "they finished 2 of 37 games holding exactly this set" is strictly more
 * evidence, quoted against the same denominator, so there is nothing left for a
 * higher threshold to buy.
 *
 * It also makes the fallback's caption TRUE. Branch (b) can only be reached
 * when the biggest group is smaller than this, and at 2 that means the biggest
 * group is exactly 1 — so "no FULL BUILD repeats across the games we hold" is a
 * fact whenever it is printed. At 3 it would have been a lie in exactly the case
 * a build repeated twice. The threshold and the wording are one decision; do not
 * move either alone.
 *
 * THE WORD "FULL" IS NOW LOAD-BEARING IN THAT CAPTION and was added with the
 * split bars (2026-07-29). The vote runs over full builds only, so a FOUR-item
 * set may well repeat in a sample that still reaches branch (b). The old wording
 * — "no set repeats" — became false the moment the two bars diverged.
 */
const EXACT_SET_MIN_GAMES = 2;

const DEFAULT_ITEM_LIMIT = 6;
/** A usable OTP recommendation always names five full items; boots are kept
 *  in their own slot. The display floor remains the primary signal, but a
 *  sparse consensus is backfilled below that floor rather than rendering a
 *  three-item "build". */
const MIN_FULL_ITEMS_FOR_BUILD = 5;
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
  /**
   * Stored games below which this view carries NOTHING — no rates, no slots,
   * no example build.
   *
   * The card has always had this floor (`FeaturedOtpCard`'s MIN_SAMPLE_GAMES,
   * 12) but it lived only in a JSX branch, where the rule is one refactor away
   * from being routed around and cannot be tested at all — this repo has no JSX
   * rendering harness. It is enforced here as well so the floor is a property
   * of the MODEL: below it the honest answer is "we are still collecting their
   * games", and a caller that forgets the branch gets an empty view rather than
   * a five-game percentage.
   *
   * Defaults to 0 (no floor) so the engine stays a pure aggregator for callers
   * that have their own guard.
   */
  minSampleGames?: number;
  /**
   * Keep the five mutually-exclusive support-quest finals (Bloodsong et al,
   * lib/supportFinalGroup.ts) out of `items` and `slots` — the RECOMMENDATION
   * surfaces. Callers set this for every non-support lane: a handful of
   * mis-roled stored games can put Bloodsong into a top-laner's sample, and
   * the display floor was the only thing hiding it before the sparse-build
   * backfill existed. `fullBuild` is deliberately untouched — it is a RECORD
   * of games actually played, and editing a record fabricates a game nobody
   * played (same reasoning as Mejai's three-carrier rule above).
   */
  excludeSupportFinalItems?: boolean;
}

function byRateDesc(a: FeaturedItemRate, b: FeaturedItemRate): number {
  return b.games - a.games || a.itemId - b.itemId;
}

/** Everything an empty view is. Named so the thin-sample floor and a genuinely
 *  empty sample return the SAME thing and cannot drift apart. */
const EMPTY_VIEW: FeaturedBuildView = {
  items: [],
  boots: [],
  starters: [],
  fullBuild: null,
  slots: [],
};

/**
 * The featured card's whole item model.
 *
 * @param rates      per-item build rates (`FeaturedBuildModel.items`), any order
 * @param gameLog    per-game records (`FeaturedBuildModel.gameLog`), NEWEST FIRST
 * @param sampleGames the stored-game denominator every pct on the card uses
 * @param meta       ddragon item metadata, client-fetched (`getItemDetailMap`)
 *
 * Never throws. An empty/absent metadata map degrades to an empty card rather
 * than to a card full of components — see `classifyFeaturedItem`.
 */
export function buildFeaturedView(
  rates: readonly FeaturedItemRate[],
  gameLog: readonly FeaturedGame[],
  sampleGames: number,
  meta: ReadonlyMap<number, ItemDetail>,
  opts: FeaturedViewOptions = {}
): FeaturedBuildView {
  const itemLimit = opts.itemLimit ?? DEFAULT_ITEM_LIMIT;
  const bootsLimit = opts.bootsLimit ?? DEFAULT_BOOTS_LIMIT;
  const starterLimit = opts.starterLimit ?? DEFAULT_STARTERS_LIMIT;
  const minPct = opts.minDisplayPct ?? 0;
  const bootsMinPct = opts.bootsMinDisplayPct ?? 0;

  // Before anything is counted: too few stored games and every number below
  // would be a percentage of five. See `minSampleGames`.
  if (sampleGames < (opts.minSampleGames ?? 0)) return EMPTY_VIEW;

  // `meta` doubles as the catalog so the shared boots rule can walk recipes —
  // see lib/bootsItems.ts. Classify ONCE per id, here, and never re-derive.
  const classOf = (id: number): FeaturedItemClass => classifyFeaturedItem(id, meta.get(id), meta);

  // Classify ONCE, partition, THEN truncate. The order is the fix the user
  // asked for: a snowball stack is gone before anything is sliced, so the
  // seventh-most-built item moves into the sixth slot and the list stays six
  // long. Filtering after a slice would leave the hole.
  const sorted = [...rates].sort(byRateDesc);
  const inClass = (c: FeaturedItemClass) => sorted.filter((r) => classOf(r.itemId) === c);

  const completed = opts.excludeSupportFinalItems
    ? inClass("completed").filter((r) => !isSupportFinalItem(r.itemId))
    : inClass("completed");
  const floorItems = completed.filter((r) => r.pct >= minPct).slice(0, itemLimit);
  // Keep the floor as the primary signal. Only when it leaves fewer than a
  // full five-item recommendation do the highest-usage below-floor completed
  // items fill the missing slots; percentages are the original, honest rates.
  const items =
    floorItems.length >= MIN_FULL_ITEMS_FOR_BUILD
      ? floorItems
      : [
          ...floorItems,
          ...completed
            .filter((r) => r.pct < minPct)
            .slice(0, MIN_FULL_ITEMS_FOR_BUILD - floorItems.length),
        ];
  const boots = inClass("boots")
    .filter((r) => r.pct >= bootsMinPct)
    .slice(0, bootsLimit);
  const starters = inClass("starter").slice(0, starterLimit);
  const displayedItemIds = new Set(items.map((item) => item.itemId));
  // Slots admit every floor-clearing completed id, NOT just the displayed six.
  // `displayedItemIds` alone re-priced contested pairs: a pair used to cost one
  // SLOT but no item budget, so capping slot membership at the displayed list
  // silently dropped a deep-sampled champion's sixth item (measured live:
  // Viktor lost Rabadon's, Teemo lost Zhonya's). The union keeps the old
  // budget for well-sampled ids while still letting backfilled below-floor
  // ids form slots at all (they need `minPct: 0` to survive resolveBuildSlots'
  // own floor).
  const slotItemIds = new Set([
    ...completed.filter((r) => r.pct >= minPct).map((r) => r.itemId),
    ...displayedItemIds,
  ]);

  return {
    items,
    boots,
    starters,
    fullBuild: resolveFullBuild(sorted, gameLog, sampleGames, classOf),
    // Non-boots completed items only. Boots already have a dedicated slot on
    // this card, and they are the single most reliably "competing" family there
    // is (every boots pair in the live probe measured lift 0.00) — slotting them
    // here as well would say the same thing twice on one card.
    slots: resolveBuildSlots(
      gameLog.map((g) => g.items),
      sampleGames,
      {
        include: (id) => classOf(id) === "completed" && slotItemIds.has(id),
        minPct: 0,
      }
    ),
  };
}

/**
 * The example build: a repeated FULL build if one exists, otherwise one real
 * game, otherwise nothing. Exported separately so it can be tested against the
 * threshold boundaries without building the rest of the card.
 *
 * @param gameLog NEWEST FIRST. The order is load-bearing — it is the recency
 *                tiebreak for branch (b) — and it is the order the route's
 *                `ORDER BY game_creation DESC` produces. A caller that reorders
 *                it gets a different (still deterministic) pick.
 */
export function resolveFullBuild(
  rates: readonly FeaturedItemRate[],
  gameLog: readonly FeaturedGame[],
  sampleGames: number,
  classOf: (itemId: number) => FeaturedItemClass
): FeaturedFullBuild | null {
  // Sorted here as well as by the caller: this is a public export, and `order`
  // below depends on the per-item rates being resolvable, so it must not
  // silently depend on the caller having sorted first.
  const ranked = [...rates].sort(byRateDesc);
  const rateOf = new Map<number, FeaturedItemRate>();
  for (const r of ranked) if (!rateOf.has(r.itemId)) rateOf.set(r.itemId, r);

  const toSlot = (itemId: number): FullBuildItem => {
    const r = rateOf.get(itemId);
    const c = classOf(itemId);
    return {
      itemId,
      games: r?.games ?? 0,
      pct: r?.pct ?? 0,
      isBoots: c === "boots",
      isSnowball: c === "snowball",
    };
  };
  // Most-built first, ties by id — EXCEPT a snowball stack, which is pinned
  // LAST whatever its build rate.
  //
  // That exception is one of the three things stopping "they held Mejai's in
  // this game" reading as "build Mejai's here" (module header). A stack a
  // snowballing one-trick finishes 40% of their games holding can genuinely
  // out-rank a core item on build rate, and a strip that opens with it puts the
  // one item this app refuses to recommend in the position a reader reads as
  // "first and most important". Sorting it to the end costs nothing — this
  // strip is explicitly NOT purchase order, so position carries no claim that
  // moving it could break.
  const order = (ids: readonly number[]): FullBuildItem[] =>
    ids
      .map(toSlot)
      .sort(
        (a, b) =>
          (a.isSnowball ? 1 : 0) - (b.isSnowball ? 1 : 0) ||
          b.games - a.games ||
          a.itemId - b.itemId
      );

  // ── ELIGIBILITY ───────────────────────────────────────────────────────────
  // What counts as a HELD item for the record: completed, boots, or a snowball
  // stack. No starter, no component, no consumable, no trinket.
  //
  // The snowball stack is in this list and is NOT in `FeaturedBuildView.items`
  // / `slots`, deliberately — a record versus a recommendation. Read the module
  // header's "SNOWBALL STACKS ARE IN THE PLAYED BUILD" section before removing
  // it to make the two agree; the disagreement is the design, and removing it
  // costs the fleet its only repeating full build.
  const isHeld = (c: FeaturedItemClass) => c === "completed" || c === "boots" || c === "snowball";

  // TWO BARS, one pass. `full` is the directive's complete build (five finished
  // non-boots items plus boots) and only full builds vote in branch (a).
  // `showable` is the lower floor branch (b) draws its single real game from,
  // so a player who never reaches a full build still gets a real game instead
  // of an empty card. Every full build is showable; the reverse is not true.
  type Candidate = {
    ids: number[];
    key: string;
    win: boolean | null;
    index: number;
    full: boolean;
    /** Finished non-boots items held. Drives BOTH repeating tiers and is
     *  reported on the middle branch, so it is counted once here rather than
     *  re-derived per tier. */
    nonBoots: number;
  };
  const showable: Candidate[] = [];
  gameLog.forEach((game, index) => {
    const kept = Array.from(new Set(game.items)).filter((id) => isHeld(classOf(id)));
    if (kept.length < SHOWABLE_MIN_ITEMS || kept.length > FULL_BUILD_SLOTS) return;
    const boots = kept.filter((id) => classOf(id) === "boots").length;
    const nonBoots = kept.length - boots;
    const full = boots >= 1 && nonBoots >= FULL_BUILD_MIN_NON_BOOTS;
    const ids = [...kept].sort((a, b) => a - b);
    showable.push({ ids, key: ids.join(","), win: game.win, index, full, nonBoots });
  });
  if (showable.length === 0) return null;

  /** Biggest repeating set among candidates passing `eligible`, or null.
   *  Deterministic without depending on Map insertion order (which follows
   *  first-seen game): biggest group wins, ties broken by the set's own key. */
  const topRepeatingSet = (
    eligible: (c: Candidate) => boolean
  ): { ids: number[]; n: number; nonBoots: number } | null => {
    const counts = new Map<string, { ids: number[]; n: number; nonBoots: number }>();
    for (const g of showable) {
      if (!eligible(g)) continue;
      const seen = counts.get(g.key);
      if (seen) seen.n += 1;
      else counts.set(g.key, { ids: g.ids, n: 1, nonBoots: g.nonBoots });
    }
    const top = Array.from(counts.entries()).sort(
      (a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    )[0];
    return top && top[1].n >= EXACT_SET_MIN_GAMES ? top[1] : null;
  };

  // ── (a) the FULL build they played most, when it repeats ──────────────────
  const topFull = topRepeatingSet((g) => g.full);
  if (topFull) {
    return {
      method: "most-played-exact",
      games: topFull.n,
      sampleGames,
      items: order(topFull.ids),
    };
  }

  // ── (a2) MIDDLE TIER: a shorter build they nonetheless repeated ───────────
  // Only reached when no FULL build repeated, so (a) always wins where both
  // exist — the ladder degrades, it does not choose. Eligibility is the partial
  // floor AND not full, which is redundant with (a) having failed but says the
  // tier's own rule locally rather than resting on the branch above it.
  const topPartial = topRepeatingSet(
    (g) => !g.full && g.nonBoots >= PARTIAL_BUILD_MIN_NON_BOOTS && g.ids.length - g.nonBoots >= 1
  );
  if (topPartial) {
    return {
      method: "most-played-partial",
      games: topPartial.n,
      nonBootsItems: topPartial.nonBoots,
      sampleGames,
      items: order(topPartial.ids),
    };
  }

  // ── (b) ONE real game ─────────────────────────────────────────────────────
  // Reached only when NEITHER repeating tier was available: no full build
  // repeated AND no partial build repeated. That is what the caption may claim
  // and no more.
  //
  // It may NOT say "no set repeats" — a THREE-item set can still repeat in a
  // sample that lands here, and that sentence stopped being true the moment the
  // bars diverged. It may not say "no full build repeats" alone either, now that
  // failing the full bar is no longer sufficient to reach this branch. Say what
  // is actually true: nothing repeated at either bar we are willing to call a
  // build. This caption has been wrong twice already; keep it pinned to the
  // condition directly above it.
  //
  // The pick is drawn from `showable`, NOT from the full builds only. A player
  // with one full build and nothing else gets it via key 2 below (most finished
  // items) without needing a special case; a player with none still gets their
  // best real game.
  //
  // WHICH game, and why it is not arbitrary. Three keys, in order:
  //
  //   1. THEY WON IT. A build that closed a game out is the one worth copying,
  //      and the outcome is stated in the caption rather than hidden, so the
  //      selection bias is disclosed instead of being a silent thumb on the
  //      scale. `win: null` (a legacy body with no outcome field) ranks WITH
  //      the losses rather than above them — an unknown outcome is not a win.
  //   2. MOST FINISHED ITEMS. Among wins, the game that got furthest is the
  //      fullest build, and "fullest" is what the card is being asked for.
  //   3. MOST RECENT. `gameLog` is newest-first, so the lowest index wins.
  //      Indices are unique, which makes this key TOTAL: the comparator can
  //      never fall through to an unspecified order, so the same stored sample
  //      always yields the same game on every render. That is the property
  //      that matters — not that the pick never changes, but that it only
  //      changes when the DATA does.
  const pick = [...showable].sort(
    (a, b) =>
      (b.win === true ? 1 : 0) - (a.win === true ? 1 : 0) ||
      b.ids.length - a.ids.length ||
      a.index - b.index
  )[0];

  return {
    method: "single-game",
    games: 1,
    won: pick.win,
    sampleGames,
    items: order(pick.ids),
  };
}
