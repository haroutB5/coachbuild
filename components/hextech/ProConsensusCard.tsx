"use client";

import { useEffect, useState } from "react";
import type { ChampionRef, BuildResponse, ShardSet } from "@/lib/types";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import type { OtpPlayerSummary, OtpResponse } from "@/lib/otp/types";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { itemIconUrl, spellIconUrl, spellName, treeIconUrl, treeName, resolveRuneDisplay, shardIconUrl, shardName } from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { IconWithFallback } from "@/components/IconWithFallback";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";
import {
  aggregateProConsensus,
  formatSharePct,
  missingRunePageReason,
  proConsensusRuneApplyInput,
  type ProConsensusModel,
  type RuneSlotBreakdown,
} from "./proConsensus";
import { sortPerksByRow } from "./perkSlots";
import { buildRuneApplyBody } from "./runeApplyBody";
import { applyItemSetsForBuild } from "./itemSetsApply";
import { hasSession, getStoredSession, getStoredPort, applyRunes } from "@/components/live/companionClient";

// Sample size below which the fraction shown is more noise than signal — the
// card still renders (a real user request, "Rocketbelt shows up a lot," can
// be true off 1-2 games) but with an explicit caution line rather than
// implying the same confidence a 20-game sample would carry.
const LOW_SAMPLE_THRESHOLD = 3;
// Fetched sample size for the aggregation — deliberately larger than PRO
// BUILDS' own list limit (20): this card never renders individual rows, only
// counts, so a bigger sample (route caps `limit` at 300 — see
// app/api/pros/route.ts) sharpens the fractions without any extra per-row
// render cost. 200 here, not 300, is this card's own deliberate choice
// within that ceiling, not a claim about the backend's own cap (comment
// fixed 2026-07-17 — previously said "backend caps at 100", which was wrong;
// the route's cap was raised 100 -> 150 on 2026-07-13, then -> 300 on
// 2026-07-28, both times for this same "bigger pro sample" request).
const AGGREGATION_LIMIT = 200;

// Floor of result slots reserved for PRO-PLAY (on-stage) games — see
// lib/pro/mergeGames.ts for the measurement this comes from. Solo queue is
// played daily and official matches weekly, so a plain recency merge gave
// this card ~4 pro-play games out of 100 even for a champion with 94 fresh
// pro-play games in the DB (user report, Viktor mid, 2026-07-28). Half the
// sample is a floor, not a cap: when fewer pro-play games exist the rest of
// the page fills with solo queue, and when solo queue is the thin side
// pro play backfills past this number. The footer's "(N pro play, M solo
// queue)" line reports the REAL resulting split either way, so the card can
// never overstate what it sampled.
const PRO_PLAY_FLOOR = 100;

/** OTP sample size. Smaller than the pro card's 200 because the OTP pool is
 *  8 tracked accounts at 20 recent games each — the ceiling the DATA has, not
 *  a display choice — and asking for more would just be a wider LIMIT over the
 *  same rows. */
const OTP_AGGREGATION_LIMIT = 200;

/**
 * Which feed this card renders.
 *
 * "pro" — GET /api/pros: professional players, solo queue + on-stage.
 * "otp" — GET /api/otp: ladder ONE-TRICKS (op.gg's top Master+ players for
 *         this champion, 100+ games on it), their recent ranked games.
 *
 * One component, two feeds, deliberately: the user asked for the OTP section
 * to be "same as we have for pro," and a second component would drift from
 * this one's layout, its starter/boots partition (HARD RULE 2) and its
 * per-slot honest denominators within a couple of changes. The variant only
 * ever changes WHERE the games come from and WHAT the card says about them —
 * never how a frequency is computed.
 */
export type ConsensusVariant = "pro" | "otp";

interface ProConsensusCardProps {
  champ: ChampionRef;
  lane: LaneId;
  /** Defaults to "pro" so every existing call site is unchanged. */
  variant?: ConsensusVariant;
  /** Same icon/data version BuildTabContent already resolved from the BUILD
   *  response's own patch (`versionFromPatch(build.patch)`) — reused here so
   *  this card's icons come from the SAME CDN version as the rest of the tab
   *  instead of triggering a second, possibly-different version resolution. */
  ver: string;
  onOpenDetail: (kind: "item" | EntityKind, id: number) => void;
  /** 2026-07-22 (manual pro push) — the full BuildResponse for THIS champ+
   *  lane, same object BuildTabContent already fetched and passed to
   *  RunesSummonersCard. Optional, same degrade-quietly convention as that
   *  card's own championName/roleLabel/build props — omitting it just
   *  hides the two header buttons below (no companion session to push to
   *  anyway, or a caller that has no BuildResponse at hand). Supplies:
   *  champ.name + roleLabel for the "CoachBuild <champ> <role>" apply-body
   *  title (runeApplyBody.ts), runes.shards as the fallback ShardSet when
   *  pro shard data can't be slot-mapped (see proConsensus.ts's
   *  proConsensusRuneApplyInput), and the whole build for the item-set
   *  pipeline (itemSetsApply.ts's applyItemSetsForBuild, identical to
   *  RunesSummonersCard's own "Add item builds" button). */
  build?: BuildResponse;
}

