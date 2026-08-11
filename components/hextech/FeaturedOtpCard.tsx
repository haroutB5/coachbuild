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
//
// ── THE ONE EXCEPTION, AND WHY IT IS NOT THAT BUG (v0.105.2) ─────────────────
// The RUNE GRID now shows a per-slot fraction, and those denominators are NOT
// `sample.games`. That is deliberate and it is the opposite of the drift above.
//
// The rule guards against a number quoted over a SILENTLY NARROWED population —
// "3 of the 20 that qualified" flatters the 3 by hiding the filter. A rune slot
// is not a narrowed population, it is a DIFFERENT question. A game where the
// player ran Domination could never have run a Sorcery keystone; putting it in
// that keystone's denominator does not make the number more honest, it makes it
// wrong in the other direction — it charges a rune for games in which it was
// not on the ballot. `components/hextech/proConsensus.ts` has held the PRO side
// to per-slot denominators since v0.29.0 for exactly this reason, and the OTP
// side showing one page-level figure under every rune was the actual defect
// here: six identical numbers presented as six per-rune counts.
//
// What keeps this from reopening v0.73.1 is that the two figures are LABELLED
// where they appear, never mixed in one sentence: the Runes heading still reads
// "<pct>% of <sample.games> games" (the exact page, one denominator, unchanged),
// and both the grid note and the modal subtitle say in words that each fraction
// counts only the games that filled that slot. If you ever find yourself
// wanting to compare a slot fraction with the page fraction, that is the tell
// that a label has gone missing — restore the label, do not unify the maths.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import { itemIconUrl, spellIconUrl, spellName, resolveRuneDisplay } from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { IconWithFallback } from "@/components/IconWithFallback";
import { buildFeaturedView } from "@/lib/otp/featuredBuild";
import type { FeaturedGame, OtpRunePageSamples } from "@/lib/otp/featured";
import type { BuildSlot } from "@/lib/buildSlots";
import type { FeaturedBuildView, FeaturedFullBuild } from "@/lib/otp/featuredBuild";
import BuildSlotList from "./BuildSlotList";
import { isContested } from "./buildSlotView";
import PanelHeading from "./PanelHeading";
import { PERK_TREES } from "./perkSlots";
import { otpRunePage } from "./otpRunePage";
import { opggProfileUrl } from "./opggProfile";
import { AddProItemBuildButton, ApplyProRunesButton, type OtpRunePageForApply } from "./ProConsensusCard";
import type { SkillOrderModel } from "./skillOrder";
import type { ProConsensusItemsInput } from "./itemSetBody";
import { LANE_LABEL, type LaneId } from "./heroContracts";
import { featuredOtpRequestInputs } from "./featuredOtpRequest";
import {
  ACCENT_CARD_CLASS,
  BuildPathArrow,
  BuildSkillOrderGrid,
  CARD_CLASS,
  RunePageGrid,
  RunePageModal,
  SHARD_ROWS,
  type RunePageModalSpell,
  Scanline,
  SectionLabel,
  StatValue,
} from "./builds/BuildVisuals";

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
  /** `games`/`pct` count the EXACT page; `slots` counts each rune on its own.
   *  `slots` is OPTIONAL on purpose: an offline service-worker body cached
   *  before v0.105.2 has no such field, and the grid must then draw the runes
   *  with NO fractions rather than fall back to the page-level figure it used
   *  to repeat under every slot. */
  runes: { page: OtpRunePageForApply; games: number; pct: number; slots?: OtpRunePageSamples | null } | null;
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
const OTP_BODY_GRID_CLASS = "grid gap-4 lg:grid-cols-[minmax(0,1fr)_372px] lg:items-start";

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

