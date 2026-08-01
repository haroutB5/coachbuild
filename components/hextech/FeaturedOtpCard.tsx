"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FeaturedOtpCard — ONE named one-trick, and what they actually build.
//
// Replaces the eight-account OTP consensus (user directive 2026-07-29). The
// consensus answered "what do good one-tricks build on average", which is a
// build nobody plays: average away the disagreement and you get the same core
// the WPA and Pro cards already show. This answers "what does the best Viktor
// one-trick build", which is copyable, and shows the DISAGREEMENT rather than
// hiding it — an item at 60% means he builds it in six games out of ten, and
// that is the useful part.
//
// Every percentage on this card is over the games WE HOLD for that account,
// which is smaller than the source's career total.
//
// HOW THE TWO DENOMINATORS ARE KEPT APART (redesign, 2026-07-29). This used to
// be one grey two-line paragraph at the top of the card, which ate the fold and
// read as boilerplate. It is now carried by the LABELS at both ends instead:
// the KPI strip says CAREER GAMES / CAREER WIN RATE (the source's totals, which
// is what those fields are), and every section whose numbers come from OUR
// stored sample states that sample in its own heading meta ("37 stored games ·
// 54% won"). Same fact, said where it applies, costing no vertical space.
// Do not collapse the two vocabularies back into one word.
//
// ── WHAT 2026-07-29 (round 2) ADDED, AND THE HONESTY RULE THAT GOVERNS IT ────
// User report: the card was a frequency LIST (Crimson Lucidity 84%, Blackfire
// Torch 70%, …), which is not a build anyone can copy. It now leads with an
// actual FULL BUILD, gives boots their own slot, and renders the complete rune
// page instead of a keystone and three shard icons.
//
// The build strip can be produced two ways, and THE CAPTION MUST MATCH THE
// METHOD — this is the single most load-bearing rule in this file. The method
// is decided in lib/otp/featuredBuild.ts and arrives as a discriminated union:
//
//   "most-played-exact" — a FULL BUILD (five finished non-boots items plus
//                         boots) this player DEMONSTRABLY ended `games`
//                         separate games holding. The caption says they played
//                         it, and states that count against `sampleGames`.
//   "single-game"       — ONE stored game's finished items, shown because no
//                         FULL BUILD repeated. `games` is the literal 1 and
//                         `won` carries that game's real outcome, so the
//                         caption can name it as one game and say how it went,
//                         and cannot imply a frequency. It is NOT necessarily a
//                         complete build and the caption must not call it one —
//                         branch (b) draws from a lower floor on purpose, so a
//                         shallow sample still gets a real game.
//
// A SNOWBALL STACK (Mejai's) STAYS IN THE STRIP, and is excluded from the slot
// list two sections below. The strip reports one game; the slot list
// recommends. See lib/snowballStacks.ts's "Two surfaces, two jobs". It is
// marked three ways so the report cannot read as advice: ordered last, dashed
// tile with a marked alt/title, and named in the caption. Removing one carrier
// and trusting the other two is how it quietly becomes advice again.
//
// BOTH ARE GAMES THIS PLAYER PLAYED. That is new, and it is what let two grey
// paragraphs come off the card on 2026-07-29 ("remove the text description
// there. Not needed"):
//
//   1. The assembled-build disclaimer ("...put together from those rates, not
//      taken from one game, so they may never have finished a game holding
//      exactly this set. Not a purchase order: the match data stores a final
//      inventory, never what was bought first."). The assembled branch is GONE,
//      so the apology has nothing left to apologise for. The purchase-order
//      half of it went with it by the same user directive — the constraint it
//      protected is still absolute and is enforced structurally instead: the
//      tiles are unnumbered, unordered-looking, and `resolveFullBuild` sorts
//      them by BUILD RATE, never by inventory slot. A capped timeline may be
//      stored for skill order, but purchase order is not stored or rendered,
//      so no surface here may imply one. Do not number these tiles.
//   2. The "indented items are built instead of the one above them" paragraph.
//      Replaced by a four-word inline key, and the relationship itself is
//      unchanged and still carried three ways by BuildSlotList: the literal
//      word "or" on every alternative row, the labelled nested list
//      ("Built instead of X in this slot"), and the single divided bar.
//
// This repo shipped v0.73.1 over two denominators drifting apart. Every number
// on this card is quoted against `sample.games` — the games WE hold — including
// the exact-set count, which is "3 of 37", never "3 of the 20 that qualified".
// A second denominator is the bug, not a clarification.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import {
  itemIconUrl,
  spellIconUrl,
  spellName,
  treeIconUrl,
  treeName,
  resolveRuneDisplay,
  shardIconUrl,
  shardName,
} from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { IconWithFallback } from "@/components/IconWithFallback";
import { buildFeaturedView, classifyFeaturedItem } from "@/lib/otp/featuredBuild";
import type { FeaturedGame } from "@/lib/otp/featured";
import { resolveBuildSlots, type BuildSlot } from "@/lib/buildSlots";
import BuildSlotList from "./BuildSlotList";
import { isContested } from "./buildSlotView";
import HeroBand, { Pill } from "./HeroBand";
import KpiStrip, { type KpiItem } from "./KpiStrip";
import PanelHeading from "./PanelHeading";
import { sortPerkIdsByRow } from "./perkSlots";
import { opggProfileUrl } from "./opggProfile";
import { AddProItemBuildButton, ApplyProRunesButton, type OtpRunePageForApply } from "./ProConsensusCard";
import SkillOrderGrid from "./SkillOrderGrid";
import type { SkillOrderModel } from "./skillOrder";
import type { ProConsensusItemsInput } from "./itemSetBody";
import type { LaneId } from "./heroContracts";

interface FeaturedPlayer {
  gameName: string;
  tagLine: string;
  server: string | null;
  tier: string | null;
  lp: number | null;
  championSharePct: number | null;
  sourceGames: number | null;
  winratePct: number | null;
  kda: number | null;
}