type FetchState =
  | { status: "loading" }
  | {
      status: "ok";
      model: ProConsensusModel;
      itemMeta: Map<number, ItemDetail>;
      /** OTP variant only — who the sample came from, for the footer. */
      otpPlayers: OtpPlayerSummary[];
    }
  // OTP variant only: one-tricks ARE tracked for this champion but none of
  // their games have been ingested yet. Deliberately NOT folded into
  // "hidden": "we're still fetching this champion's one-tricks" and "nobody
  // one-tricks this champion" are different facts and the card must not
  // present the second when the first is true.
  | { status: "pending" }
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
  // v-manual-pro-push: mb-3.5 moved OUT of here into the header row wrapper
  // (see the default export's render) now that the row can hold header text
  // + two buttons side by side — an own margin-bottom on a flex child looks
  // uneven against taller/shorter siblings. Single call site (grep-verified)
  // so this is a pure layout move, not a behavior change.
  return <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">{children}</p>;
}

type ApplyUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** "Apply pro runes" — the manual pro-page counterpart to RunesSummonersCard's
 *  "Apply runes" button. Same compliance posture (v0.32.0 plan §3: applyRunes
 *  is only ever invoked from a user click, strictly manual mode, never a
 *  poll/effect) and the SAME apply pipeline (companionClient.applyRunes via
 *  buildRuneApplyBody) — only the RunesBlock fed into it differs (pro
 *  consensus via proConsensusRuneApplyInput instead of the WPA
 *  recommendation). companion 1.6.3 / 2026-07-22: this writes to a SEPARATE
 *  page — "CoachBuild <champ> <role> Pro" (`pageSuffix:"Pro"` below) — that
 *  coexists with the WPA auto-export's own "CoachBuild <champ> <role>" page,
 *  instead of sharing one. Before, both used the same title, so the app-wide
 *  WPA auto-export reverted the pro runes the user just applied (they fought
 *  over one physical LCU page). The "Pro" suffix goes AFTER champ/role so the
 *  champ-scoped cleanup prefix ("CoachBuild <champ> ") still matches both
 *  pages — a champ change cleans up the old champ's Pro page too. Disabled
 *  (with a reason tooltip, never fabricating a slot) whenever the pro sample
 *  can't fill a complete page — see proConsensus.ts's missingRunePageReason,
 *  the single source of truth this button and proConsensusRuneApplyInput both
 *  read. */
