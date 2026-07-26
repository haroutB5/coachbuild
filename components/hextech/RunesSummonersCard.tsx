"use client";

import { useEffect, useState } from "react";
import type { RunesBlock, Pick as PickType, BuildResponse } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import type { EntityKind } from "@/components/EntityDetailPopover";
import { wpaClass, wpaText } from "@/components/StatBadge";
import { IconWithFallback } from "@/components/IconWithFallback";
import { buildRunesPageModel } from "./runesPage";
import { buildRuneApplyBody } from "./runeApplyBody";
import { applyItemSetsForBuild } from "./itemSetsApply";
import { hasSession, getStoredSession, getStoredPort, applyRunes } from "@/components/live/companionClient";

function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">
      {children}
    </p>
  );
}

type ApplyUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** v0.32.0 (Live mode, plan §2c): companion-connected "Apply runes" action —
 *  strictly user-clicked (compliance guardrail, plan §3: applyRunes is only
 *  ever invoked from this onClick, never from a poll/effect). Gated on
 *  companionClient.hasSession() (checked in a post-mount effect below, not
 *  during render, to avoid an SSR/client hydration mismatch on a
 *  localStorage read — same pattern as BuildTabContent's rankHydrated) AND
 *  on the caller actually supplying
 *  championName/roleLabel — both optional so any OTHER future caller of this
 *  card that doesn't have them degrades to exactly today's behavior (no
 *  button rendered at all). */
function ApplyRunesButton({
  championName,
  roleLabel,
  runes,
}: {
  championName: string;
  roleLabel: string;
  runes: RunesBlock;
}) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ApplyUiState>({ status: "idle" });

  useEffect(() => {
    setReady(hasSession());
  }, []);

  async function handleClick() {
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState({
        status: "error",
        message: "Companion not connected — open /live-setup and reconnect.",
      });
      return;
    }

    let body: ReturnType<typeof buildRuneApplyBody>;
    try {
      body = buildRuneApplyBody(championName, roleLabel, runes);
    } catch {
      setState({
        status: "error",
        message: "Couldn't build a rune page from this build — try refreshing.",
      });
      return;
    }

    setState({ status: "applying" });
    // Manual mode: this is the click-through consent path, keeps the
    // original "may replace whatever page is currently selected" behavior
    // when there's no CoachBuild page to replace and no free slot.
    const result = await applyRunes(port, session, body, "manual");
    if (result.ok) {
      // v1.3.0: a 2xx no longer implies full success on its own — the page
      // creation itself always worked here (companion only returns ok:true
      // once it has), but selection/verification can still fail (e.g. the
      // post-create selection PUT didn't stick) and deserve an honest,
      // distinct message rather than a blanket "Applied."
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
        disabled={state.status === "applying"}
        className="flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover disabled:opacity-60 disabled:cursor-not-allowed rounded-md px-2.5 py-1.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        {state.status === "applying" ? "Applying…" : "Apply runes"}
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
    </div>
  );
}

type ItemSetsUiState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/** "Add item builds" — the manual counterpart to the champ-select
 *  auto-export effect (BuildTabContent.tsx). Both call the SAME
 *  applyItemSetsForBuild (itemSetsApply.ts) so there's exactly one
 *  implementation of "resolve pro-consensus data, build sets, POST them."
 *  Gated on hasSession() same as Apply runes, but item-set writes are NOT
 *  compliance-restricted to user-clicks the way rune apply is (see
 *  companion.ps1's compliance header) — this button exists for the
 *  non-deep-link case (a manual visit) and as a way to re-export on demand. */
