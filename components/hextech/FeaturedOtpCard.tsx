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
// The full build can be produced two ways, and THE CAPTION MUST MATCH THE
// METHOD — this is the single most load-bearing rule in this file. The method
// is decided in lib/otp/featuredBuild.ts and arrives as a discriminated union:
//
//   "most-played-exact"    — an item set this player DEMONSTRABLY finished
//                            `games` separate games holding. The caption may
//                            say they played it, and states that count against
//                            `sampleGames`.
//   "assembled-from-rates" — their top boot plus their top legendaries by build
//                            rate. Possibly a combination they have NEVER
//                            played in one game, and the caption says exactly
//                            that. `games` is typed `null` on this branch, so
//                            there is no number available to caption it as a
//                            real game even by mistake.
//
// Neither caption may imply a PURCHASE ORDER. Riot's match payload stores a
// final inventory in slots item0..item5; the slot index is where the item sat
// in the inventory, not when it was bought. There is no purchase-order evidence
// anywhere in what we store, so the card says so on screen rather than letting
// a left-to-right strip of icons imply it.
//
// This repo shipped v0.73.1 over exactly this class of error (two denominators
// drifting apart). Do not let a caption drift off its method.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
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
import { buildFeaturedView } from "@/lib/otp/featuredBuild";
import HeroBand, { Pill } from "./HeroBand";
import KpiStrip, { type KpiItem } from "./KpiStrip";
import PanelHeading from "./PanelHeading";
import { sortPerkIdsByRow } from "./perkSlots";

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

interface RunePage {
  primaryTree: number | null;
  keystone: number | null;
  primary: number[];
  secondaryTree: number | null;
  secondary: number[];
  shards: number[];
}

interface FeaturedResponse {
  player: FeaturedPlayer | null;
  sample: { games: number; wins: number } | null;
  items: { itemId: number; games: number; pct: number }[];
  /** Per-game final inventories — what `buildFeaturedView` needs to tell an
   *  OBSERVED build from an assembled one. Optional here on purpose: an older
   *  cached/SW response predating the field must degrade to the assembled
   *  branch, not throw. */
  gameItems?: number[][];
  runes: { page: RunePage; games: number; pct: number } | null;
  spells: { spells: number[]; games: number; pct: number } | null;
}

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

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden" aria-hidden="true">
      <div
        className="h-full rounded-full bg-teal/75"
        style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
      />
    </div>
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
 *  would just make a screen reader say it twice. */