function OtpBuildPath({
  items,
  ver,
  itemName,
}: {
  items: FeaturedFullBuild["items"];
  ver: string;
  itemName: (id: number) => string;
}) {
  return (
    <div className="mt-3 flex items-start gap-1 overflow-x-auto pb-1">
      {items.map((item, index) => {
        const demoted = item.pct < MIN_DISPLAY_PCT;
        const recordOnly = item.isSnowball;
        const name = itemName(item.itemId);
        const label = recordOnly ? `${name} — a snowball stack they held, not a recommendation` : name;
        return (
          <div key={`${item.itemId}-${index}`} className="flex min-w-[70px] shrink-0 items-start gap-1 lg:shrink">
            {index > 0 && <BuildPathArrow />}
            <div className="flex min-w-[62px] flex-col items-center text-center">
              <span title={label} className={`flex h-11 w-11 items-center justify-center overflow-hidden rounded-[8px] bg-black/20 ${recordOnly ? "border border-dashed border-[#9397ab]/50 opacity-70" : demoted ? "shadow-[inset_0_0_0_1px_rgba(233,233,237,0.1)] opacity-60" : "shadow-[inset_0_0_0_1px_rgba(145,132,217,0.45)]"}`}>
                <IconWithFallback src={itemIconUrl(item.itemId, ver)} alt={label} fallbackGlyph={name} className="h-full w-full object-contain" size={44} />
              </span>
              <span className={`mt-1.5 line-clamp-2 min-h-[24px] max-w-[74px] text-[9px] leading-tight ${recordOnly || demoted ? "text-[#e9e9ed]/42" : "text-[#e9e9ed]/80"}`}>{name}</span>
              <span className={`mt-0.5 text-[9px] font-semibold tabular-nums ${recordOnly || demoted ? "text-[#e9e9ed]/42" : "text-[#b5abfc]"}`}>{item.pct}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OtpDivergenceCard({
  build,
  view,
  fullBuild,
  itemName,
}: {
  build: BuildResponse;
  view: FeaturedBuildView;
  fullBuild: FeaturedFullBuild | null;
  itemName: (id: number) => string;
}) {
  const differences: string[] = [];
  const starter = view.starters[0];
  if (starter && starter.itemId !== build.items.starter.id) {
    differences.push(`They open with ${itemName(starter.itemId)} rather than ${build.items.starter.name}.`);
  }

  const boots = view.boots[0];
  if (boots && boots.itemId !== build.items.boots.id) {
    differences.push(`They finish on ${itemName(boots.itemId)} over ${build.items.boots.name}.`);
  }

  const wpaCompleted = new Set([
    build.items.first.id,
    build.items.second.id,
    build.items.third.id,
    ...build.items.fourthPlus.map((pick) => pick.id),
  ]);
  const otpOnly = fullBuild?.items.find((item) => !item.isBoots && !item.isSnowball && !wpaCompleted.has(item.itemId));
  if (otpOnly) {
    differences.push(`Their recorded finished set includes ${itemName(otpOnly.itemId)}, outside the WPA path above.`);
  }

  const backfilled = view.items.find((item) => item.pct < MIN_DISPLAY_PCT);
  if (backfilled && !differences.some((difference) => difference.includes(itemName(backfilled.itemId)))) {
    differences.push(`${itemName(backfilled.itemId)} is backfilled below the 15% usage floor because it still appears in their stored games.`);
  }

  const lines = differences.length > 0 ? differences.slice(0, 3) : ["Their stored sample does not diverge from the WPA path on starting item, boots, or completed-item membership."];

  return (
    <section className={`${CARD_CLASS} p-4 lg:col-start-2 lg:row-start-1`}>
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Where they diverge</SectionLabel>
        <span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/45">stored sample</span>
      </div>
      <ul className="mt-3 space-y-3">
        {lines.map((line) => (
          <li key={line} className="flex gap-2 border-t border-white/[0.07] pt-3 text-[11px] leading-relaxed text-[#e9e9ed]/75 first:border-t-0 first:pt-0">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9184d9]" aria-hidden="true" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** THE LANE CAPTION (2026-08-10) — the fix for a screen that lied by omission.
 *
 *  With TOP selected the hero header reads "Viktor TOP LANE" while this card
 *  showed a mid-lane one-trick, and nothing on the card named a lane. Clicking
 *  TOP / MID / BOT (or, before the 2026-08-11 single-bracket collapse removed
 *  them, the elo pills) left the panel byte-identical, so the pills looked
 *  broken on this tab while they visibly moved the sibling tabs.
 *
 *  That inertness is BY DESIGN, not a broken fetch: `app/api/otp/featured` reads
 *  only `championId`, `featuredOtpRequestInputs` deliberately omits lane, and
 *  the table is one row per champion. The defect was never the architecture; it
 *  was that the screen did not say so. So this is a caption, not a re-fetch —
 *  do NOT "fix" this by making the OTP feed lane-scoped.
 *
 *  WHAT IT DOES NOT SAY, AND WHY. It does not name the lane the featured player
 *  actually plays. Checked the whole payload: `player` carries gameName,
 *  tagLine, server, tier, lp, championSharePct, sourceGames, winratePct, kda,
 *  refreshedAt — no role or lane — and `gameLog` entries carry `items` and `win`
 *  only. There is no lane in the data, so none is claimed. */
function OtpLaneScopeNote({ championName }: { championName: string }) {
  return (
    <p className="rounded-[8px] bg-panel2 px-3.5 py-3 text-[11px] leading-relaxed text-txt/70 shadow-[inset_0_0_0_1px_rgba(233,233,237,0.08)]">
      <span className="font-semibold text-txt">Picked across all lanes.</span> This is the best{" "}
      {championName} account we track on the champion overall, so it does not follow the lane or rank
      selection above, and their stored games are counted wherever they played them. Which lane they
      main is not recorded, so this card does not claim one.
    </p>
  );
}

function OtpLastGamesCard({ gameLog }: { gameLog: FeaturedGame[] }) {
  if (gameLog.length === 0) return null;
  return (
    <section className={`${CARD_CLASS} p-4 lg:col-start-2 lg:row-start-4`}>
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Their last games</SectionLabel>
        <span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/45">newest stored</span>
      </div>
      <div className="mt-3 divide-y divide-white/[0.07]">
        {gameLog.slice(0, 3).map((game, index) => (
          <div key={index} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <span className="text-[10px] tabular-nums text-[#9397ab]/65">{index === 0 ? "Most recent" : `${index + 1} games ago`}</span>
            <span className={`text-[10px] font-semibold ${game.win === true ? "text-[#46c79b]" : game.win === false ? "text-[#e8736e]" : "text-[#9397ab]/65"}`}>{game.win === true ? "Victory" : game.win === false ? "Defeat" : "Result unavailable"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function otpSpellSlots(spells: { spells: number[]; games: number; pct: number } | null, sampleGames: number, ver: string): RunePageModalSpell[] {
  const sample = spells ? { count: spells.games, denominator: sampleGames } : null;
  return [0, 1].map((index) => {
    const id = spells?.spells[index] ?? null;
    return id == null
      ? { id: null, name: "No data", icon: "" }
      : { id, name: spellName(id), icon: spellIconUrl(id, ver), sample };
  });
}

export default function FeaturedOtpCard({
  champ,
  ver,
  lane,
  build,
}: {
  champ: ChampionRef;
  ver: string;
  lane: LaneId;
  /** NULLABLE as of 2026-08-10, and that is what makes this card reachable on
   *  a lane with no WPA build.
   *
   *  `/api/build?champ=112&role=4` 404s for Viktor Support, so BuildTabContent
   *  fell into its `empty` branch and rendered NO tabpanels at all — while
   *  `/api/otp/featured?championId=112` was returning the full 230-game
   *  payload, because it is lane-independent. A lane-scoped empty state was
   *  suppressing a tab whose content is not lane-scoped.
   *
   *  Everything on this card that needs `build` is a COMPARISON WITH, or an
   *  EXPORT ALONGSIDE, the WPA recommendation — the two apply buttons and the
   *  "Where they diverge" panel. Those three are the only things hidden when it
   *  is null; the player, the KPI strip, their build, runes, summoners, skill
   *  order and last games are all sourced from the OTP feed alone and render
   *  exactly as before. Absence beats invention: there is no WPA path to
   *  diverge from, so no divergence is claimed. */
  build: BuildResponse | null;
}) {
  const [data, setData] = useState<FeaturedResponse | null>(null);
  const [meta, setMeta] = useState<ReadonlyMap<number, ItemDetail>>(new Map());
  /** Every rune id on the page (keystone + minors + secondary picks) -> art.
   *  Was a single keystone before the full page was rendered. */
  const [runeArt, setRuneArt] = useState<ReadonlyMap<number, { name: string; icon: string }>>(new Map());
  const [skillPriority, setSkillPriority] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [runePageOpen, setRunePageOpen] = useState(false);
  const requestKey = `${champ.id}:${champ.key}:${ver}`;
  const [previousRequestKey, setPreviousRequestKey] = useState(requestKey);
  if (requestKey !== previousRequestKey) {
    setPreviousRequestKey(requestKey);
    setLoading(true);
    setRuneArt(new Map());
    setSkillPriority(null);
  }

  // Keep the effect's request object stable across state updates, but rebuild
  // it when the champion key changes as well as when its numeric id/version do.
  // That avoids both stale keyed requests and an effect loop from a fresh
  // object on every render.
  const request = useMemo(
    () => featuredOtpRequestInputs({ id: champ.id, key: champ.key }, ver),
    [champ.id, champ.key, ver]
  );

  useEffect(() => {
    // `cancelled` closure, not an AbortController: the same stale-response guard
    // ProConsensusCard uses. Switching champion fast otherwise lets an older
    // response land last and paint the wrong player's build.
    let cancelled = false;
    // Champion-level, from the same op.gg feed the skill-order card uses. Its
    // failure costs one line, so it is fetched separately and never blocks.
    fetch(`/api/skill-order?champ=${request.champId}&role=2`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && Array.isArray(j?.priority) && j.priority.length) setSkillPriority(j.priority);
      })
      .catch(() => {});
    Promise.all([
      fetch(`/api/otp/featured?championId=${request.champId}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      getItemDetailMap(request.ver).catch(() => new Map<number, ItemDetail>()),
    ]).then(async ([res, m]) => {
      if (cancelled) return;
      const body = res as FeaturedResponse | null;
      setData(body);
      setMeta(m);
      setLoading(false);

      // Pull the timelines for the champion someone is ACTUALLY looking at.
      //
      // Why this is here and not in ProConsensusCard, which already has a
      // trigger: that component's OTP variant is not rendered any more — this
      // card is what the OTP tab shows — so its trigger never fires. Same
      // orphaning that left the apply buttons behind when the tab swapped
      // components (v0.91.0).
      //
      // And its condition would not have helped: it fires only when NOTHING is
      // stored. The real gap is a one-trick with plenty of stored games and no
      // recorded skill orders — Little Bomb#HK1 on Ziggs had 35 games and a
      // null skillOrder, so the card correctly fell back to "not recorded for
      // this one-trick yet" and nothing ever went to fetch them. Viktor only
      // worked because the timeline ingest was run by hand once.
      //
      // Fire-and-forget on purpose: the route is claim- AND cooldown-gated
      // server-side (it spends the shared Riot key, paced at 1.3s), it takes
      // tens of seconds, and a failure must never turn a working card into an
      // error. The grid appears on a later visit — which is exactly what the
      // fallback copy already promises.
      if (body && !body.skillOrder) {
        void fetch(
          `/api/otp/refresh?championId=${request.champId}&championKey=${encodeURIComponent(request.champKey)}`,
          { method: "POST" }
        ).catch(() => {});
      }
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
      [page.primaryTree, page.secondaryTree].forEach((treeId) => {
        const tree = treeId == null ? null : PERK_TREES[treeId];
        if (!tree) return;
        ids.push(...tree.keystones, ...tree.minorRows.flat());
      });
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) return;
      const resolved = await Promise.all(
        uniqueIds.map((id) => resolveRuneDisplay(id, request.ver).catch(() => null))
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
  }, [request]);

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
        {/* The caption belongs on the empty state too: without it a reader on
            TOP reasonably concludes the gap is TOP-specific and tries another
            lane, which cannot change this answer. */}
        <p className="mt-2 text-[11px] text-mut/80 leading-relaxed">
          Searched across all lanes, so switching the lane or rank above will not change this.
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
    // A mis-roled stored game can put Bloodsong in a top-laner's sample, and
    // the sparse-build backfill would surface it — see FeaturedViewOptions.
    excludeSupportFinalItems: lane !== "support",
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
      ? view.slots
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
  // Per-slot counts, NOT the page-level figure repeated six times: each rune
  // carries how many of the games that filled ITS slot ran it. A slot with no
  // count (older cached body, or a rune no game placed there) simply gets no
  // number — see otpRunePage.ts's slotGridSample.
  const otpRuneGridPage = runePage ? otpRunePage(runePage, runeOf, runes!.slots, SHARD_ROWS) : null;
  const runeSlots = runes?.slots ?? null;

  const sampleMeta = `${sample.games} stored games · ${winPct}% won`;

  return (
    <div className="space-y-4">
      <section className={`${ACCENT_CARD_CLASS} relative overflow-hidden p-4 sm:p-5`}>
        <Scanline />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex h-[66px] w-[66px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[linear-gradient(150deg,#3a3663,#20223a)] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.55),0_0_22px_rgba(145,132,217,0.18)]">
              <IconWithFallback src={champ.icon} alt={champ.name} fallbackGlyph={champ.name} className="h-full w-full object-cover" size={66} />
            </span>
            <div className="min-w-0">
              <SectionLabel>The best {champ.name} we can find</SectionLabel>
              <h3 className="mt-1 text-[23px] font-semibold leading-tight tracking-[-0.02em] text-[#e9e9ed]">
                <PlayerIdentity gameName={player.gameName} tagLine={player.tagLine} href={opggProfileUrl(player.server, player.gameName, player.tagLine)} />
              </h3>
              <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-[#9397ab]/65">{player.server ?? "Region unavailable"} · {player.tier ?? "Rank unavailable"}{player.lp != null && <span className="tabular-nums"> · {player.lp} LP</span>}</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-5 border-l border-white/[0.1] pl-5 lg:min-w-[300px]">
            <StatValue label="Win rate" value={player.winratePct == null ? "—" : `${player.winratePct.toFixed(1)}%`} tone={player.winratePct == null ? "normal" : player.winratePct >= 50 ? "good" : "bad"} />
            <StatValue label="Games" value={sample.games.toLocaleString("en-US")} />
            <StatValue label="KDA" value={player.kda == null ? "—" : player.kda.toFixed(1)} />
          </div>
        </div>
      </section>

      {/* Above the setup block, not buried under it: this is the first thing
          that has to be true about the card. */}
      <div className="px-4 sm:px-5">
        <OtpLaneScopeNote championName={champ.name} />
      </div>

      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3 mb-3.5">
          <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">OTP setup</p>
          {/* Both buttons write the OTP setup into the game's own client
              ALONGSIDE the WPA build (roleLabel names the page, fallbackShards
              and `build` fill what the OTP sample does not carry). With no
              build for this lane there is nothing to name the page after and
              nothing to fall back to, so they are not rendered rather than
              rendered against invented inputs. */}
          {build && (
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
          )}
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
            <div className="min-w-0 lg:contents">
            {/* "Where they diverge" is a diff against the WPA path. On a lane
                with no WPA build there is no path to diff against, so the panel
                says that instead of diffing against nothing. It is REPLACED
                rather than omitted because its grid cell is explicitly placed
                (`lg:col-start-2 lg:row-start-1`) — dropping it leaves the right
                column's first row empty against a tall "Their build" beside it,
                and the honest sentence is better content for that space than a
                hole anyway. */}
            {build ? (
              <OtpDivergenceCard build={build} view={view} fullBuild={fullBuild} itemName={itemName} />
            ) : (
              <section className={`${CARD_CLASS} p-4 lg:col-start-2 lg:row-start-1`}>
                <div className="flex items-baseline justify-between gap-2">
                  <SectionLabel>Where they diverge</SectionLabel>
                  <span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/45">no lane build</span>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-[#e9e9ed]/75">
                  There is no WPA build for {champ.name} {LANE_LABEL[lane]} to compare against — that
                  lane has no recorded sample yet. Everything shown on this card is still theirs; only
                  the comparison is missing.
                </p>
              </section>
            )}
            {/* The shared grid combines the complete static tree with the one
                slot-coherent page this model actually carries. Every static
                alternative stays visible and every absent source slot remains
                an explicit empty marker. */}
            {otpRuneGridPage && (
              <section className={`${CARD_CLASS} mt-0 p-4 lg:col-start-2 lg:row-start-2`}>
                <PanelHeading meta={`${runes!.pct}% of ${sample.games} games`}>Runes</PanelHeading>
                <div className="mt-3">
                  {/* showSamples renders the fraction under the PICKED rune of
                      each row only. labelWidth is tightened to 30 because the
                      sample text puts every option in a fixed-width column —
                      the grid's 68px default is sized for the labelled modal
                      and would blow this narrow card's width out. */}
                  <RunePageGrid
                    page={otpRuneGridPage}
                    onRuneClick={() => setRunePageOpen(true)}
                    showSamples
                    runeSize={22}
                    keystoneSize={34}
                    shardSize={16}
                    labelWidth={30}
                    optionGap={4}
                  />
                </div>
                <p className="mt-3 text-[10px] leading-relaxed text-mut/65">
                  {runeSlots
                    ? "Each fraction counts that rune alone, over the games that filled its slot — not the whole page. Click a rune for the complete stored setup."
                    : "Click a rune to inspect the complete stored setup, including empty slots, shards, and spells."}
                </p>
              </section>
            )}

            {data!.spells && (
              <section className={`${CARD_CLASS} mt-0 p-4 lg:col-start-2 lg:row-start-3`}>
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

            <OtpLastGamesCard gameLog={gameLog} />

            {measuredSkillOrder ? (
              <section className={`${CARD_CLASS} mt-0 p-4 lg:col-start-1 lg:row-start-2`}>
                <BuildSkillOrderGrid
                  model={measuredSkillOrder}
                  sampleLabel={`Their own timelines · ${measuredSkillOrder.sampleSize} of ${sample.games} games`}
                  missingLevelsContext="recorded sample"
                  blankRecordedTail
                />
              </section>
            ) : skillPriority ? (
              <div className={`${CARD_CLASS} mt-0 p-4 lg:col-start-1 lg:row-start-2`}>
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
            <div className="min-w-0 lg:contents">
            {/* Gated on EITHER, not on `fullBuild` alone. The opener is a fact
                about how they play the lane and does not depend on any game
                having reached a finished build — before this, a player whose
                games all ended early lost their "Opens Dark Seal 70%" row as
                collateral. */}
            {(fullBuild || starter) && (
              <section className={`${CARD_CLASS} p-4 lg:col-start-1 lg:row-start-1`}>
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
                    <OtpBuildPath items={fullBuild.items} ver={ver} itemName={itemName} />

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
                    {view.items.some((item) => item.pct < MIN_DISPLAY_PCT) && (
                      <p className="mt-2 text-[10px] leading-relaxed text-[#9397ab]/65">Items under the 15% usage floor are backfilled into the five-item recommendation and shown at their real rate, not dropped.</p>
                    )}
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
              <p className="mt-0 text-[10.5px] text-mut/80 lg:col-start-1 lg:row-start-3">
                <span className="text-txt font-semibold">or</span> = instead of, not as well
              </p>
            )}

            {bootsSlot && (
              <section className={`${CARD_CLASS} mt-0 p-4 lg:col-start-1 lg:row-start-4`}>
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
              <section className={`${CARD_CLASS} mt-0 p-4 lg:col-start-1 lg:row-start-5`}>
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
      {otpRuneGridPage && (
        <RunePageModal
          open={runePageOpen}
          onClose={() => setRunePageOpen(false)}
          title="One-trick rune setup"
          subtitle={
            runeSlots
              ? `${runes!.games} of ${sample.games} stored games use this exact page · each rune's own fraction counts only the games that filled that slot, so the denominators differ by row`
              : `${runes!.games} of ${sample.games} stored games use this exact page · per-rune counts unavailable from this cached response`
          }
          page={otpRuneGridPage}
          spells={otpSpellSlots(data!.spells, sample.games, ver)}
          compact
        />
      )}
    </div>
  );
}