interface FeaturedResponse {
  player: FeaturedPlayer | null;
  sample: { games: number; wins: number } | null;
  items: { itemId: number; games: number; pct: number }[];
  /** Per-game records, newest first — what `buildFeaturedView` needs to show a
   *  build somebody actually played rather than a synthesis. Optional on
   *  purpose: an older cached/SW body predating the field must degrade, not
   *  throw. See `gameLog` below the fetch for exactly how it degrades. */
  gameLog?: FeaturedGame[];
  /** PRE-2026-07-29 shape, kept readable so an offline SW hit from before the
   *  rename still renders its item slots. Inventories only, no outcomes, so a
   *  build derived from it can never claim a win — see the mapping below. */
  gameItems?: number[][];
  runes: { page: OtpRunePageForApply; games: number; pct: number } | null;
  spells: { spells: number[]; games: number; pct: number } | null;
  skillOrder?: SkillOrderModel | null;
}

function isSkillOrderModel(value: unknown): value is SkillOrderModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return (
    Array.isArray(model.priority) &&
    model.levels !== null &&
    typeof model.levels === "object" &&
    Array.isArray(model.order) &&
    typeof model.completed === "boolean" &&
    typeof model.sampleSize === "number"
  );
}

// ── DESKTOP COMPOSITION (2026-07-29) ─────────────────────────────────────────
//
// Until now this card was the full-width `'otp otp'` row at the BOTTOM of a
// page that showed everything at once, so its body never had to fill a wide
// viewport on its own — a reader arrived here having already scrolled past the
// WPA build and the pro consensus. Build/Pro/OTP are tabs at every width now,
// so this card IS the whole screen when its tab is open, and a single 1340px
// column of stacked sections is what that would have been: slot rows stretched
// to twice the width their content needs, with the name at one end and the
// percentage at the other.
//
// ── AND THE COMPOSITION IT SETTLED ON, AFTER ONE REVERSAL ───────────────────
//
// It is 5fr/7fr with RUNES on the left — the same shape the BUILD tab
// (`'runes_itembuild'`, 5fr/7fr) and the PRO tab (ProConsensusCard's internal
// 5fr/7fr) already use. Every tab on this page now reads runes first, then the
// build, at every width.
//
// This file previously argued the opposite and shipped 7fr/5fr build-left. That
// argument is preserved here because it was not wrong about the trade-offs, only
// about which one the user wanted: this card is a PROFILE of a named person, its
// headline is the build they actually played, and putting runes first costs
// something real —
//
//   * on mobile the stack becomes hero -> KPIs -> runes -> ... -> their build,
//     so the lede is no longer the first thing under the KPI strip;
//   * it is a genuine DOM reorder, not a grid-area shuffle. That was the OTHER
//     option and it is still rejected: placing with grid-template-areas would
//     put visual order (runes, build) at odds with reading and FOCUS order
//     (build, runes), so a keyboard user would tab from the right column back to
//     the left. Consistency is not worth an inverted tab order.
//
// User directive 2026-07-29 chose consistency: three tabs the reader flicks
// between during a 30-second champ select should not each put a different thing
// under the cursor. So the columns were swapped IN SOURCE ORDER — DOM order,
// visual order and focus order all still agree, which is the property the
// rejected option would have broken.
//
// `items-start` matters — without it the two columns stretch to equal height and
// the shorter one's sections space out to fill, which is the sprawl this split
// exists to remove, reintroduced one level down.
const OTP_BODY_GRID_CLASS = "lg:grid lg:grid-cols-[5fr_7fr] lg:gap-x-8 lg:items-start";

/** Items below this build rate are noise on a 30-60 game sample: one or two
 *  games, usually a situational pickup or a game that ended early. Showing them
 *  at the same visual weight as a 70% core item is what made the old card feel
 *  padded. */
const MIN_DISPLAY_PCT = 15;

/**
 * Games we must hold before quoting build PERCENTAGES for a player.
 *
 * The 150-game floor in lib/otp/onetricks.ts is about the account's CAREER on
 * the champion — it is what makes them a one-trick worth featuring. This is a
 * different guard: how many of their games we have actually stored. The two
 * come apart, and did on Lee Sin (2026-07-29) — a Grandmaster with a long
 * career whose last 40 ranked games were mostly other champions, leaving us
 * SEVEN. "71%" over seven games is five of them, and printing it next to a
 * progress bar invites reading it as a settled preference.
 *
 * So below this we still show WHO the player is — that part is solid — and say
 * plainly that we are still collecting their games. The ingest fills it in.
 */
const MIN_SAMPLE_GAMES = 12;

/**
 * ITEM CLASSIFICATION IS NOT DONE HERE ANY MORE (2026-07-29).
 *
 * This file used to carry its own `isCompleted`, which was the third copy of
 * one question — proConsensus.ts has `isBuildItem`, itemSetBody.ts has
 * `isFullItem` — and three rules for one question is how Doran's Bow shipped
 * inside completed build lines twice. `lib/otp/featuredBuild.ts` now owns it
 * outright: `buildFeaturedView` returns this card's four slots (items, boots,
 * starters, fullBuild) already partitioned, from ONE classifier, so they cannot
 * disagree with each other. Mejai's exclusion, the starter partition and the
 * boots split all live there. Do not reintroduce a local item rule here.
 */

/* The local `Bar` lived here until the rates list became a slot list. It drew
 * ONE item's build rate on its own full track, which is the visual that made two
 * competing items read as two independent things each mostly-full. Its
 * replacement (BuildSlotList's `SlotBar`) draws one track per SLOT and divides
 * it between the options, so the picture says "one decision, split". Do not
 * reintroduce a per-item bar into a slot row. */

/** The "leaves this app" mark on the profile link. Aria-hidden — the anchor's
 *  own accessible name already says it opens a new tab, and a second
 *  announcement of the same fact is noise. */
function ExternalMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="inline-block align-[0.06em] ml-1 flex-shrink-0 opacity-70 transition-opacity motion-reduce:transition-none group-hover:opacity-100"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/**
 * The featured player's Riot ID, linked out to their OP.GG match history when
 * — and only when — we can build that URL honestly.
 *
 * `href === null` renders the exact plain-text markup this card shipped before
 * the link existed. That branch is not a fallback to be tidied away later: the
 * region slug comes from a scraped platform id (see opggProfile.ts), and a
 * guessed slug is a live link to a STRANGER'S profile page. No link beats a
 * wrong one about a named person.
 *
 * TOUCH TARGET. The anchor is a pure INLINE element, so its vertical padding
 * extends the hit area without changing the h3's line box — the hero band's
 * measured height is identical with and without the link. `py-2.5` puts the hit
 * box at ~46px against the 23px heading, clearing the card's own 44px
 * convention (HextechTabs, ApplyRunesButton) without an inline-block box that
 * would have needed a negative margin to undo.
 *
 * `relative z-10` is load-bearing, not decoration. MEASURED at 390px: the
 * padded hit box is 44px tall, but its bottom ~10px sits under the hero's pill
 * row, which is a LATER sibling and therefore won hit-testing —
 * `elementFromPoint` at the anchor's own bottom edge returned the pill
 * container, so the bottom quarter of a 44px target was dead. Raising the
 * anchor gives the whole box back. Safe because it overlays only
 * non-interactive pills and paints no background: nothing changes visually and
 * no click is taken from anything clickable.
 */
function PlayerIdentity({
  gameName,
  tagLine,
  href,
}: {
  gameName: string;
  tagLine: string;
  href: string | null;
}) {
  const id = (
    <>
      {gameName}
      <span className="text-mut font-normal">#{tagLine}</span>
    </>
  );

  if (href === null) return id;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Says whose profile, where it goes, and that it leaves the app — the
      // three things the icon alone cannot say to a screen reader.
      aria-label={`${gameName} #${tagLine} — open their match history on OP.GG (opens in a new tab)`}
      title={`${gameName}#${tagLine} on OP.GG`}
      className="group relative z-10 py-2.5 -mx-1 px-1 rounded-md decoration-teal/50 decoration-1 underline-offset-[6px] hover:underline hover:text-teal-hover transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
    >
      {id}
      <ExternalMark />
    </a>
  );
}

/** Tag for the starter row. HARD RULE 2's partition made visible: a starting
 *  item sits in a labelled slot, never inside the completed-item list. */
function SlotTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center h-[18px] px-1.5 rounded-md border border-line bg-white/[0.04] text-[9px] font-bold uppercase tracking-[0.07em] text-mut flex-shrink-0">
      {children}
    </span>
  );
}

/** One slot of the full build. Not a button: this card has no detail-popover
 *  plumbing (BuildTabContent passes `onOpenDetail` to ProConsensusCard, not to
 *  this one), and a tile that looks tappable and does nothing is worse than a
 *  tile that doesn't. The icon is therefore the only carrier of the item's
 *  identity, so it gets a REAL alt — not `alt=""` — unlike the rates list
 *  below, where the name is written out beside the icon and a duplicate alt
 *  would just make a screen reader say it twice.
 *
 *  `snowball` marks a stack item (Mejai's) that is in the strip because the
 *  player HELD it, not because this app suggests it. The tile goes dashed and
 *  muted, and both the tooltip and the alt say so — an alt of just "Mejai's
 *  Soulstealer" would read to a screen reader exactly like the five real build
 *  items beside it, which is the one thing this marker exists to prevent. It is
 *  one of three carriers; the other two (ordered last, named in the caption)
 *  live in lib/otp/featuredBuild.ts's `order` and in the caption below. */
function BuildSlot({ name, icon, snowball = false }: { name: string; icon: string; snowball?: boolean }) {
  const label = snowball ? `${name} — a snowball stack they held, not a recommendation` : name;
  return (
    <span
      title={label}
      className={`w-11 h-11 rounded-lg bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${
        snowball ? "border border-dashed border-mut/50 opacity-70" : "border border-line"
      }`}
    >
      <IconWithFallback src={icon} alt={label} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
    </span>
  );
}

/** A rune tile in the full page — icon above its name, the vocabulary
 *  RunesSummonersCard and ProConsensusCard both already use. Non-interactive
 *  for the same reason BuildSlot is. */
function RuneTile({ name, icon, keystone = false }: { name: string; icon: string; keystone?: boolean }) {
  const box = keystone ? "w-12 h-12 border-2 border-line-gold" : "w-9 h-9 border border-line";
  return (
    <span className="flex flex-col items-center text-center w-[58px] gap-1">
      <span className={`${box} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0`}>
        <IconWithFallback
          src={icon}
          alt={name}
          fallbackGlyph={name}
          className="w-full h-full object-contain"
          size={keystone ? 48 : 36}
        />
      </span>
      <span className="text-[9.5px] text-mut leading-tight line-clamp-2 min-h-[22px]">{name}</span>
    </span>
  );
}

/** Tree name + icon, matching RunesSummonersCard's own TreeLabel. */
function TreeLabel({ treeId }: { treeId: number }) {
  const name = treeName(treeId);
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="w-5 h-5 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={treeIconUrl(treeId)}
          alt={name}
          fallbackGlyph={name}
          className="w-full h-full object-contain"
          size={20}
        />
      </span>
      <span className="text-[11.5px] text-txt font-semibold">{name}</span>
    </div>
  );
}

/** Stat-shard row labels, by position. `runes.page.shards` is positional —
 *  `[offense, flex, defense]`, straight from Riot's `perks.statPerks` via
 *  lib/pro/extract.ts — so the label comes from the INDEX and is a fact about
 *  the payload, not a guess about the id. */
const SHARD_ROW_LABELS = ["Offense", "Flex", "Defense"] as const;

/* Rune display order is the TREE ROW here too, via the same shared resolver
 * ProConsensusCard uses (`perkSlots.ts`, a pure static lookup with no fetch).
 *
 * Riot already returns a soloq page's primary selections in row order
 * (lib/pro/extract.ts splits `selections` into keystone + the rest), so on this
 * card it is usually a no-op — it is applied anyway so the order is GUARANTEED
 * by the render rather than inherited from an upstream detail that could change
 * without this card noticing. */

