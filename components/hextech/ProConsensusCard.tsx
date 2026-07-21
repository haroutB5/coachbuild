"use client";

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { itemIconUrl, spellIconUrl, spellName, treeIconUrl, treeName, resolveRuneDisplay, shardIconUrl, shardName } from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { IconWithFallback } from "@/components/IconWithFallback";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import { aggregateProConsensus, formatSharePct, type ProConsensusModel, type RuneSlotBreakdown } from "./proConsensus";

// Sample size below which the fraction shown is more noise than signal — the
// card still renders (a real user request, "Rocketbelt shows up a lot," can
// be true off 1-2 games) but with an explicit caution line rather than
// implying the same confidence a 20-game sample would carry.
const LOW_SAMPLE_THRESHOLD = 3;
// Fetched sample size for the aggregation — deliberately larger than PRO
// BUILDS' own list limit (20): this card never renders individual rows, only
// counts, so a bigger sample (route caps `limit` at 150 — see
// app/api/pros/route.ts) sharpens the fractions without any extra per-row
// render cost. 100 here, not 150, is this card's own deliberate choice
// within that ceiling, not a claim about the backend's own cap (comment
// fixed 2026-07-17 — previously said "backend caps at 100", which was wrong;
// the route's cap was raised 100 -> 150 on 2026-07-13 for this same request).
const AGGREGATION_LIMIT = 100;

interface ProConsensusCardProps {
  champ: ChampionRef;
  lane: LaneId;
  /** Same icon/data version BuildTabContent already resolved from the BUILD
   *  response's own patch (`versionFromPatch(build.patch)`) — reused here so
   *  this card's icons come from the SAME CDN version as the rest of the tab
   *  instead of triggering a second, possibly-different version resolution. */
  ver: string;
  onOpenDetail: (kind: "item" | EntityKind, id: number) => void;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; model: ProConsensusModel; itemMeta: Map<number, ItemDetail> }
  | { status: "hidden" } // N=0 by design (e.g. Viktor Support) — genuinely nothing to show
  | { status: "error"; reason: string }; // fetch failed — distinct from N=0 (v0.27.2); reason
// surfaces IN the line (v0.27.4) because a live iOS-only persistent failure
// could not be diagnosed from screenshots that all read the same generic text.

interface RuneDisplay {
  name: string;
  icon: string;
}

interface DisplayNames {
  items: Map<number, string>;
  keystone: RuneDisplay | null;
  primaryMinors: Map<number, RuneDisplay>;
  secondaryPicks: Map<number, RuneDisplay>;
}

function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold mb-3.5">{children}</p>
  );
}

function ConsensusSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse">
      <div className="h-2.5 w-32 bg-panel2 rounded mb-4" />
      <div className="flex gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="w-11 h-11 rounded-lg bg-panel2 flex-shrink-0" />
        ))}
      </div>
    </div>
  );
}

/** Fraction + percentage — "35/39 · 90%", percentage primary (bold/teal),
 *  fraction muted. Shared by every stat row on this card (requirement #1:
 *  every fraction — items, keystone, secondary tree, spells, additional
 *  runes — gets the same treatment). */
function FractionPct({ count, denom, className = "" }: { count: number; denom: number; className?: string }) {
  const pct = denom > 0 ? formatSharePct(count / denom) : "0%";
  return (
    <span className={`tabular-nums ${className}`}>
      <span className="font-bold text-teal">{pct}</span>
      <span className="text-mut/70"> · {count}/{denom}</span>
    </span>
  );
}