function ApplyProRunesButton({ champ, roleLabel, model, fallbackShards, variant = "pro" }: {
  champ: ChampionRef;
  roleLabel: string;
  model: ProConsensusModel;
  fallbackShards: ShardSet;
  /** 2026-07-28. "otp" writes a THIRD page, `"CoachBuild <champ> <role> OTP"`.
   *
   *  No companion change was needed for this, which is worth stating because
   *  the v0.70.0 card shipped without these buttons on the assumption that one
   *  was. It is not: `Invoke-ApplyRunes` is title-agnostic beyond a
   *  starts-with-"CoachBuild" gate (`Test-RunePayload`), matches its target by
   *  EXACT title, and its champ-scoped stale cleanup protects every page
   *  sharing the `"CoachBuild <champ> "` prefix — so a third suffix slots in
   *  under the existing contract rather than extending it.
   *
   *  Slot pressure is the one real consequence: three pages per champion on an
   *  account with two rune slots. That degrades correctly rather than silently
   *  — a real click takes `Invoke-ApplyRunes`'s manual branch, which replaces
   *  the CURRENTLY SELECTED page (real consent, HARD RULE 5's documented
   *  carve-out). The AUTO export still only ever writes the unsuffixed WPA
   *  page, so nothing about this can fire without a click. */
  variant?: ConsensusVariant;
}) {
  const isOtp = variant === "otp";
  const label = isOtp ? "OTP" : "pro";
  const pageSuffix = isOtp ? "OTP" : "Pro";
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ApplyUiState>({ status: "idle" });

  useEffect(() => {
    setReady(hasSession());
  }, []);

  const reason = missingRunePageReason(model);
  const input = reason === null ? proConsensusRuneApplyInput(model, fallbackShards) : null;
  const disabled = state.status === "applying" || input === null;
  const base = `Saves the ${isOtp ? "one-trick" : "pro"}-consensus runes as a separate "${pageSuffix}" rune page (kept alongside the recommended page).`;
  const tooltip =
    reason ??
    (input?.shardsFromFallback
      ? `${base} Shards from CoachBuild's recommendation — ${isOtp ? "one-trick" : "pro"} shard data unavailable.`
      : base);

  async function handleClick() {
    if (!input) return;
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState({ status: "error", message: "Companion not connected — open /live-setup and reconnect." });
      return;
    }

    let body: ReturnType<typeof buildRuneApplyBody>;
    try {
      // pageSuffix:"Pro" -> "CoachBuild <champ> <role> Pro", a SEPARATE page
      // from the WPA auto-export's "CoachBuild <champ> <role>" so the two
      // coexist and neither reverts the other (companion 1.6.3).
      body = buildRuneApplyBody(champ.name, roleLabel, input.runes, { pageSuffix });
    } catch {
      setState({ status: "error", message: `Couldn't build a ${label} rune page — try refreshing.` });
      return;
    }

    setState({ status: "applying" });
    const result = await applyRunes(port, session, body, "manual");
    if (result.ok) {
      const message =
        result.selected && result.verified
          ? "Applied in-client."
          : "Saved as a rune page — open the client to select it.";
      setState({ status: "success", message });
    } else {
      setState({
        status: "error",
        message: result.hint ?? "Apply failed — try again, or set runes manually in-client.",
      });
    }
    setTimeout(() => setState({ status: "idle" }), 4000);
  }

  if (!ready) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={tooltip}
        aria-label={`Apply ${label} runes — ${tooltip}`}
        className="flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover disabled:opacity-60 disabled:cursor-not-allowed rounded-md px-2.5 py-1.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        {state.status === "applying" ? "Applying…" : `Apply ${label} runes`}
      </button>
      {state.status === "success" && (
        <p role="status" className="text-[10.5px] text-teal">
          {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p role="status" className="text-[10.5px] text-bad max-w-[220px] text-right">
          {state.message}
        </p>
      )}
      {state.status === "idle" && input === null && reason && (
        <p role="status" className="text-[9.5px] text-mut/60 max-w-[200px] text-right">
          {reason}
        </p>
      )}
    </div>
  );
}

type ItemSetsUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** "Add pro item build" — a manual RE-PUSH of the SAME item-set export
 *  pipeline RunesSummonersCard's "Add item builds" button already uses
 *  (itemSetsApply.ts's applyItemSetsForBuild). Honest naming matters here:
 *  the exported set is the full CoachBuild champ+role set (Core/Optimized/
 *  Situational blocks) with the Pro consensus line already folded in
 *  (itemSetBody.ts resolves pro data independently) — this button does NOT
 *  export a pro-only set, it's a convenience re-trigger from the pro
 *  section for a user who's looking at this card specifically. No new
 *  plumbing: same gating (session-ready only), same result shape as
 *  RunesSummonersCard's ItemSetsButton. */
function AddProItemBuildButton({ champ, lane, roleLabel, build, variant = "pro" }: {
  champ: ChampionRef;
  lane: LaneId;
  roleLabel: string;
  build: BuildResponse;
  variant?: ConsensusVariant;
}) {
  const isOtp = variant === "otp";
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ItemSetsUiState>({ status: "idle" });

  useEffect(() => {
    setReady(hasSession());
  }, []);

  async function handleClick() {
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState({ status: "error", message: "Companion not connected — open /live-setup and reconnect." });
      return;
    }

    setState({ status: "applying" });
    const result = await applyItemSetsForBuild({ champ, lane, roleLabel, build, port, session });
    if (result.ok) {
      setState({
        status: "success",
        message: "Item build added — check your shop in game.",
      });
    } else {
      setState({
        status: "error",
        message: result.hint ?? "Couldn't add item builds — try again, or add them manually in-client.",
      });
    }
    setTimeout(() => setState({ status: "idle" }), 4000);
  }

  if (!ready) return null;

  // Honest on BOTH variants: this pushes the ONE champ+role set, which now
  // carries BOTH consensus lines as blocks. Neither button exports a
  // variant-only set, and the copy must not imply otherwise — it names the
  // line the user is looking at while saying the set is the full one.
  const tooltip = `Adds the full CoachBuild item set (including the ${isOtp ? "OTP" : "Pro"} consensus line) — check your shop in game.`;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={state.status === "applying"}
        title={tooltip}
        aria-label={`Add ${isOtp ? "OTP" : "pro"} item build — ${tooltip}`}
        className="flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-txt bg-panel2 border border-line hover:border-line-gold disabled:opacity-60 disabled:cursor-not-allowed rounded-md px-2.5 py-1.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        {state.status === "applying" ? "Adding…" : `Add ${isOtp ? "OTP" : "pro"} item build`}
      </button>
      {state.status === "success" && (
        <p role="status" className="text-[10.5px] text-teal max-w-[220px] text-right">
          {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p role="status" className="text-[10.5px] text-bad max-w-[220px] text-right">
          {state.message}
        </p>
      )}
    </div>
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
 *  fractions against the same `denom`).
 *
 *  v0.51.1 (user-reported: boots/starter icons render visibly smaller than
 *  the main ITEMS grid icons): each entry now uses the EXACT SAME icon
 *  size/box as ItemTile (w-11 h-11, size=44), stacked in a column instead of
 *  the old horizontal icon-left/text-right row that only had room for a
 *  20px icon. Still one flex-wrap slot overall (a `flex-col` wrapper), so
 *  the "group boots under one slot" partition semantics are unchanged —
 *  only the per-entry icon size and layout direction changed. */
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
    <div className="flex flex-col gap-2.5 w-[72px] flex-shrink-0">
      {boots.map((b) => {
        const name = names.get(b.itemId) ?? `Item #${b.itemId}`;
        const pct = formatSharePct(denom > 0 ? b.count / denom : 0);
        return (
          <button
            key={b.itemId}
            type="button"
            onClick={() => onClick(b.itemId)}
            aria-label={`View details for ${name} — built in ${b.count} of ${denom} pro games (${pct})`}
            className="flex flex-col items-center text-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
          >
            <span className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center">
              <IconWithFallback src={icon(b.itemId)} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
            </span>
            <span className="text-[10px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[24px]">{name}</span>
            <span className="text-[10.5px] font-bold tabular-nums text-teal">{pct}</span>
            <span className="text-[9.5px] text-mut/70 tabular-nums">{b.count}/{denom}</span>
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
 *  see the render call site below.
 *
 *  v0.51.1: mirrors BootsStackTile's same-day icon-size fix — each entry now
 *  renders at ItemTile's exact icon size (w-11 h-11, size=44) in a vertical
 *  icon-above-text layout instead of the old smaller (20px) horizontal row,
 *  so Starting/boots tiles no longer look visibly smaller than the main
 *  ITEMS grid. The starter-slot partition itself (never merging into the
 *  completed-items row) is unchanged — only the tile's internal size/layout. */
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
    <div className="flex flex-col gap-2.5 w-[72px] flex-shrink-0">
      {starters.map((s) => {
        const name = names.get(s.itemId) ?? `Item #${s.itemId}`;
        const pct = formatSharePct(denom > 0 ? s.count / denom : 0);
        return (
          <button
            key={s.itemId}
            type="button"
            onClick={() => onClick(s.itemId)}
            aria-label={`View details for ${name} — a starting item choice in ${s.count} of ${denom} pro games (${pct})`}
            className="flex flex-col items-center text-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform"
          >
            <span className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center">
              <IconWithFallback src={icon(s.itemId)} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
            </span>
            <span className="text-[10px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[24px]">{name}</span>
            <span className="text-[10.5px] font-bold tabular-nums text-teal">{pct}</span>
            <span className="text-[9.5px] text-mut/70 tabular-nums">{s.count}/{denom}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 2026-07-26 — ONE grid slot for the support-quest FINAL family (user bug,
 *  screenshot-confirmed: the ITEMS grid showed Zaz'Zak's Realmspike 80% AND
 *  Solstice Sleigh 20% at once, two of six slots spent on a single choice).
 *  Only ONE of the five finals can ever be owned — Bounty of Worlds upgrades
 *  into exactly one — so this renders the modal pick as the primary tile with
 *  the runners-up stacked beneath it, labelled as the alternatives they are.
 *
 *  Visually a BootsStackTile (same w-[72px] column, same w-11 h-11 / size=44
 *  tiles, so it reflows in the same flex-wrap Items row and matches the boots
 *  and starter stacks beside it). Two deliberate differences:
 *   - an "or" rule between the top pick and the alternatives, because these
 *     entries are MUTUALLY EXCLUSIVE, where stacked boots/starters are merely
 *     a split preference among things a build could in principle contain;
 *   - alternatives render dimmed (opacity-70) and say so in their aria-label,
 *     so the primary reads as the pick rather than as first-of-a-list.
 *  Each entry keeps its OWN honest percentage against the same `denom` — the
 *  fractions are never summed into a combined family stat (see
 *  proConsensus.ts's `supportFinals` doc comment). */
function SupportFinalStackTile({
  top,
  alternatives,
  denom,
  names,
  icon,
  onClick,
}: {
  top: { itemId: number; count: number };
  alternatives: { itemId: number; count: number }[];
  denom: number;
  names: Map<number, string>;
  icon: (itemId: number) => string;
  onClick: (itemId: number) => void;
}) {
  const tile = (entry: { itemId: number; count: number }, isAlternative: boolean) => {
    const name = names.get(entry.itemId) ?? `Item #${entry.itemId}`;
    const pct = formatSharePct(denom > 0 ? entry.count / denom : 0);
    return (
      <button
        key={entry.itemId}
        type="button"
        onClick={() => onClick(entry.itemId)}
        aria-label={
          isAlternative
            ? `View details for ${name} — an alternative support-quest upgrade, built in ${entry.count} of ${denom} pro games (${pct})`
            : `View details for ${name} — the most-built support-quest upgrade, in ${entry.count} of ${denom} pro games (${pct})`
        }
        className={`flex flex-col items-center text-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform ${
          isAlternative ? "opacity-70" : ""
        }`}
      >
        <span className="w-11 h-11 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center">
          <IconWithFallback src={icon(entry.itemId)} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={44} />
        </span>
        <span className="text-[10px] text-txt mt-1.5 leading-tight line-clamp-2 min-h-[24px]">{name}</span>
        <span className="text-[10.5px] font-bold tabular-nums text-teal">{pct}</span>
        <span className="text-[9.5px] text-mut/70 tabular-nums">{entry.count}/{denom}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-2.5 w-[72px] flex-shrink-0">
      {tile(top, false)}
      {alternatives.length > 0 && (
        <>
          {/* "or", not a bare gap — these are mutually exclusive, and the
              card should say so rather than leave the reader to infer it
              from two stacked icons. aria-hidden: the exclusivity is already
              carried explicitly in each alternative's aria-label above. */}
          <span aria-hidden="true" className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.1em] text-mut/50">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </span>
          {alternatives.map((a) => tile(a, true))}
        </>
      )}
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

/* RUNE DISPLAY ORDER IS THE TREE ROW, NEVER THE PICK RATE (2026-07-29).
 *
 * USER BUG (screenshot, a Domination page): the card rendered Electrocute ->
 * Ultimate Hunter -> Taste of Blood -> Grisly Mementos. Nothing was wrong with
 * the data — `primaryMinors.entries` arrives sorted by COUNT (proConsensus.ts's
 * `sortEntries`) and Ultimate Hunter was simply the most-picked minor. But it
 * sits in Domination's LAST minor row, so a frequency sort printed the bottom
 * of the tree in second position. This card's whole claim (v0.28.0: "runes are
 * set as in game") is that it reads like the in-game page, and an in-game page
 * is read top to bottom. The percentage stays on every tile, so sorting by row
 * instead of by rate loses nothing.
 *
 * `sortPerksByRow` (perkSlots.ts) is the shared resolver — a pure lookup over
 * the static PERK_TREES snapshot, NO fetch anywhere in the path, so this order
 * cannot be broken by a failed request. It is the same map the rune-APPLY path
 * has used for slot coherence since 2026-07-22, so display order and applied
 * order cannot disagree. Unknown ids sort to the end deterministically.
 *
 * Display-only: it returns a new array, so the model the apply path reads is
 * untouched. */

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

export default function ProConsensusCard({ champ, lane, ver, onOpenDetail, build, variant = "pro" }: ProConsensusCardProps) {
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
      const url =
        variant === "otp"
          ? `/api/otp?championId=${champ.id}&role=${role}&limit=${OTP_AGGREGATION_LIMIT}${bust}`
          : `/api/pros?championId=${champ.id}&role=${role}&limit=${AGGREGATION_LIMIT}&proMin=${PRO_PLAY_FLOOR}&source=all${bust}`;
      Promise.all([
        fetch(url).then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: ProGamesApiResponse & Partial<OtpResponse> = await res.json();
          return {
            games: Array.isArray(data?.games) ? data.games : [],
            players: Array.isArray(data?.players) ? data.players : [],
            pending: data?.pending === true,
          };
        }),
        // Belt-and-braces despite getItemDetailMap's own internal catch: the
        // item map must NEVER be able to sink the whole card.
        getItemDetailMap(ver).catch(() => new Map<number, ItemDetail>()),
      ])
        .then(([payload, itemMeta]) => {
          if (cancelled) return;
          const { games, players, pending } = payload;
          if (games.length === 0) {
            // OTP only: nothing stored for this champion yet, so ask the
            // server to go get it. Same pull-freshness-to-the-moment-of-
            // interest design as POST /api/pros/refresh — a background sweep
            // cannot keep ~170 champions current, but the champion someone is
            // actually looking at is worth one budgeted pass.
            //
            // Fire-and-forget on PURPOSE: it takes tens of seconds (every
            // Riot call is paced at 1.3s) so there is nothing to await into
            // this render, the route is cooldown-gated server-side against
            // re-renders and multiple devices, and a failure must never turn
            // an empty card into an error card. The data appears on a later
            // visit, which is what the "pending" copy tells the user.
            if (variant === "otp") {
              void fetch(
                `/api/otp/refresh?championId=${champ.id}&championKey=${encodeURIComponent(champ.key)}`,
                { method: "POST" }
              ).catch(() => {});
            }
            setState({ status: pending ? "pending" : "hidden" });
            return;
          }
          setState({
            status: "ok",
            model: aggregateProConsensus(games, itemMeta),
            itemMeta,
            otpPlayers: players,
          });
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
  }, [champ.id, champ.key, lane, ver, retryToken, variant]);

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

  const isOtp = variant === "otp";
  const cardTitle = isOtp ? "OTP Consensus" : "Pro Consensus";

  if (state.status === "loading") return <ConsensusSkeleton />;
  if (state.status === "hidden") return null;
  // OTP only. Says exactly what is true — we know who the one-tricks are, we
  // don't have their games yet — instead of the "hidden" render, which would
  // silently imply this champion has no one-tricks.
  if (state.status === "pending") {
    return (
      <div className="bg-panel border border-line rounded-xl p-5">
        <CardHeader>{cardTitle}</CardHeader>
        <p className="text-[10.5px] text-mut/60 mt-3" role="status">
          One-tricks found for {champ.name}, but their games haven&apos;t been pulled in yet. Check
          back shortly.
        </p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="text-[10.5px] text-mut/50 px-0.5" role="status">
        {cardTitle} data couldn&apos;t load ({state.reason}).{" "}
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
  // 2026-07-25 (P1-2 fix) — the footer used to read as if EVERY fraction on
  // the card (including the items/boots/starting grid above it) was against
  // gamesTotal. That's still true for keystone/spells/tournament mix, but
  // items/boots/starting now divide by itemsSampleSize (live-ingested
  // prostage rows carry no item data yet — see proConsensus.ts's
  // itemsSampleSize doc comment), so a card whose sample includes several
  // itemless rows would otherwise claim item coverage it doesn't have. Only
  // rendered when the two denominators actually diverge (the common case —
  // an all-soloq or fully-backfilled prostage sample — stays a single line).
  const itemsCoverageNote =
    model.itemsSampleSize === model.gamesTotal
      ? ""
      : model.itemsSampleSize > 0
        ? ` · items/boots/starting from ${model.itemsSampleSize} game${model.itemsSampleSize === 1 ? "" : "s"} with item data`
        : " · no item data in this sample yet";
  // The OTP footer names the actual roster instead of a source split: every
  // OTP row is ranked solo queue, so "(N pro play, M solo queue)" would be
  // noise, and "one-tricks" is a claim the user should be able to CHECK.
  // Player count and per-player minimum both come from the returned rows, so
  // the line can never describe a roster the sample didn't come from.
  const otpContributors = state.otpPlayers.filter((p) => p.gamesInSample > 0);
  const otpMinPlays = otpContributors.length
    ? Math.min(...otpContributors.map((p) => p.championPlays))
    : 0;
  const otpNote = otpContributors.length
    ? ` · ${otpContributors.length} one-trick${otpContributors.length === 1 ? "" : "s"}${
        otpMinPlays > 0 ? `, each ${otpMinPlays}+ games on ${champ.name}` : ""
      }`
    : "";
  const sampleLine = isOtp
    ? `From ${model.gamesTotal} ranked game${model.gamesTotal === 1 ? "" : "s"}${otpNote} · fresh window${itemsCoverageNote}`
    : `From ${model.gamesTotal} pro game${model.gamesTotal === 1 ? "" : "s"} (${sourceNote}) · fresh window${
        tournamentNote ? ` · ${tournamentNote}` : ""
      }${itemsCoverageNote}`;

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
      <div className="flex items-start justify-between gap-3 mb-3.5">
        <CardHeader>{cardTitle}</CardHeader>
        {/* 2026-07-22 (manual pro push) — visually parallel to
            RunesSummonersCard's Apply-runes/Add-item-builds pair, same
            visibility gate (hasSession(), checked inside each button so a
            build without a live session renders neither). `build` is
            optional (same degrade-quietly convention as the rest of this
            tab) — omitting it just hides both buttons.

            Rendered on BOTH variants since 2026-07-28. v0.70.0 shipped the OTP
            card read-only on the belief that a third rune page needed a
            companion-side change; re-reading `Invoke-ApplyRunes` showed that
            was wrong. The companion is title-agnostic beyond a
            starts-with-"CoachBuild" gate, targets its page by EXACT title, and
            protects every page sharing the champ prefix — so `pageSuffix:"OTP"`
            works against the ALREADY-INSTALLED companion with no re-install.
            The item side needed no companion change either: the OTP line is a
            BLOCK inside the existing one-set-per-champion+role document, not a
            new set. See ApplyProRunesButton's `variant` doc for the slot-
            pressure consequence, which is real but degrades correctly. */}
        {build && (
          <div className="flex items-start gap-2.5">
            <ApplyProRunesButton
              champ={champ}
              roleLabel={build.roleLabel}
              model={model}
              fallbackShards={build.runes.shards}
              variant={variant}
            />
            <AddProItemBuildButton
              champ={champ}
              lane={lane}
              roleLabel={build.roleLabel}
              build={build}
              variant={variant}
            />
          </div>
        )}
      </div>

      {lowSample && (
        <p className="text-[10.5px] text-gold/70 -mt-2 mb-3.5 flex items-center gap-1">
          <span aria-hidden="true">⚠</span>
          Low sample size — treat these fractions with caution.
        </p>
      )}

      {/* v0.63.2 (desktop Pro Consensus sprawl fix) — this card's row went
          from ~466px (narrow right column, pre-v0.63.1) to 1138px full-width
          (v0.63.1's bottom-rag fix), but its own content was never adapted:
          the ITEMS block is flex-wrap and only ever needed ~480px, so it
          left ~45% of the row empty; the rune/summoner grid below it used
          fr-stretched columns (md:grid-cols-[1.5fr_1.1fr_auto]) that
          stretched to fill the full row and scattered Primary/Secondary/
          Summoners apart with large dead gaps between them. Fix: split
          Starting+Items and the rune/summoner grid into two REAL side-by-
          side columns at `lg`+ (measured against the actual content, not a
          guess — ITEMS content maxes out well under half the row, the
          rune/summoner group needs the other ~60% once its own columns stop
          stretching, see the lg:grid-cols-[auto_auto_auto] override in the
          IIFE below). This wrapper carries NO un-prefixed grid/flex classes
          — below `lg` it is a plain block and both children stack exactly
          as before (byte-identical to pre-v0.63.2). */}
      {/* 2026-07-29 — RUNES NOW COME FIRST, matching the WPA build page.
          The BUILD tab's own order is Runes & Summoners -> Item Build -> Skill
          Order (BuildTabContent.tsx: DOM order below `lg`, and the
          `'runes_itembuild'` template at `lg`+). This card had the opposite
          order, so a user moving between the BUILD and PRO tabs met the same
          two sections in reverse. User directive: "just like the template for
          the regular build WPA page."

          The split is `5fr_7fr` — the BUILD tab's own proportions, arrived at
          by MEASURING rather than by copying. v0.63.2 gave the rune group the
          wider track on the reasoning that it "needs the other ~60%". That was
          true when it sat on the RIGHT of a taller item column; with the order
          flipped it stops being true, because the tall column is now the one
          that has to be fed. Measured live on Viktor mid @1440x900, all three
          splits, computed heights:

            7fr_5fr  runes 272px / items 615px -> card 747px (343px dead)
            6fr_6fr  runes 503px / items 614px -> card 746px (111px dead)
            5fr_7fr  runes 503px / items 500px -> card 635px (~3px dead)

          No horizontal overflow in ANY of the three (the inner rune grid's
          scrollWidth equalled its clientWidth every time) — the rune group
          simply wraps to a second row at 440px, which costs 231px of height
          and buys 176px for the item grid, which saves more than that. So the
          card is 112px shorter AND better balanced, and it now matches the
          BUILD tab's column proportions as well as its section order. Below
          `lg` this wrapper is a plain block and the children stack in DOM
          order. */}
      <div className="lg:grid lg:grid-cols-[5fr_7fr] lg:gap-x-10 lg:items-start">
        <div>
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
        // v0.63.2: `lg:grid-cols-[auto_auto_auto] lg:justify-start` overrides
        // the md:1.5fr/1.1fr/auto fr-stretch ONLY at `lg`+ (this card's own
        // column is now narrower than the full row there — see the split
        // above). Verified via computed style (Chrome): with three `auto`
        // tracks and no `fr` track present, the grid sizing algorithm still
        // distributes the container's free space across all three columns
        // in the Maximize Tracks step, but PROPORTIONAL TO EACH COLUMN'S OWN
        // max-content contribution — a heavier column (e.g. a 4-tile Primary
        // rune row) claims more of the extra space than a 2-tile Summoners
        // column, unlike the old fixed 1.5fr/1.1fr/auto ratio which had NO
        // relationship to actual content and produced arbitrary, unrelated
        // gaps. Screenshot-verified across three champion shapes (Brand
        // support, Viktor mid, Ornn top) — the proportional growth reads as
        // evenly distributed, not stretched-then-abandoned. Below `lg`
        // (including the existing md/tablet range) this is untouched — same
        // 1.5fr/1.1fr/auto stretch as before.
        <div className="grid grid-cols-1 md:grid-cols-[1.5fr_1.1fr_auto] lg:grid-cols-[auto_auto_auto] lg:justify-start gap-x-8 gap-y-5 mb-1">
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
                {/* Tree-row order, not pick-rate order — see the note above. */}
                {sortPerksByRow(model.primaryTree, model.primaryMinors.entries, (e) => e.runeId).map((e) => (
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
                  {/* Same rule as the primary minors: a secondary pick's row is
                      where it sits in ITS tree, and the two picks a page runs
                      come from two different rows, so the row index orders them
                      exactly as the client draws them. `secondaryTree` is
                      guaranteed non-null inside this branch. */}
                  {sortPerksByRow(secondaryTree?.treeId ?? null, model.secondaryPicks.entries, (e) => e.runeId).map((e) => (
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
        </div>

        {/* Starting + Items — SECOND now (see the wrapper's own comment).
            `mt-5 lg:mt-0`: below `lg` this used to be the first child and
            needed no top margin. Stacked under the rune grid it does — the
            rune grid ends on `mb-1` (4px), which was fine as a gap before the
            card's footer rule but reads as collision against a new section
            heading. 20px matches the rune grid's own `gap-y-5` row rhythm, so
            the mobile stack keeps one spacing scale throughout. At `lg`+ these
            are side-by-side grid columns and the margin is removed. */}
        <div className="mt-5 lg:mt-0">
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
                {/* denom is itemsSampleSize, NOT gamesTotal (2026-07-25 P1-2 fix)
                    — see proConsensus.ts's ProConsensusModel.itemsSampleSize doc
                    comment. Live-ingested prostage rows write finalItems=[], so
                    dividing by every game in the sample understated every
                    item/boots/starter percentage by the itemless-row share. */}
                <StartersStackTile
                  starters={model.starters}
                  denom={model.itemsSampleSize}
                  names={names.items}
                  icon={(id) => itemIconUrl(id, ver)}
                  onClick={(id) => onOpenDetail("item", id)}
                />
              </div>
            </div>
          )}

          {(model.items.length > 0 || model.boots.length > 0 || model.supportFinals !== null) && (
            <div className="mb-4 lg:mb-0">
              <p className="text-[10px] tracking-[0.1em] uppercase text-mut/80 font-semibold mb-2">Items</p>
              {/* flex-wrap, not overflow-x-auto — matches CoreBuildOrderCard/
                  SituationalCard's own item-row convention on this tab (no
                  horizontal scroll strips anywhere on BUILD), so tiles reflow
                  to a second row instead of hiding behind a scrollbar at 390px.
                  v0.28.0: boots render as ONE stacked slot (see BootsStackTile)
                  instead of eating two separate item slots. Now that this
                  block is its OWN column (v0.63.2, ~40% of the row instead of
                  the full width), wrapping to a second row here is expected
                  and reads as an honest icon grid, not sprawl. */}
              <div className="flex flex-wrap gap-2.5">
                {model.boots.length > 0 && (
                  <BootsStackTile
                    boots={model.boots}
                    denom={model.itemsSampleSize}
                    names={names.items}
                    icon={(id) => itemIconUrl(id, ver)}
                    onClick={(id) => onOpenDetail("item", id)}
                  />
                )}
                {/* 2026-07-26 — the support-quest final family as ONE slot,
                    beside the boots stack and ahead of the main items (it is a
                    single core build decision for the role, not a filler slot).
                    Absent entirely — no empty block — when the sample never
                    built one, same convention as boots/starters. */}
                {model.supportFinals && (
                  <SupportFinalStackTile
                    top={model.supportFinals.top}
                    alternatives={model.supportFinals.alternatives}
                    denom={model.itemsSampleSize}
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
                    denom={model.itemsSampleSize}
                    name={names.items.get(entry.itemId) ?? `Item #${entry.itemId}`}
                    icon={itemIconUrl(entry.itemId, ver)}
                    onClick={() => onOpenDetail("item", entry.itemId)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {additionalRuneNotes.length > 0 && (
        <p className="text-[9.5px] text-mut/50 mt-1 mb-1">{additionalRuneNotes.join(" · ")}</p>
      )}

      <p className="text-[10px] text-mut/70 mt-3.5 pt-3 border-t border-line">{sampleLine}</p>
    </div>
  );
}