export default function FeaturedOtpCard({
  champ,
  ver,
  lane,
  build,
}: {
  champ: ChampionRef;
  ver: string;
  lane: LaneId;
  build: BuildResponse;
}) {
  const [data, setData] = useState<FeaturedResponse | null>(null);
  const [meta, setMeta] = useState<ReadonlyMap<number, ItemDetail>>(new Map());
  /** Every rune id on the page (keystone + minors + secondary picks) -> art.
   *  Was a single keystone before the full page was rendered. */
  const [runeArt, setRuneArt] = useState<ReadonlyMap<number, { name: string; icon: string }>>(new Map());
  const [skillPriority, setSkillPriority] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `cancelled` closure, not an AbortController: the same stale-response guard
    // ProConsensusCard uses. Switching champion fast otherwise lets an older
    // response land last and paint the wrong player's build.
    let cancelled = false;
    setLoading(true);
    setRuneArt(new Map());
    setSkillPriority(null);
    // Champion-level, from the same op.gg feed the skill-order card uses. Its
    // failure costs one line, so it is fetched separately and never blocks.
    fetch(`/api/skill-order?champ=${champ.id}&role=2`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && Array.isArray(j?.priority) && j.priority.length) setSkillPriority(j.priority);
      })
      .catch(() => {});
    Promise.all([
      fetch(`/api/otp/featured?championId=${champ.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      getItemDetailMap(ver).catch(() => new Map<number, ItemDetail>()),
    ]).then(async ([res, m]) => {
      if (cancelled) return;
      const body = res as FeaturedResponse | null;
      setData(body);
      setMeta(m);
      setLoading(false);
      // Rune art resolves separately and is DECORATIVE — a failure here costs
      // icons and names, never the card, and never the page STRUCTURE: the tree
      // labels, the rows and their order all come from perkSlots.ts and the
      // stored page, none of which involve a fetch. An unresolved id falls back
      // to "Rune #<id>" and IconWithFallback's glyph tile, so a failure is
      // visible rather than a silent gap. Same posture proAssets already takes.
      const page = body?.runes?.page;
      if (!page) return;
      const ids = [page.keystone, ...(page.primary ?? []), ...(page.secondary ?? [])].filter(
        (x): x is number => typeof x === "number" && x > 0
      );
      if (ids.length === 0) return;
      const resolved = await Promise.all(
        ids.map((id) => resolveRuneDisplay(id, ver).catch(() => null))
      );
      if (cancelled) return;
      const next = new Map<number, { name: string; icon: string }>();
      resolved.forEach((d) => {
        if (d) next.set(d.id, { name: d.name, icon: d.icon });
      });
      setRuneArt(next);
    });
    return () => {
      cancelled = true;
    };
  }, [champ.id, ver]);

  if (loading) {
    // Rendered at the FINAL dimensions of the real card's first two bands
    // (hero min-h-[92px]/sm:104, strip ~86px) so the swap to real content
    // costs no layout shift.
    return (
      <div className="bg-panel border border-line rounded-xl overflow-hidden animate-pulse">
        <div className="min-h-[92px] sm:min-h-[104px] flex items-center gap-3.5 sm:gap-4 px-4 sm:px-5 py-4 sm:py-5">
          <div className="w-[52px] h-[52px] sm:w-[62px] sm:h-[62px] rounded-xl bg-panel2 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-2 w-20 bg-panel2 rounded" />
            <div className="h-4 w-40 max-w-full bg-panel2 rounded" />
            <div className="h-[20px] w-28 bg-panel2 rounded-full" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-px bg-line border-y border-line">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-panel2/70 px-2.5 sm:px-4 py-3 sm:py-3.5">
              <div className="h-[21px] sm:h-[26px] w-12 bg-panel2 rounded" />
              <div className="mt-1.5 h-2 w-16 max-w-full bg-panel2 rounded" />
              <div className="mt-1 h-2 w-10 bg-panel2 rounded" />
            </div>
          ))}
        </div>
        <div className="p-4 sm:p-5 space-y-3">
          <div className="h-2.5 w-32 bg-panel2 rounded" />
          <div className="h-10 w-full bg-panel2 rounded" />
          <div className="h-10 w-full bg-panel2 rounded" />
        </div>
      </div>
    );
  }

  const player = data?.player ?? null;
  const sample = data?.sample ?? null;

  if (!player || !sample || sample.games === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-5">
        <PanelHeading rule={false}>One-trick</PanelHeading>
        <p className="mt-3 text-[13px] text-mut leading-relaxed">
          No one-trick tracked for {champ.name} yet. We only feature an account with{" "}
          <span className="text-txt">150+ games</span> on the champion, so this fills in as the
          ingest works through the roster.
        </p>
      </div>
    );
  }

  // ONE reading of the per-game data, used by everything below it.
  //
  // The legacy branch maps the old inventories-only field to `win: null`, NOT
  // to `win: false`. That distinction is the whole reason `win` is nullable: a
  // defaulted `false` would let the caption say "a game they lost" about a game
  // we simply have no outcome for, which is an invented fact rather than a
  // missing one. With `null` the caption drops the outcome clause instead.
  const gameLog: FeaturedGame[] =
    data!.gameLog ?? (data!.gameItems ?? []).map((items) => ({ items, win: null }));

  // ONE call, four slots, one classifier — see lib/otp/featuredBuild.ts. The
  // item metadata map lives on the client (the route deliberately ships raw
  // ids), so this is where the two halves meet.
  //
  // `minSampleGames` is passed as well as branched on below: the thin-sample
  // rule is a property of the MODEL now, so a future edit that reshuffles the
  // JSX cannot leak a percentage over five games.
  const view = buildFeaturedView(data!.items, gameLog, sample.games, meta, {
    minDisplayPct: MIN_DISPLAY_PCT,
    minSampleGames: MIN_SAMPLE_GAMES,
  });
  const measuredSkillOrder = isSkillOrderModel(data!.skillOrder) ? data!.skillOrder : null;
  const otpItems: ProConsensusItemsInput = {
    items: view.items.map(({ itemId, pct }) => ({ itemId, share: pct / 100 })),
    boots: view.boots.map(({ itemId, pct }) => ({ itemId, share: pct / 100 })),
  };
  const fullBuild = view.fullBuild;
  // The played build is a RECORD of one game, so a snowball stack they really
  // held stays in it — while `view.items`/`view.slots` below still exclude it,
  // because those are a recommendation. Two surfaces, two jobs; the split is
  // argued in lib/snowballStacks.ts and lib/otp/featuredBuild.ts, and the user
  // decided it on 2026-07-29 after the alternative was measured: excluding it
  // costs the featured Ahri one-trick its only repeating full build.
  //
  // At most one can be present — Mejai's is the only snowball stack that
  // reaches a build slot (Dark Seal classifies `starter` first) — so a single
  // slot is the right shape here, not a list.
  const snowballSlot = fullBuild?.items.find((s) => s.isSnowball) ?? null;
  // Their most-common opener, on its own line rather than mixed into the build.
  // Genuinely useful on a one-trick card — Dun opens Doran's Ring in 4 games out
  // of 10 and Dark Seal in nearly 6, which is a real read on how he plays the
  // lane — but it is not a build slot and must not look like one.
  const starter = view.starters[0];

  // ── The item spread, as SLOTS rather than as a list ────────────────────────
  // A flat rates list showed Malignance 71% and Blackfire Torch 23% as two rows,
  // which reads as "build both". Measured on this very card's data (Ahri, 111
  // stored games) those two co-occur in ZERO games — they compete for one slot.
  // `resolveBuildSlots` decides that from the per-game inventories by LIFT, not
  // by a raw co-occurrence count; see lib/buildSlots.ts's header for the
  // measurement and the threshold it fixes.
  //
  // The include predicate is `classifyFeaturedItem`, the SAME classifier
  // `buildFeaturedView` uses above — deliberately not a second rule. Three rules
  // for one question is how Doran's Bow shipped inside completed build lines
  // (featuredBuild.ts's header), and a slot list disagreeing with the build
  // strip directly above it about what an item IS would be that bug again.
  //
  // DEGRADED INPUT, ONE RENDER PATH: the per-game data is optional on the
  // response, so an empty body has no co-occurrence evidence at all. That case
  // falls back to one settled slot per item — which is not a placeholder but
  // the honest reading: with no evidence of competition, no competition is
  // claimed, and a settled slot claims exactly nothing. The alternative
  // (keeping the old flat list as a second branch) would be two renderings of
  // one section, free to drift apart.
  const itemSlots: BuildSlot[] =
    gameLog.length > 0
      ? resolveBuildSlots(
          gameLog.map((g) => g.items),
          sample.games,
          {
            // `meta` passed as the THIRD arg, not just the per-item lookup: with
            // a catalog `classifyFeaturedItem` resolves boots by recipe
            // ancestry, and without one it falls back to the tag plus a pinned
            // exception list. Item 3172 Gunmetal Greaves is a tier-3 boot whose
            // live catalog record carries no `Boots` tag, so on the weaker rule
            // it reads as a completed item and lands in a build slot — measured
            // live on Yone mid at 178 of 200 games. This was the one call site
            // still on that weaker path.
            include: (id) => classifyFeaturedItem(id, meta.get(id), meta) === "completed",
            minPct: MIN_DISPLAY_PCT,
          }
        )
      : view.items.map((it) => ({
          primary: { itemId: it.itemId, games: it.games, pct: it.pct },
          alternatives: [],
          sampleGames: sample.games,
        }));
  // Boots are ONE slot by the rules of the game — a player wears one pair — so
  // this needs no co-occurrence evidence and does not go through
  // `resolveBuildSlots`. `view.boots` is already ranked most-built first over
  // the same stored-game denominator, which is exactly a go-to plus its
  // alternatives.
  const bootsSlot: BuildSlot | null =
    view.boots.length > 0
      ? {
          primary: { itemId: view.boots[0].itemId, games: view.boots[0].games, pct: view.boots[0].pct },
          alternatives: view.boots.slice(1).map((b) => ({ itemId: b.itemId, games: b.games, pct: b.pct })),
          sampleGames: sample.games,
        }
      : null;
  // Every slot the card can render, not just the item ones — the boots slot can
  // be the only contested thing on a settled build (Heimerdinger, measured).
  const hasContestedSlot = itemSlots.some(isContested) || (bootsSlot ? isContested(bootsSlot) : false);

  const winPct = Math.round((sample.wins / sample.games) * 100);
  // Below the floor we show WHO, never percentages — see MIN_SAMPLE_GAMES.
  const thinSample = sample.games < MIN_SAMPLE_GAMES;
  const runes = data!.runes;
  const runePage = runes?.page ?? null;
  const itemName = (id: number) => meta.get(id)?.name ?? `Item ${id}`;
  const runeOf = (id: number) => runeArt.get(id) ?? { name: `Rune #${id}`, icon: "" };

  // CAREER numbers, from the source's own account totals — a different, LARGER
  // denominator than `sample.games` below. The labels say "career" for exactly
  // that reason; see this file's header. A cell is omitted, never zeroed, when
  // the source didn't give us the field.
  const kpis: KpiItem[] = [];
  if (player.sourceGames != null) {
    kpis.push({
      key: "career-games",
      label: "Career games",
      value: player.sourceGames,
      format: (n) => Math.round(n).toLocaleString("en-US"),
      countUp: true,
    });
  }
  if (player.winratePct != null) {
    kpis.push({
      key: "career-wr",
      label: "Career win rate",
      value: player.winratePct,
      format: (n) => `${Math.round(n)}%`,
      valueClassName: player.winratePct >= 50 ? "text-good" : "text-bad",
      countUp: true,
    });
  }
  if (player.championSharePct != null) {
    kpis.push({
      // The old label was the champion's own NAME ("AHRI 60%"), which never
      // said what the number measured. It is the share of this account's games
      // played on this champion, so the label now says that outright.
      key: "champ-share",
      label: `${champ.name}, of their games`,
      value: player.championSharePct,
      format: (n) => `${Math.round(n)}%`,
      countUp: true,
    });
  }

  const sampleMeta = `${sample.games} stored games · ${winPct}% won`;

  return (
    <div className="bg-panel border border-line rounded-xl overflow-hidden">
      <HeroBand
        flush
        headingLevel={3}
        splashKey={champ.key}
        avatarSrc={champ.icon}
        avatarAlt={champ.name}
        eyebrow="Best one-trick"
        title={
          <PlayerIdentity
            gameName={player.gameName}
            tagLine={player.tagLine}
            href={opggProfileUrl(player.server, player.gameName, player.tagLine)}
          />
        }
        pills={
          <>
            {player.tier && <Pill tone="accent">{player.tier}</Pill>}
            {player.lp != null && <Pill>{player.lp} LP</Pill>}
            {player.server && <Pill>{player.server}</Pill>}
          </>
        }
      />

      {kpis.length > 0 && <KpiStrip flush columns={3} items={kpis} />}

      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3 mb-3.5">
          <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">OTP setup</p>
          <div className="flex items-start gap-2.5">
            <ApplyProRunesButton
              champ={champ}
              roleLabel={build.roleLabel}
              fallbackShards={build.runes.shards}
              runePage={runePage}
              variant="otp"
            />
            <AddProItemBuildButton
              champ={champ}
              lane={lane}
              roleLabel={build.roleLabel}
              build={build}
              otpItems={otpItems}
              variant="otp"
            />
          </div>
        </div>
        {thinSample ? (
          <p className="text-[12px] text-mut leading-relaxed">
            Still collecting their games — we hold{" "}
            <span className="text-txt tabular-nums">{sample.games}</span> of the{" "}
            <span className="text-txt tabular-nums">{MIN_SAMPLE_GAMES}</span> needed before build
            percentages mean anything. Their card fills in as the ingest catches up.
          </p>
        ) : (
          <div className={OTP_BODY_GRID_CLASS}>
            {/* ── HOW THEY SET UP — runes, summoners, skill order ─────────────
                LEADS in source order as of 2026-07-29, matching the BUILD and
                PRO tabs (see OTP_BODY_GRID_CLASS for the reversal and what it
                costs). Below `lg` this wrapper is a plain block and its sections
                open the single stack; at `lg`+ it is the narrower LEFT track.

                NOT byte-identical on mobile any more — this comment used to say
                it was, and the swap is exactly what made that false. The mobile
                stack is now hero -> KPIs -> runes -> summoners -> skill order ->
                their build. Nothing inside these sections changed; their
                POSITION did.

                `lg:[&>*:first-child]:mt-0` cancels the top margin of whichever
                section happens to lead. Written as a first-child rule rather
                than put on the Runes section directly because ALL THREE are
                conditional — a champion whose featured player has no stored
                rune page leads with Summoners, and hardcoding the reset onto
                Runes would leave this column starting 20px lower than the
                build column beside it. */}
            <div className="min-w-0 lg:[&>*:first-child]:mt-0">
            {/* The FULL rune page, not a keystone and three shard icons (user
                report 2026-07-29). Every part of it is already stored per game
                and already modelled — `runes.page` carries primaryTree,
                keystone, the three primary minors, secondaryTree, the two
                secondary picks and the three positional shards. The layout is
                RunesSummonersCard's: primary column, secondary column,
                shards under the secondary tree they sit beside in client. */}
            {runePage && (
              <section className="mt-5">
                <PanelHeading meta={`${runes!.pct}% of ${sample.games} games`}>Runes</PanelHeading>
                {/* `grid-cols-2` at mobile packs the two trees side by side,
                    the same thing RunesSummonersCard does at 390px. At `sm`+
                    the tracks become CONTENT-SIZED and left-packed: two equal
                    `fr` tracks in a wide card pushed the secondary tree's 2
                    tiles out to x=840 with ~450px of dead space in between
                    (measured at 1440x900), which `auto` + justify-start fixes
                    by letting the row end where the content ends.

                    `lg:grid-cols-1 xl:grid-cols-[auto_auto]` is new with the
                    desktop tabs (2026-07-29) and is about the RAIL this section
                    now lives in, not about the viewport. Measured on Ahri at
                    1024x900: the rail is 273px there, which leaves the secondary
                    tree a 102px track — narrow enough that the three stat shards
                    wrapped to one per row, a 3-high vertical column where every
                    other surface in the app draws them as a row. Stacking the
                    two trees instead gives each the rail's full 273px: the
                    primary row fits its keystone + 3 minors, and the shards fit
                    on one line. From `xl` the rail is ~493px and the side-by-side
                    pair fits again, so it comes back. */}
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-[auto_auto] sm:justify-start sm:gap-x-12 lg:grid-cols-1 lg:gap-x-0 xl:grid-cols-[auto_auto] xl:gap-x-10">
                  <div>
                    {runePage.primaryTree != null ? (
                      <TreeLabel treeId={runePage.primaryTree} />
                    ) : (
                      <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">
                        Primary
                      </p>
                    )}
                    <div className="flex flex-wrap items-start gap-1.5">
                      {runePage.keystone != null && runePage.keystone > 0 && (
                        <RuneTile keystone {...runeOf(runePage.keystone)} />
                      )}
                      {sortPerkIdsByRow(runePage.primaryTree, runePage.primary ?? []).map((id) => (
                        <RuneTile key={id} {...runeOf(id)} />
                      ))}
                    </div>
                  </div>

                  <div>
                    {runePage.secondaryTree != null ? (
                      <TreeLabel treeId={runePage.secondaryTree} />
                    ) : (
                      <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">
                        Secondary
                      </p>
                    )}
                    <div className="flex flex-wrap items-start gap-1.5">
                      {sortPerkIdsByRow(runePage.secondaryTree, runePage.secondary ?? []).map((id) => (
                        <RuneTile key={id} {...runeOf(id)} />
                      ))}
                    </div>

                    {runePage.shards.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-line/60">
                        <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">
                          Shards
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {runePage.shards.map((s, i) => (
                            <span key={`${s}-${i}`} className="flex flex-col items-center text-center w-[52px] gap-1">
                              <span className="w-7 h-7 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                                <IconWithFallback
                                  src={shardIconUrl(s)}
                                  alt={shardName(s)}
                                  fallbackGlyph={shardName(s)}
                                  className="w-full h-full object-contain p-0.5"
                                  size={28}
                                />
                              </span>
                              <span className="text-[9px] text-mut leading-tight">
                                {SHARD_ROW_LABELS[i] ?? shardName(s)}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {data!.spells && (
              <section className="mt-5">
                <PanelHeading rule={false} meta={`${data!.spells.pct}% of ${sample.games} games`}>
                  Summoners
                </PanelHeading>
                <div className="mt-2 flex items-center gap-2">
                  {data!.spells.spells.map((s) => (
                    <span
                      key={s}
                      title={spellName(s)}
                      className="w-[26px] h-[26px] rounded-md border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
                    >
                      <IconWithFallback
                        src={spellIconUrl(s, ver)}
                        alt={spellName(s)}
                        fallbackGlyph={spellName(s)}
                        className="w-full h-full object-contain"
                        size={26}
                      />
                    </span>
                  ))}
                </div>
              </section>
            )}

            {measuredSkillOrder ? (
              <section className="mt-5">
                <PanelHeading rule={false}>Skill order</PanelHeading>
                <SkillOrderGrid
                  model={measuredSkillOrder}
                  sampleLabel={`${measuredSkillOrder.sampleSize} of ${sample.games} games`}
                  missingLevelsContext="recorded sample"
                />
              </section>
            ) : skillPriority ? (
              <div className="mt-5">
                <PanelHeading rule={false}>Skill order</PanelHeading>
                <div className="mt-2 flex items-center gap-1.5">
                  {skillPriority.map((s, i) => (
                    <span key={`${s}-${i}`} className="flex items-center gap-1.5">
                      <span
                        title={`Level ${i + 1}: ${s}`}
                        className="w-6 h-6 rounded-md bg-panel2 border border-line grid place-items-center text-[11px] font-semibold text-txt"
                      >
                        {s}
                      </span>
                      {i < skillPriority.length - 1 && <span className="text-mut text-[11px]">›</span>}
                    </span>
                  ))}
                </div>
                <p className="mt-1.5 text-[10.5px] text-mut/70 leading-relaxed">
                  The champion&apos;s common order, not {player.gameName}&apos;s own — skill order is not recorded
                  for this one-trick yet.
                </p>
              </div>
            ) : null}
            </div>

            {/* ── WHAT THEY BUILD ─────────────────────────────────────────────
                The wider (7fr) RIGHT track at `lg`+, and the tail of the stack
                on mobile. Still the headline content of this card — it just no
                longer leads, by user directive; see OTP_BODY_GRID_CLASS. */}
            <div className="min-w-0">
            {/* Gated on EITHER, not on `fullBuild` alone. The opener is a fact
                about how they play the lane and does not depend on any game
                having reached a finished build — before this, a player whose
                games all ended early lost their "Opens Dark Seal 70%" row as
                collateral. */}
            {(fullBuild || starter) && (
              <section>
                <PanelHeading meta={sampleMeta}>Their build</PanelHeading>

                {starter && (
                  <div className="flex items-center gap-2.5 pt-3 pb-3 border-b border-line/60">
                    <SlotTag>Opens</SlotTag>
                    <span className="w-6 h-6 rounded border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                      <IconWithFallback
                        src={itemIconUrl(starter.itemId, ver)}
                        alt={itemName(starter.itemId)}
                        fallbackGlyph={itemName(starter.itemId)}
                        className="w-full h-full object-contain"
                        size={24}
                      />
                    </span>
                    <span className="text-[12px] text-txt truncate">{itemName(starter.itemId)}</span>
                    {/* The fraction, not just the percentage. `sampleMeta` on
                        the heading three lines up already states the sample, and
                        that satisfied the section-level convention — but this
                        was the ONE percentage on the card still travelling
                        without its own denominator beside it, while every slot
                        row below it prints "26/37". Same rule, same row, no
                        exception to notice. The slash is aria-hidden and the
                        words supplied, exactly as BuildSlotList's `Fraction`
                        does, so a screen reader hears a sentence and not a
                        division. */}
                    <span className="ml-auto flex items-baseline gap-1.5 flex-shrink-0">
                      <span className="text-[12px] font-semibold text-txt tabular-nums">
                        {starter.pct}%
                      </span>
                      <span aria-hidden="true" className="text-[9.5px] text-mut tabular-nums">
                        {starter.games}/{sample.games}
                      </span>
                      <span className="sr-only">{` in ${starter.games} of ${sample.games} games`}</span>
                    </span>
                  </div>
                )}

                {fullBuild && (
                  <>
                    {/* Up to six 44px tiles + five 8px gaps = 304px, inside a
                        390px viewport's 358px content box — one row, no wrap,
                        no horizontal scroll strip (this tab has none anywhere).
                        FEWER than six is the normal case and is correct, not a
                        gap to pad: the measured maximum this player ever
                        FINISHES is four legendaries plus boots, and a strip of
                        five real items beats six with a component in it.
                        `flex-wrap` stays on so a longer set degrades to a
                        second row instead of overflowing.

                        No per-slot percentage, deliberately. Every entry in
                        `fullBuild.items` carries its OWN overall build rate,
                        and printing those beside a set quoted against a
                        different count ("3 of 37 games ended with exactly
                        these") puts two denominators on one row — the precise
                        shape of the v0.73.1 bug. The rates get their own
                        section below, under one stated denominator.

                        UNNUMBERED, and that is a constraint rather than a
                        style: timelines may be fetched for skill order, but
                        purchase order is not stored. Left-to-right here is
                        build rate. Do not add a step number, an arrow, or a
                        "first/then" affordance. */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {fullBuild.items.map((slot) => (
                        <BuildSlot
                          key={slot.itemId}
                          name={itemName(slot.itemId)}
                          icon={itemIconUrl(slot.itemId, ver)}
                          snowball={slot.isSnowball}
                        />
                      ))}
                    </div>

                    {/* THE CAPTION MUST MATCH THE METHOD — see this file's
                        header and featuredBuild.ts's. Both branches describe
                        games this player really played, both quote the same
                        denominator (`sampleGames`, the games we hold), and the
                        word "finished" is doing real work in both: the strip is
                        their FINISHED items, and other slots in those games
                        held components or a Dark Seal.

                        The single-game branch may only claim an outcome when
                        `won` is a boolean. On `null` — a legacy body with no
                        outcome field — the clause is dropped rather than
                        guessed.

                        THREE tiers now, and each caption states the size of the
                        thing it is describing (2026-07-29). The middle tier is
                        a build that REPEATED but is a slot short, and its whole
                        risk is being read as a full one — so it prints its item
                        count and says plainly that no full build repeats yet.
                        `nonBootsItems` is on the union branch for exactly this;
                        do not drop it from the sentence.

                        The single-game caption now says "nothing repeats",
                        because reaching it means BOTH repeating tiers failed.
                        Its two earlier wordings were each true only until the
                        next bar was added: "no set repeats" died when the full
                        and showable bars diverged, and "no full build repeats"
                        died when the middle tier landed. Pin this sentence to
                        the condition in featuredBuild.ts's branch (b), not to
                        whatever the previous version said.

                        The snowball clause is CONDITIONAL and is the third of
                        three carriers (the tile is dashed, and it is ordered
                        last). It names the item rather than saying "a snowball
                        stack", because a reader looking at six icons needs to
                        know WHICH one is the record-only slot. */}
                    <p className="mt-2.5 text-[10.5px] text-mut/80 leading-relaxed">
                      {fullBuild.method === "most-played-exact" ? (
                        <>
                          A full build {player.gameName} actually played —{" "}
                          <span className="text-txt tabular-nums">{fullBuild.games}</span> of the{" "}
                          <span className="text-txt tabular-nums">{fullBuild.sampleGames}</span>{" "}
                          games we hold ended with exactly these finished items.
                        </>
                      ) : fullBuild.method === "most-played-partial" ? (
                        <>
                          A build {player.gameName} repeated —{" "}
                          <span className="text-txt tabular-nums">{fullBuild.games}</span> of the{" "}
                          <span className="text-txt tabular-nums">{fullBuild.sampleGames}</span>{" "}
                          games we hold ended with exactly these finished items. It is{" "}
                          <span className="text-txt tabular-nums">{fullBuild.nonBootsItems}</span>{" "}
                          items plus boots, not a full six — no full build repeats in what we hold
                          yet.
                        </>
                      ) : (
                        <>
                          One game{" "}
                          {fullBuild.won === true
                            ? "they won"
                            : fullBuild.won === false
                              ? "they lost"
                              : "of theirs"}{" "}
                          — the finished items {player.gameName} ended it holding. Nothing repeats
                          across the{" "}
                          <span className="text-txt tabular-nums">{fullBuild.sampleGames}</span>{" "}
                          games we hold, so this is one game, not a rate.
                        </>
                      )}
                      {snowballSlot && (
                        <>
                          {" "}
                          <span className="text-txt">{itemName(snowballSlot.itemId)}</span> is shown
                          because they held it — a snowball stack, not something we recommend
                          building. It is left out of the slots below.
                        </>
                      )}
                    </p>
                  </>
                )}
              </section>
            )}

            {/* WAS a two-line paragraph ("Indented items are built instead of
                the one above them, not alongside it — they compete for the same
                slot"), removed 2026-07-29 on the user's "remove the text
                description there. Not needed."

                What it protected is NOT removed. Losing the sighted reader's
                cue entirely would re-create the "looks like you buy both" bug
                the slot grouping exists to fix, so the relationship still has
                four carriers: this key, the literal word "or" on every
                alternative row, the nested list's accessible name ("Built
                instead of X in this slot"), and the single divided bar. A key
                is what a paragraph turns into when the paragraph is the problem.

                Placement is unchanged and was screenshot-caught at 390px on
                Heimerdinger: his item slots are all settled but his BOOTS slot
                is not, so gating on the item slots alone showed an indented
                "or Sorcerer's Shoes" with no explanation. Above the first
                section that can indent, gated on ALL the slots on the card. */}
            {hasContestedSlot && (
              <p className="mt-5 text-[10.5px] text-mut/80">
                <span className="text-txt font-semibold">or</span> = instead of, not as well
              </p>
            )}

            {bootsSlot && (
              <section className="mt-4">
                <PanelHeading meta={sampleMeta}>Boots</PanelHeading>
                {/* ONE slot, not a list — screenshot-caught at 390px. This
                    rendered "Crimson Lucidity 84%" and "Chainlaced Crushers
                    14%" as two equal rows, which is the same claim the item
                    list was making and is even less defensible here: a player
                    wears exactly one pair of boots, so these two ALWAYS compete,
                    by the rules of the game rather than by a measurement.
                    Rendering it as anything other than one slot would leave the
                    card contradicting itself two sections apart.
                    The user's "show the top three boots with percentages"
                    directive is intact — three options still render, with their
                    own percentages, and `bootsMinDisplayPct: 0` still keeps a
                    third boot at 8% from being filtered out. They are now shown
                    as what they are: one choice, three ways. */}
                <BuildSlotList slots={[bootsSlot]} ver={ver} nameOf={itemName} />
              </section>
            )}

            {itemSlots.length > 0 && (
              <section className="mt-5">
                {/* "Build rates" was the old name, when this was a flat list of
                    items with a percentage each. It is now a list of DECISIONS,
                    and the heading has to say so — a reader who still reads it
                    as a rates list will read two options in one row as two
                    items to buy, which is the exact bug this section exists to
                    end. Short on purpose: measured at 390px, a longer heading
                    pushes the denominator meta onto its own line and breaks the
                    shared baseline every other PanelHeading on this card keeps.
                    Boots are absent by design; they have their own slot. */}
                <PanelHeading meta={sampleMeta}>Item slots</PanelHeading>
                <BuildSlotList slots={itemSlots} ver={ver} nameOf={itemName} />
              </section>
            )}

            {itemSlots.length === 0 && !fullBuild && (
              <p className="text-[12px] text-mut">
                No item reaches {MIN_DISPLAY_PCT}% across the games we hold yet.
              </p>
            )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