function ItemTile({
  itemId,
  count,
  denom,
  name,
  icon,
  onClick,
}: {
  itemId: number;
  count: number;
  denom: number;
  name: string;
  icon: string;
  onClick: () => void;
}) {
  const pct = formatSharePct(denom > 0 ? count / denom : 0);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${name} — built in ${count} of ${denom} pro games (${pct})`}
      className="flex flex-col items-center text-center w-[72px] flex-shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center">
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
      </span>
      <span className="text-[10px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[24px]">{name}</span>
      <span className="text-[10.5px] font-bold tabular-nums text-teal">{pct}</span>
      <span className="text-[9.5px] text-mut/70 tabular-nums">{count}/{denom}</span>
    </button>
  );
}

/** v0.28.0 — one grid slot holding BOTH boots choices stacked vertically
 *  (user report: Crimson Lucidity 35% and Spellslinger's Shoes 27% each ate a
 *  full item slot on the same champion — "count them under the same item,
 *  just put the two choices on top of each other"). Same overall footprint
 *  as one ItemTile so it reflows in the same flex-wrap row; each row is its
 *  own tap target with its own icon/name/pct/count — the two counts are
 *  never merged into a fake combined stat (they're independent per-boot
 *  fractions against the same `denom`). */
function BootsStackTile({
  boots,
  denom,
  names,
  icon,
  onClick,
}: {
  boots: { itemId: number; count: number }[];
  denom: number;
  names: Map<number, string>;
  icon: (itemId: number) => string;
  onClick: (itemId: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 w-[72px] flex-shrink-0 justify-center">
      {boots.map((b) => {
        const name = names.get(b.itemId) ?? `Item #${b.itemId}`;
        const pct = formatSharePct(denom > 0 ? b.count / denom : 0);
        return (
          <button
            key={b.itemId}
            type="button"
            onClick={() => onClick(b.itemId)}
            aria-label={`View details for ${name} — built in ${b.count} of ${denom} pro games (${pct})`}
            className="flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
          >
            <span className="w-5 h-5 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback src={icon(b.itemId)} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={20} />
            </span>
            <span className="text-left leading-tight min-w-0 flex-1">
              {/* flex-1 (not just min-w-0) gives this span a definite width
                  before line-clamp is evaluated — without it, Chromium's
                  -webkit-line-clamp height computation inside a flex row goes
                  wrong (measured: button rendered ~44px tall for ~22px of
                  real content) and the name clips mid-word with no ellipsis
                  ("Spellslinge Shoes" for Spellslinger's Shoes). line-clamp-2
                  + break-words matches ItemTile's own two-line name treatment
                  instead of a single-line clamp that has no room to work with
                  in this narrow icon+text column. */}
              <span className="block text-[9px] text-txt leading-tight line-clamp-2 break-words">{name}</span>
              <span className="block text-[8.5px] tabular-nums mt-0.5">
                <span className="font-bold text-teal">{pct}</span>
                <span className="text-mut/60"> · {b.count}/{denom}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 2026-07-22 — one grid slot holding the top starter-class item choice(s)
 *  (Dark Seal, Tear of the Goddess, etc. — STARTING_ITEM_ALLOWLIST), stacked
 *  the exact same way BootsStackTile stacks boots choices (v0.28.0) — same
 *  component, different label vocabulary, since a starter and a boots pick
 *  are structurally the same "small labeled slot beside the main items
 *  grid" shape. Hard user directive (screenshot-verified, 2026-07-22): a
 *  starter must NEVER render inside the main ITEMS grid — this is its
 *  dedicated home instead. Absent (not rendered) when `starters` is empty —
 *  see the render call site below. */
function StartersStackTile({
  starters,
  denom,
  names,
  icon,
  onClick,
}: {
  starters: { itemId: number; count: number }[];
  denom: number;
  names: Map<number, string>;
  icon: (itemId: number) => string;
  onClick: (itemId: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 w-[72px] flex-shrink-0 justify-center">
      {starters.map((s) => {
        const name = names.get(s.itemId) ?? `Item #${s.itemId}`;
        const pct = formatSharePct(denom > 0 ? s.count / denom : 0);
        return (
          <button
            key={s.itemId}
            type="button"
            onClick={() => onClick(s.itemId)}
            aria-label={`View details for ${name} — a starting item choice in ${s.count} of ${denom} pro games (${pct})`}
            className="flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
          >
            <span className="w-5 h-5 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback src={icon(s.itemId)} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={20} />
            </span>
            <span className="text-left leading-tight min-w-0 flex-1">
              {/* Same line-clamp/flex-1 recipe as BootsStackTile's name span
                  — see that component's comment for why flex-1 (not just
                  min-w-0) is load-bearing for -webkit-line-clamp inside a
                  flex row. */}
              <span className="block text-[9px] text-txt leading-tight line-clamp-2 break-words">{name}</span>
              <span className="block text-[8.5px] tabular-nums mt-0.5">
                <span className="font-bold text-teal">{pct}</span>
                <span className="text-mut/60"> · {s.count}/{denom}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** In-game-page rune tile — icon above name above percentage, the same
 *  vocabulary RunesSummonersCard's RuneTile uses on the BUILD tab, just
 *  driven by a pick-rate fraction instead of a WPA score (requirement: "put
 *  the additional runes as the layout... runes are set as in game"). `size`
 *  controls the keystone's extra prominence (large + gold ring) vs. the
 *  smaller minor/pick/shard tiles. */
function ConsensusRuneTile({
  count,
  denom,
  name,
  icon,
  size = "sm",
  onClick,
}: {
  count: number;
  denom: number;
  name: string;
  icon: string;
  size?: "lg" | "sm" | "xs";
  onClick: () => void;
}) {
  const pct = formatSharePct(denom > 0 ? count / denom : 0);
  const dim =
    size === "lg"
      ? "w-14 h-14 border-2 border-line-gold shadow-[0_0_14px_rgba(200,170,110,0.3)]"
      : size === "sm"
        ? "w-10 h-10 border border-line"
        : "w-8 h-8 border border-line";
  const pxSize = size === "lg" ? 56 : size === "sm" ? 40 : 32;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View details for ${name} — picked in ${count} of ${denom} games (${pct})`}
      className="group flex flex-col items-center text-center w-[64px] gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
    >
      <span className={`${dim} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105`}>
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={pxSize} />
      </span>
      <span className="text-[10px] text-txt leading-tight line-clamp-2 min-h-[24px]">{name}</span>
      <span className="text-[10.5px] font-bold tabular-nums text-teal">{pct}</span>
      <span className="text-[9px] text-mut/60 tabular-nums">{count}/{denom}</span>
    </button>
  );
}

/** Honest sub-sample caption for a rune-slot breakdown — "from N games", or
 *  "from N solo-queue games" when the sample is entirely soloq-sourced
 *  (structurally true for shards today, see proConsensus.ts's header), or a
 *  mixed-source split when both are present. Never asserts a source split
 *  the data doesn't actually show. */
function slotSampleNote(breakdown: RuneSlotBreakdown): string {
  const { sampleSize, soloqCount, prostageCount } = breakdown;
  if (sampleSize === 0) return "";
  if (prostageCount === 0 && soloqCount > 0) return `from ${soloqCount} solo-queue game${soloqCount === 1 ? "" : "s"}`;
  if (soloqCount === 0 && prostageCount > 0) return `from ${prostageCount} pro-play game${prostageCount === 1 ? "" : "s"}`;
  return `from ${sampleSize} games (${soloqCount} solo queue, ${prostageCount} pro play)`;
}

export default function ProConsensusCard({ champ, lane, ver, onOpenDetail }: ProConsensusCardProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // v0.27.3 (live user report: the v0.27.2 error line showed up on-device and
  // then STUCK — the fetch only ever re-fired on champion/lane change, so one
  // transient blip parked the error until a full navigation): bumping this
  // token re-runs the fetch effect. Bumped by the tappable retry in the error
  // branch below; the effect itself also auto-retries before ever surfacing
  // the error state.
  const [retryToken, setRetryToken] = useState(0);
  const [names, setNames] = useState<DisplayNames>({
    items: new Map(),
    keystone: null,
    primaryMinors: new Map(),
    secondaryPicks: new Map(),
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const role = LANE_TO_ROLE_ID[lane];
    // v0.27.0 (user request, "pro players seem to build Rocketbelt on
    // Viktor"): a separate, independent fetch from ProBuildsTab's own list —
    // ALWAYS source=all (maximum sample for the frequency count) regardless
    // of whatever All/Solo Queue/Pro Play filter the user has picked for the
    // PRO BUILDS list below; the two are deliberately decoupled.
    //
    // v0.27.1: fetched in parallel with the full item-metadata map
    // (into/from/tags/purchasable) — aggregateProConsensus now needs it to
    // filter out mid-build components (Needlessly Large Rod etc.) DURING
    // aggregation, not as a display-only afterthought. getItemDetailMap
    // never throws (degrades to an empty map on failure), so a failed item
    // fetch can't reject this Promise.all — it just means every item gets
    // excluded that round (see isBuildItem's "unknown item -> exclude"
    // default), never that an unverified item slips through.
    const attempt = (attemptsLeft: number) => {
      // v0.27.4: cache-busting param on retries only (first attempt stays the
      // clean URL so normal loads keep any legitimate intermediary caching) —
      // defeats a poisoned SW/edge cache entry along a specific device's path.
      const bust = attemptsLeft < 2 ? `&r=${Date.now()}` : "";
      Promise.all([
        fetch(`/api/pros?championId=${champ.id}&role=${role}&limit=${AGGREGATION_LIMIT}&source=all${bust}`).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: ProGamesApiResponse = await res.json();
          return Array.isArray(data?.games) ? data.games : [];
        }),
        // Belt-and-braces despite getItemDetailMap's own internal catch: the
        // item map must NEVER be able to sink the whole card.
        getItemDetailMap(ver).catch(() => new Map<number, ItemDetail>()),
      ])
        .then(([games, itemMeta]: [ProGame[], Map<number, ItemDetail>]) => {
          if (cancelled) return;
          if (games.length === 0) {
            setState({ status: "hidden" });
            return;
          }
          setState({ status: "ok", model: aggregateProConsensus(games, itemMeta), itemMeta });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // v0.27.3 (live user report): a SINGLE transient failure (network
          // blip, cold /api/pros invocation, the SW's empty-cache fallback
          // right after a deploy) used to park the error line until the next
          // champion change. Auto-retry with backoff first — most blips
          // self-heal within seconds — and only surface the error state once
          // the retries are exhausted. The error line is also tappable now
          // (bumps retryToken) so the user is never told to hard-refresh.
          if (attemptsLeft > 0) {
            window.setTimeout(() => {
              if (!cancelled) attempt(attemptsLeft - 1);
            }, attemptsLeft === 2 ? 1200 : 3500);
            return;
          }
          // v0.27.2: distinct from "hidden" (genuine N=0) — a real, visible,
          // muted signal instead of silent nothing. v0.27.4: carry the reason
          // into the line — "HTTP 500" means the server, "Load failed" /
          // "Failed to fetch" means the device's network/SW layer.
          const reason = err instanceof Error ? err.message : String(err);
          setState({ status: "error", reason: reason.slice(0, 60) });
        });
    };
    attempt(2);
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane, ver, retryToken]);

  useEffect(() => {
    if (state.status !== "ok") return;
    let cancelled = false;
    const { model, itemMeta } = state;
    (async () => {
      // Item names are already in itemMeta (same fetch that filtered the
      // items in the first place) — no second item fetch needed. Rune perk
      // names/icons (keystone + the new primary-minor/secondary-pick rows)
      // still need proAssets' CDN rune-map resolution.
      const runeIds = new Set<number>();
      if (model.keystone) runeIds.add(model.keystone.keystoneId);
      model.primaryMinors.entries.forEach((e) => runeIds.add(e.runeId));
      model.secondaryPicks.entries.forEach((e) => runeIds.add(e.runeId));

      const resolved = await Promise.all(Array.from(runeIds).map((id) => resolveRuneDisplay(id, ver)));
      if (cancelled) return;

      const runeDisplay = new Map<number, RuneDisplay>();
      resolved.forEach((r) => runeDisplay.set(r.id, { name: r.name, icon: r.icon }));

      const itemNames = new Map<number, string>();
      itemMeta.forEach((detail, id) => itemNames.set(id, detail.name));

      setNames({
        items: itemNames,
        keystone: model.keystone ? (runeDisplay.get(model.keystone.keystoneId) ?? null) : null,
        primaryMinors: new Map(
          model.primaryMinors.entries.map((e) => [e.runeId, runeDisplay.get(e.runeId) ?? { name: `Rune #${e.runeId}`, icon: "" }])
        ),
        secondaryPicks: new Map(
          model.secondaryPicks.entries.map((e) => [e.runeId, runeDisplay.get(e.runeId) ?? { name: `Rune #${e.runeId}`, icon: "" }])
        ),
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` narrowed above; model identity changes every fetch resolution, which is exactly when a re-resolve is wanted
  }, [state, ver]);

  if (state.status === "loading") return <ConsensusSkeleton />;
  if (state.status === "hidden") return null;
  if (state.status === "error") {
    return (
      <p className="text-[10.5px] text-mut/50 px-0.5" role="status">
        Pro consensus data couldn&apos;t load ({state.reason}).{" "}
        <button
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            setRetryToken((t) => t + 1);
          }}
          className="underline decoration-dotted underline-offset-2 text-mut/80 hover:text-teal-dim transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal rounded-sm"
        >
          Retry
        </button>
      </p>
    );
  }

  const { model } = state;
  const lowSample = model.gamesTotal < LOW_SAMPLE_THRESHOLD;

  const sourceNote =
    model.tournaments.soloqCount > 0 && model.tournaments.prostageCount > 0
      ? `${model.tournaments.prostageCount} pro play, ${model.tournaments.soloqCount} solo queue`
      : model.tournaments.prostageCount > 0
        ? "pro play"
        : "solo queue";
  const tournamentNote =
    model.tournaments.names.length > 0
      ? model.tournaments.names.length <= 3
        ? model.tournaments.names.join(", ")
        : `${model.tournaments.names.slice(0, 3).join(", ")} +${model.tournaments.names.length - 3} more`
      : null;
  const sampleLine = `From ${model.gamesTotal} pro game${model.gamesTotal === 1 ? "" : "s"} (${sourceNote}) · fresh window${
    tournamentNote ? ` · ${tournamentNote}` : ""
  }`;

  // v0.28.0 — one consolidated caption for the additional-runes sample sizes
  // (minors/picks/shards each carry their OWN denominator, see proConsensus.ts
  // module header) instead of three repeated "from N games" lines — still
  // honest per-slot, just one line instead of three.
  // v0.29.0: minors/picks are now conditioned on the primary tree, so the
  // caption names it ("minors from 18 games running Sorcery") — reflecting the
  // conditioning honestly rather than implying a flat all-games aggregate.
  const treeCtx = model.primaryTree ? ` running ${treeName(model.primaryTree)}` : "";
  const additionalRuneNotes = [
    model.primaryMinors.entries.length > 0 ? `minors ${slotSampleNote(model.primaryMinors)}${treeCtx}` : null,
    model.secondaryPicks.entries.length > 0 ? `picks ${slotSampleNote(model.secondaryPicks)}` : null,
    model.shards.entries.length > 0 ? `shards ${slotSampleNote(model.shards)}` : null,
  ].filter((n): n is string => Boolean(n));

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <CardHeader>Pro Consensus</CardHeader>
      </div>

      {lowSample && (
        <p className="text-[10.5px] text-gold/70 -mt-2 mb-3.5 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          Low sample size — treat these fractions with caution.
        </p>
      )}

      {/* 2026-07-22 — starters render in their OWN labeled slot, entirely
          separate from the Items block below (hard user directive: a
          starter must never render as a completed item, "keep it as a
          starting item in a separate slot"). "Starting" matches the card's
          existing label vocabulary (itemSetBody.ts's "Starting" block type /
          StartingCard.tsx on the BUILD tab above this card use the same
          word for the same concept). Visually parallel to the boots stack
          below — same StartersStackTile/BootsStackTile shape — just in its
          own section instead of sharing the Items header. Absent entirely
          when there are zero starters in the sample (no empty block). */}
      {model.starters.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">Starting</p>
          <div className="flex flex-wrap gap-2.5">
            <StartersStackTile
              starters={model.starters}
              denom={model.gamesTotal}
              names={names.items}
              icon={(id) => itemIconUrl(id, ver)}
              onClick={(id) => onOpenDetail("item", id)}
            />
          </div>
        </div>
      )}

      {(model.items.length > 0 || model.boots.length > 0) && (
        <div className="mb-4">
          <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">Items</p>
          {/* flex-wrap, not overflow-x-auto — matches CoreBuildOrderCard/
              SituationalCard's own item-row convention on this tab (no
              horizontal scroll strips anywhere on BUILD), so tiles reflow
              to a second row instead of hiding behind a scrollbar at 390px.
              v0.28.0: boots render as ONE stacked slot (see BootsStackTile)
              instead of eating two separate item slots. */}
          <div className="flex flex-wrap gap-2.5">
            {model.boots.length > 0 && (
              <BootsStackTile
                boots={model.boots}
                denom={model.gamesTotal}
                names={names.items}
                icon={(id) => itemIconUrl(id, ver)}
                onClick={(id) => onOpenDetail("item", id)}
              />
            )}
            {model.items.map((entry) => (
              <ItemTile
                key={entry.itemId}
                itemId={entry.itemId}
                count={entry.count}
                denom={model.gamesTotal}
                name={names.items.get(entry.itemId) ?? `Item #${entry.itemId}`}
                icon={itemIconUrl(entry.itemId, ver)}
                onClick={() => onOpenDetail("item", entry.itemId)}
              />
            ))}
          </div>
        </div>
      )}

      {(() => {
        // Local consts (not `model.keystone` inline) so TS's null-narrowing
        // survives into the nested onClick closures below — narrowing a
        // property access does NOT persist across a function boundary, only
        // a local const does.
        const keystone = model.keystone;
        const secondaryTree = model.secondaryTree;
        const spellPair = model.spellPair;
        const hasPrimaryCol = Boolean(keystone) || model.primaryMinors.entries.length > 0;
        const hasSecondaryCol = Boolean(secondaryTree) || model.secondaryPicks.entries.length > 0 || model.shards.entries.length > 0;
        if (!hasPrimaryCol && !hasSecondaryCol && !spellPair) return null;
        // v0.28.0 (user request: "put the additional runes as the layout...
        // runes are set as in game. Don't put them like that separately") —
        // composed as ONE in-game-style rune page (primary column: keystone
        // + its minors below; secondary column: tree label + 2 picks + stat
        // shards; summoners column), the same layout vocabulary
        // RunesSummonersCard already uses on the BUILD tab for the WPA
        // recommendation, adapted here to a pick-rate fraction per tile
        // instead of a WPA score. No "Additional Runes" sub-section anymore —
        // minors/picks/shards render directly under their owning tree.
        return (
        <div className="grid grid-cols-1 md:grid-cols-[1.5fr_1.1fr_auto] gap-x-8 gap-y-5 mb-1">
          {hasPrimaryCol && (
            <div>
              {/* v0.29.0: the page is now conditioned on the modal keystone's
                  TREE, so show that tree as the PRIMARY header (icon + name),
                  mirroring the secondary tree header — the data is already at
                  hand (model.primaryTree). Falls back to the plain "Primary"
                  label when the tree couldn't be resolved from the sample. */}
              {model.primaryTree ? (
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="w-5 h-5 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
                    <IconWithFallback
                      src={treeIconUrl(model.primaryTree)}
                      alt={treeName(model.primaryTree)}
                      fallbackGlyph={treeName(model.primaryTree)}
                      className="w-full h-full object-contain"
                      size={20}
                    />
                  </span>
                  <span className="text-[11.5px] text-txt font-semibold">{treeName(model.primaryTree)}</span>
                </div>
              ) : (
                <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2.5">Primary</p>
              )}
              <div className="flex flex-wrap items-end gap-2.5">
                {keystone && (
                  <ConsensusRuneTile
                    size="lg"
                    count={keystone.count}
                    denom={model.runesSampleSize}
                    name={names.keystone?.name ?? `Rune #${keystone.keystoneId}`}
                    icon={names.keystone?.icon ?? ""}
                    onClick={() => onOpenDetail("rune", keystone.keystoneId)}
                  />
                )}
                {model.primaryMinors.entries.map((e) => (
                  <ConsensusRuneTile
                    key={e.runeId}
                    count={e.count}
                    denom={model.primaryMinors.sampleSize}
                    name={names.primaryMinors.get(e.runeId)?.name ?? `Rune #${e.runeId}`}
                    icon={names.primaryMinors.get(e.runeId)?.icon ?? ""}
                    onClick={() => onOpenDetail("rune", e.runeId)}
                  />
                ))}
              </div>
            </div>
          )}

          {hasSecondaryCol && (
            <div>
              {secondaryTree ? (
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="w-5 h-5 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
                    <IconWithFallback
                      src={treeIconUrl(secondaryTree.treeId)}
                      alt={treeName(secondaryTree.treeId)}
                      fallbackGlyph={treeName(secondaryTree.treeId)}
                      className="w-full h-full object-contain"
                      size={20}
                    />
                  </span>
                  <span className="text-[11.5px] text-txt font-semibold">{treeName(secondaryTree.treeId)}</span>
                  <span className="text-[9.5px] leading-tight">
                    <FractionPct count={secondaryTree.count} denom={model.secondaryTreeSampleSize} />
                  </span>
                </div>
              ) : (
                <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2.5">Secondary</p>
              )}

              {model.secondaryPicks.entries.length > 0 && (
                <div className="flex flex-wrap gap-2.5 mb-3.5">
                  {model.secondaryPicks.entries.map((e) => (
                    <ConsensusRuneTile
                      key={e.runeId}
                      count={e.count}
                      denom={model.secondaryPicks.sampleSize}
                      name={names.secondaryPicks.get(e.runeId)?.name ?? `Rune #${e.runeId}`}
                      icon={names.secondaryPicks.get(e.runeId)?.icon ?? ""}
                      onClick={() => onOpenDetail("rune", e.runeId)}
                    />
                  ))}
                </div>
              )}

              {model.shards.entries.length > 0 && (
                <div className="flex flex-wrap gap-2.5">
                  {model.shards.entries.map((e) => (
                    <ConsensusRuneTile
                      key={e.runeId}
                      size="xs"
                      count={e.count}
                      denom={model.shards.sampleSize}
                      name={shardName(e.runeId)}
                      icon={shardIconUrl(e.runeId)}
                      onClick={() => onOpenDetail("shard", e.runeId)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {spellPair && (
            <div className="flex md:flex-col md:justify-center gap-2">
              <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-0 md:mb-1.5 hidden md:block">
                Summoners
              </p>
              <div className="flex items-center gap-2">
                <div className="flex -space-x-1">
                  {spellPair.spells.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onOpenDetail("spell", id)}
                      aria-label={`View details for summoner spell ${spellName(id)}`}
                      className="w-8 h-8 rounded-[8px] bg-black/30 border border-line ring-2 ring-panel overflow-hidden flex items-center justify-center flex-shrink-0 focus-visible:outline-none focus-visible:ring-teal active:scale-95 transition-transform"
                    >
                      <IconWithFallback
                        src={spellIconUrl(id, ver)}
                        alt={spellName(id)}
                        fallbackGlyph={spellName(id)}
                        className="w-full h-full object-contain"
                        size={32}
                      />
                    </button>
                  ))}
                </div>
                <span>
                  <span className="block text-[11.5px] text-txt font-medium leading-tight">
                    {spellPair.spells.map((id) => spellName(id)).join(" + ")}
                  </span>
                  <span className="block text-[10px] leading-tight mt-0.5">
                    <FractionPct count={spellPair.count} denom={model.spellSampleSize} />
                  </span>
                </span>
              </div>
            </div>
          )}
        </div>
        );
      })()}

      {additionalRuneNotes.length > 0 && (
        <p className="text-[9.5px] text-mut/50 mt-1 mb-1">{additionalRuneNotes.join(" · ")}</p>
      )}

      <p className="text-[10px] text-mut/70 mt-3.5 pt-3 border-t border-line">{sampleLine}</p>
    </div>
  );
}