function ItemSetsButton({
  champ,
  lane,
  roleLabel,
  build,
}: {
  champ: BuildResponse["champion"];
  lane: LaneId;
  roleLabel: string;
  build: BuildResponse;
}) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ItemSetsUiState>({ status: "idle" });

  useEffect(() => {
    setReady(hasSession());
  }, []);

  async function handleClick() {
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) {
      setState({
        status: "error",
        message: "Companion not connected — open /live-setup and reconnect.",
      });
      return;
    }

    setState({ status: "applying" });
    const result = await applyItemSetsForBuild({ champ, lane, roleLabel, build, port, session });
    if (result.ok) {
      setState({
        status: "success",
        // v0.34.1: always exactly one champ+role item set now (Core/
        // Optimized/Pro/Situational are blocks inside it, not separate
        // sets) — result.count is always 1, so the copy is a flat
        // singular rather than the old pluralized "N item builds".
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

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={state.status === "applying"}
        className="flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-txt bg-panel2 border border-line hover:border-line-gold disabled:opacity-60 disabled:cursor-not-allowed rounded-md px-2.5 py-1.5 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        {state.status === "applying" ? "Adding…" : "Add item builds"}
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

function TreeLabel({ icon, name }: { icon: string; name: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="w-5 h-5 rounded-full bg-black/20 overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback src={icon} alt={name} fallbackGlyph={name} className="w-full h-full object-contain" size={20} />
      </span>
      <span className="text-[11.5px] text-txt font-semibold">{name}</span>
    </div>
  );
}

// Quiet, dim caution glyph for a low-sample pick — matches RunePage.tsx /
// ItemPath.tsx's own local copy. Not shared as a component (see
// StatBadge.tsx's header comment on why the vitest oxc/JSX split keeps these
// duplicated per-file rather than extracted into a pure-logic module).
function LowSampleFlag() {
  return (
    <span title="Low sample size — treat this pick with caution" aria-label="low sample size" className="text-gold/70">
      ⚠
    </span>
  );
}

const TAP_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-95 transition-transform";

interface RuneTileProps {
  pick: PickType;
  isKeystone?: boolean;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

function RuneTile({ pick, isKeystone, onOpenDetail }: RuneTileProps) {
  const dim = isKeystone
    ? "w-14 h-14 border-2 border-teal shadow-[0_0_14px_rgba(130,219,247,0.3)]"
    : "w-10 h-10 border border-line";
  const pxSize = isKeystone ? 56 : 40;

  return (
    <button
      type="button"
      onClick={() => onOpenDetail("rune", pick.id)}
      aria-label={`View details for rune ${pick.name}`}
      className={`group flex flex-col items-center text-center w-[64px] gap-1 rounded-md ${TAP_RING}`}
    >
      <span
        className={`${dim} rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105`}
      >
        <IconWithFallback
          src={pick.icon}
          alt={pick.name}
          fallbackGlyph={pick.name}
          className="w-full h-full object-contain"
          size={pxSize}
        />
      </span>
      {/* v0.44.0 (Builds responsive plan §2d): uniform tile width (w-[64px],
          was w-[68px]) so two tiles fit a 390px half-column, and a taller
          min-h (24px -> 28px) + break-words for the now-narrower name
          column — applied identically to every RuneTile render (keystone and
          minors alike), never varied per call site. */}
      <span className="text-[10px] text-txt leading-tight line-clamp-2 min-h-[28px] break-words">{pick.name}</span>
      <span className={`text-[11px] font-bold tabular-nums flex items-center gap-0.5 ${wpaClass(pick.wpa)}`}>
        {wpaText(pick.wpa)}
        {pick.lowSample && <LowSampleFlag />}
      </span>
    </button>
  );
}

interface ShardTileProps {
  label: string;
  pick: PickType;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

function ShardTile({ label, pick, onOpenDetail }: ShardTileProps) {
  return (
    <button
      type="button"
      onClick={() => onOpenDetail("shard", pick.id)}
      aria-label={`View details for stat shard ${pick.name}`}
      className={`flex flex-col items-center text-center w-14 gap-1 rounded-md ${TAP_RING}`}
    >
      <span className="w-8 h-8 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={pick.icon}
          alt={pick.name}
          fallbackGlyph={pick.name}
          className="w-full h-full object-contain p-1"
          size={32}
        />
      </span>
      <span className="text-[9px] text-mut leading-tight">{label}</span>
    </button>
  );
}

interface SummonerTileProps {
  spell: PickType;
  onOpenDetail: (kind: EntityKind, id: number) => void;
}

function SummonerTile({ spell, onOpenDetail }: SummonerTileProps) {
  return (
    <button
      type="button"
      onClick={() => onOpenDetail("spell", spell.id)}
      aria-label={`View details for summoner spell ${spell.name}`}
      title={`WPA ${wpaText(spell.wpa)}`}
      className={`flex items-center gap-2 rounded-lg ${TAP_RING}`}
    >
      <span className="w-9 h-9 rounded-[8px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
        <IconWithFallback
          src={spell.icon}
          alt={spell.name}
          fallbackGlyph={spell.name}
          className="w-full h-full object-contain"
          size={36}
        />
      </span>
      <span className="text-[11.5px] text-txt font-medium leading-tight">{spell.name}</span>
    </button>
  );
}

interface RunesSummonersCardProps {
  runes: RunesBlock;
  spells: PickType[];
  onOpenDetail: (kind: EntityKind, id: number) => void;
  /** v0.32.0 (Live mode): champion display name + role label for the
   *  Apply-runes rune-page NAME (`CoachBuild <champ> <role>`) — sourced from
   *  the already-fetched BuildResponse (build.champion.name / build.roleLabel)
   *  by BuildTabContent.tsx, the one caller. Optional: omitting either hides
   *  the Apply-runes button entirely (see ApplyRunesButton), so any other
   *  caller of this card keeps rendering exactly as before. */
  championName?: string;
  roleLabel?: string;
  /** v2026-07-20 (item-sets feature): the full BuildResponse + its LaneId —
   *  needed by the "Add item builds" button (itemSetsApply.ts's
   *  applyItemSetsForBuild needs the whole build to derive Core/Optimized
   *  sets, plus lane to query pro-consensus by role). Optional, same
   *  degrade-quietly convention as championName/roleLabel above — omitting
   *  either hides just this button, Apply runes is unaffected. */
  build?: BuildResponse;
  lane?: LaneId;
}

export default function RunesSummonersCard({
  runes,
  spells,
  onOpenDetail,
  championName,
  roleLabel,
  build,
  lane,
}: RunesSummonersCardProps) {
  const model = buildRunesPageModel(runes);

  return (
    // v0.63.1 (desktop bottom-rag fix): `lg:h-full` fills the grid row's
    // stretched height (BuildTabContent's [grid-area:runes] wrapper is
    // already a stretched grid item by default — this card's own root just
    // never claimed that height before, leaving the visible border short of
    // the ITEM BUILD card beside it). `lg:flex lg:flex-col` establishes the
    // formatting context so the extra height reads as a single continuous
    // bordered panel (content anchored top, breathing room below, INSIDE
    // the card's own border) rather than a gap floating between two cards.
    // No-op below `lg` (mobile stack / the /compact route, neither a
    // stretched grid item) and no-op against an auto-height ancestor per
    // the CSS height:100% spec, so this never affects mobile or /compact.
    <div className="bg-panel border border-line rounded-xl p-5 lg:h-full lg:flex lg:flex-col">
      <div className="flex items-start justify-between gap-3 mb-3.5">
        <CardHeader>Runes &amp; Summoners</CardHeader>
        <div className="flex items-start gap-2.5">
          {championName && roleLabel && (
            <ApplyRunesButton championName={championName} roleLabel={roleLabel} runes={runes} />
          )}
          {build && lane && roleLabel && (
            <ItemSetsButton champ={build.champion} lane={lane} roleLabel={roleLabel} build={build} />
          )}
        </div>
      </div>

      {/* v0.44.0 (Builds responsive plan §2d): was
          grid-cols-1 md:grid-cols-[1.5fr_1.1fr_auto] — fr columns stretched
          while the small left-packed tiles didn't, leaving dead space, and
          the auto summoner column floated far right. Now: mobile packs
          primary+secondary trees side by side (2 cols, tiles fit ~180px each
          half at 390px) with summoners as a full-width third row, roughly
          halving the card's mobile height; md+ reverts to 3 content-sized
          columns (auto), summoners back to the right, justify-start so they
          don't stretch to fill leftover width the way the old fr track did. */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-[auto_auto_auto] md:justify-start md:gap-x-10">
        {/* Primary tree: keystone (large) + 3 minors */}
        <div>
          <TreeLabel icon={model.primaryTree.icon} name={model.primaryTree.name} />
          <div className="flex flex-wrap items-end gap-2.5">
            <RuneTile pick={runes.keystone} isKeystone onOpenDetail={onOpenDetail} />
            {model.primaryMinors.map((p) => (
              <RuneTile key={p.id} pick={p} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        </div>

        {/* Secondary tree: 2 picks + stat shards. v0.63.1 (desktop
            bottom-rag fix, task 2): at `lg`+ the shard row gets its own
            "Shards" label + a hairline top divider (mirrors ItemBuildCard's
            divide-y rhythm between Starting/Core/Situational) instead of a
            bare `mb-4` gap that read as loosely tacked onto the rune row
            above it. The extra wrapping div carries ONLY `lg:` classes, so
            below `lg` (mobile + the existing md-tablet 3-col shape) it's an
            unstyled div around the same shard row — zero box-model change,
            byte-identical rendered height to before. */}
        <div>
          <TreeLabel icon={model.secondaryTree.icon} name={model.secondaryTree.name} />
          <div className="flex flex-wrap gap-2.5 mb-4 lg:mb-0">
            {model.secondaryPicks.map((p) => (
              <RuneTile key={p.id} pick={p} onOpenDetail={onOpenDetail} />
            ))}
          </div>
          <div className="lg:mt-4 lg:pt-4 lg:border-t lg:border-line/60">
            <div className="hidden lg:block lg:mb-2">
              <CardHeader>Shards</CardHeader>
            </div>
            <div className="flex gap-2.5">
              {model.shards.map((s) => (
                <ShardTile key={`${s.label}-${s.pick.id}`} label={s.label} pick={s.pick} onOpenDetail={onOpenDetail} />
              ))}
            </div>
          </div>
        </div>

        {/* Summoner spells: full-width third row on mobile (col-span-2),
            back to its own column on md+. v0.63.1: at `lg`+ this column gets
            its own "Summoners" label (mirrors the Primary/Secondary tree
            labels) and top-aligns (`lg:justify-start`) instead of
            `md:justify-center`, which vertically centered the tiles against
            the combined Secondary+Shards column height and made them read
            as floating, disconnected from the rune rows beside them. Below
            `lg` (mobile + md-tablet) keeps the exact pre-existing shape —
            the label is `hidden` there and `md:justify-center` still wins
            in the 768-1023px range since `lg:justify-start` only overrides
            at `lg`+. */}
        <div className="col-span-2 md:col-span-1">
          <div className="hidden lg:block lg:mb-3">
            <CardHeader>Summoners</CardHeader>
          </div>
          <div className="flex flex-row gap-2 md:flex-col md:justify-center lg:justify-start">
            {spells.map((spell) => (
              <SummonerTile key={spell.id} spell={spell} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