function BuildSlot({ name, icon }: { name: string; icon: string }) {
  return (
    <span
      title={name}
      className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
    >
      <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
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

export default function FeaturedOtpCard({ champ, ver }: { champ: ChampionRef; ver: string }) {
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

  // ONE call, four slots, one classifier — see lib/otp/featuredBuild.ts. The
  // item metadata map lives on the client (the route deliberately ships raw
  // ids), so this is where the two halves meet.
  //
  // `gameItems` is what lets the helper tell an OBSERVED build from an
  // assembled one; an older cached response without it degrades to the
  // assembled branch, correctly labelled, rather than throwing.
  const view = buildFeaturedView(data!.items, data!.gameItems ?? [], sample.games, meta, {
    minDisplayPct: MIN_DISPLAY_PCT,
  });
  const fullBuild = view.fullBuild;
  // Their most-common opener, on its own line rather than mixed into the build.
  // Genuinely useful on a one-trick card — Dun opens Doran's Ring in 4 games out
  // of 10 and Dark Seal in nearly 6, which is a real read on how he plays the
  // lane — but it is not a build slot and must not look like one.
  const starter = view.starters[0];

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
          <>
            {player.gameName}
            <span className="text-mut font-normal">#{player.tagLine}</span>
          </>
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
        {thinSample ? (
          <p className="text-[12px] text-mut leading-relaxed">
            Still collecting their games — we hold{" "}
            <span className="text-txt tabular-nums">{sample.games}</span> of the{" "}
            <span className="text-txt tabular-nums">{MIN_SAMPLE_GAMES}</span> needed before build
            percentages mean anything. Their card fills in as the ingest catches up.
          </p>
        ) : (
          <>
            {fullBuild && (
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
                    <span className="text-[12px] font-semibold text-txt tabular-nums ml-auto flex-shrink-0">
                      {starter.pct}%
                    </span>
                  </div>
                )}

                {/* Six 44px tiles + five 8px gaps = 304px, inside a 390px
                    viewport's 358px content box — one row, no wrap, no
                    horizontal scroll strip (this tab has none anywhere).
                    `flex-wrap` is still on so a future seventh slot degrades to
                    a second row instead of overflowing. */}
                {/* No per-slot percentage here, deliberately. Every slot in
                    `fullBuild.items` carries its OWN overall build rate, and
                    printing six of those beside a set that is itself quoted
                    against a different count ("3 of 37 games ended with exactly
                    these") puts two denominators on one row — the precise shape
                    of the v0.73.1 bug. The rates get their own section below,
                    under one stated denominator. */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {fullBuild.items.map((slot) => (
                    <BuildSlot
                      key={slot.itemId}
                      name={itemName(slot.itemId)}
                      icon={itemIconUrl(slot.itemId, ver)}
                    />
                  ))}
                </div>

                {/* THE CAPTION MUST MATCH THE METHOD — see this file's header
                    and featuredBuild.ts's. `method` is a discriminated union and
                    the assembled branch types `games` as null, so there is no
                    number available to caption a synthesis as a played game
                    even by mistake. Neither branch implies a purchase order,
                    and both state the sample they rest on. */}
                <p className="mt-2.5 text-[10.5px] text-mut/80 leading-relaxed">
                  {fullBuild.method === "most-played-exact" ? (
                    <>
                      A build {player.gameName} actually played —{" "}
                      <span className="text-txt tabular-nums">{fullBuild.games}</span> of the{" "}
                      <span className="text-txt tabular-nums">{fullBuild.sampleGames}</span> games we
                      hold ended with exactly these items.
                    </>
                  ) : (
                    <>
                      Their most-built boots and items across the{" "}
                      <span className="text-txt tabular-nums">{fullBuild.sampleGames}</span> games we
                      hold — put together from those rates, not taken from one game, so they may
                      never have finished a game holding exactly this set.
                    </>
                  )}{" "}
                  Not a purchase order: the match data stores a final inventory, never what was
                  bought first.
                </p>
              </section>
            )}

            {view.boots.length > 0 && (
              <section className="mt-5">
                <PanelHeading meta={sampleMeta}>Boots</PanelHeading>
                <ul className="mt-3 space-y-2">
                  {view.boots.map((b) => (
                    <li key={b.itemId} className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-md border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                        <IconWithFallback
                          src={itemIconUrl(b.itemId, ver)}
                          alt=""
                          fallbackGlyph={itemName(b.itemId)}
                          className="w-full h-full object-contain"
                          size={28}
                        />
                      </span>
                      <span className="text-[12px] text-txt truncate">{itemName(b.itemId)}</span>
                      <span className="ml-auto flex items-baseline gap-2 flex-shrink-0">
                        <span className="text-[9.5px] text-mut tabular-nums">
                          {b.games}/{sample.games}
                        </span>
                        <span className="text-[12px] font-semibold text-txt tabular-nums">{b.pct}%</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {view.items.length > 0 && (
              <section className="mt-5">
                {/* Renamed from "Builds most often" now that a real build sits
                    above it: this section's job is the SPREAD — how often each
                    item shows up — which is what makes the build above readable
                    as a preference rather than a rule. Boots are absent by
                    design; they have their own slot. */}
                {/* Short heading on purpose: measured at 390px, "How often they
                    build each item" pushed the denominator meta onto its own
                    line, breaking the shared baseline every other PanelHeading
                    on this card keeps. */}
                <PanelHeading meta={sampleMeta}>Build rates</PanelHeading>
                <ul className="mt-3 space-y-2.5">
                  {view.items.map((it) => (
                    <li key={it.itemId} className="flex items-center gap-3">
                      <span className="w-[30px] h-[30px] rounded-md border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                        <IconWithFallback
                          src={itemIconUrl(it.itemId, ver)}
                          alt=""
                          fallbackGlyph={itemName(it.itemId)}
                          className="w-full h-full object-contain"
                          size={30}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[12.5px] text-txt truncate">{itemName(it.itemId)}</span>
                          <span className="text-[12px] font-semibold text-txt tabular-nums flex-shrink-0">
                            {it.pct}%
                          </span>
                        </div>
                        {/* Bar capped rather than full-bleed: on a wide card
                            a 900px rail for "79%" is a lot of ink for one
                            number, and the eye stops tracking it. The bar is
                            aria-hidden and never the only carrier — the
                            percentage and the raw fraction are both text. */}
                        <div className="mt-1 flex items-center gap-2 max-w-[420px]">
                          <Bar pct={it.pct} />
                          <span className="text-[9.5px] text-mut tabular-nums flex-shrink-0 w-[52px] text-right">
                            {it.games}/{sample.games}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {view.items.length === 0 && !fullBuild && (
              <p className="text-[12px] text-mut">
                No item reaches {MIN_DISPLAY_PCT}% across the games we hold yet.
              </p>
            )}

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
                    the tracks become CONTENT-SIZED and left-packed: this card
                    is full-width at `lg` (BuildTabContent's `otp_otp` row,
                    ~1100px), and two equal fr tracks there pushed the secondary
                    tree's 2 tiles out to x=840 with ~450px of dead space in
                    between — measured at 1440x900. `auto` tracks + justify-start
                    keep the two trees beside each other and let the row end
                    where the content ends. */}
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-[auto_auto] sm:justify-start sm:gap-x-12">
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

            {skillPriority && (
              <div className="mt-5">
                <PanelHeading rule={false}>Skill order</PanelHeading>
                <div className="mt-2 flex items-center gap-1.5">
                  {skillPriority.map((s, i) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className="w-6 h-6 rounded-md bg-panel2 border border-line grid place-items-center text-[11px] font-semibold text-txt">
                        {s}
                      </span>
                      {i < skillPriority.length - 1 && <span className="text-mut text-[11px]">›</span>}
                    </span>
                  ))}
                </div>
                {/* Said out loud rather than implied. Every other number on this
                    card is this player's own; this one is not, because match-v5
                    does not carry skill order without a timeline call per game. */}
                <p className="mt-1.5 text-[10.5px] text-mut/70 leading-relaxed">
                  The champion&apos;s common order, not {player.gameName}&apos;s own — skill order is
                  not in the match data we store.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
