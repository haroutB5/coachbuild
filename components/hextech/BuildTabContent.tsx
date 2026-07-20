"use client";

import { useEffect, useState, useCallback } from "react";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { LANE_TO_ROLE_ID, LANE_LABEL } from "./heroContracts";
import RunesSummonersCard from "./RunesSummonersCard";
import StartingCard from "./StartingCard";
import CoreBuildOrderCard from "./CoreBuildOrderCard";
import SituationalCard from "./SituationalCard";
import ProConsensusCard from "./ProConsensusCard";
import { versionFromPatch } from "@/components/proAssets";
import { getStoredSession, getStoredPort, getAutoItemSetsEnabled, getAutoRunesEnabled } from "@/components/live/companionClient";
import { autoApplyItemSetsIfEligible } from "./itemSetsApply";
import { autoApplyRunesIfEligible } from "./runeAutoApply";
import {
  getChampSelectPhaseEpoch,
  shouldAutoExportForLane,
  markAutoExported,
  isCompanionDrivenChampion,
  tryClaimAutoExportLock,
} from "@/components/live/champSelectFollowState";
import ItemDetailPopover from "@/components/ItemDetailPopover";
import EntityDetailPopover, { type EntityKind } from "@/components/EntityDetailPopover";
import { useBodyScrollLock } from "@/components/useBodyScrollLock";
import SegmentedControl from "@/components/SegmentedControl";
import { RANK_BRACKETS, DEFAULT_RANK_BRACKET, RANK_FILTERING_SUPPORTED } from "@/lib/rankBrackets";
import { readStoredRankBracketId, writeStoredRankBracketId } from "./rankBracketStorage";

/** Which tap-for-detail popover is open — items share the "item" kind,
 *  runes/shards/summoner spells route through EntityDetailPopover's own
 *  EntityKind. Mirrors GameDetailSheet's activeDetail/lastDetail pattern:
 *  `lastDetail` is NOT cleared on close so the popover can play its own
 *  exit transition instead of being yanked from the tree mid-fade; `open`
 *  is driven by `activeDetail !== null`. This is overlay state only — never
 *  history-backed (v0.23.0 policy: popovers aren't a nav step). */
type DetailRef = { kind: "item" | EntityKind; id: number };

interface BuildTabContentProps {
  champ: ChampionRef;
  lane: LaneId;
  /** Fires once a build response resolves, so the sidebar footer can show
   *  the resolved data patch without a second fetch. */
  onPatchResolved?: (patch: string) => void;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; build: BuildResponse }
  | { status: "empty" }
  | { status: "error" };

function CardSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-panel border border-line rounded-xl p-5 animate-pulse ${className}`}>
      <div className="h-2.5 w-28 bg-panel2 rounded mb-4" />
      <div className="flex gap-3">
        <div className="w-12 h-12 rounded-full bg-panel2" />
        <div className="space-y-2 flex-1">
          <div className="h-3 w-24 bg-panel2 rounded" />
          <div className="h-2.5 w-12 bg-panel2 rounded" />
        </div>
      </div>
    </div>
  );
}

function BuildLoadingSkeleton() {
  return (
    <div className="space-y-5">
      <CardSkeleton />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <CardSkeleton />
        <CardSkeleton className="md:col-span-2" />
      </div>
      <CardSkeleton />
    </div>
  );
}

/** Feature 3 (rank brackets) — compact selector rendered near the champion/
 *  lane pickers (ChampionHero/HextechTabs sit just above this tab's content
 *  on app/page.tsx). Rendered in every fetch state (loading/empty/error/ok)
 *  so a user who picks a bracket with no data for this champ+lane can switch
 *  right back without losing their place. Hidden entirely when
 *  RANK_FILTERING_SUPPORTED is false (defensive — see lib/rankBrackets.ts). */
function RankBracketSelector({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  if (!RANK_FILTERING_SUPPORTED) return null;
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Rank bracket</p>
      <SegmentedControl
        ariaLabel="Filter build data by rank bracket"
        size="sm"
        value={value}
        onChange={onChange}
        options={RANK_BRACKETS.map((b) => ({ value: b.id, label: b.label }))}
      />
    </div>
  );
}

export default function BuildTabContent({ champ, lane, onPatchResolved }: BuildTabContentProps) {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [activeDetail, setActiveDetail] = useState<DetailRef | null>(null);
  const [lastDetail, setLastDetail] = useState<DetailRef | null>(null);

  // Feature 3 (rank brackets) — single source of truth for both the
  // selector's shown value AND the `rank=` fetch param below (never two
  // separate variables that could desync). Initialized to the default
  // bracket (matches SSR, since `window` doesn't exist there) and corrected
  // from localStorage in a mount-only effect — see rankBracketStorage.ts.
  // `rankHydrated` gates the fetch effect so a returning user with a
  // NON-default stored bracket doesn't briefly fetch (and flash) the
  // default bracket's build before the corrected value lands — the fetch
  // effect below waits one tick for this instead of firing twice.
  const [rankBracket, setRankBracket] = useState<string>(DEFAULT_RANK_BRACKET.id);
  const [rankHydrated, setRankHydrated] = useState(false);
  useEffect(() => {
    setRankBracket(readStoredRankBracketId());
    setRankHydrated(true);
  }, []);
  function handleRankChange(id: string) {
    setRankBracket(id);
    writeStoredRankBracketId(id);
  }

  function openDetail(kind: "item" | EntityKind, id: number) {
    setLastDetail({ kind, id });
    setActiveDetail({ kind, id });
  }
  function openItemPopover(id: number) {
    openDetail("item", id);
  }
  function closeDetail() {
    setActiveDetail(null);
  }

  // No enclosing sheet on this tab (unlike GameDetailSheet's popovers, which
  // sit over a page the sheet already scroll-locks) — lock body scroll
  // ourselves while a popover is mounted, iOS rubber-band-safe. Deliberately
  // NOT keyed on `lastDetail` (that flag is never cleared back to null once
  // a popover has ever been opened, by design — it just remembers which
  // kind/id to keep rendering through the exit fade) — a lock tied to it
  // would stay engaged for the rest of the tab's life after the FIRST tap.
  // Instead this mirrors DetailPopover's own internal rendered/visible
  // split: locked from open until its exit transition (150ms, matching
  // DetailPopover's EXIT_MS) finishes.
  const [popoverMounted, setPopoverMounted] = useState(false);
  useEffect(() => {
    if (activeDetail !== null) {
      setPopoverMounted(true);
      return;
    }
    const t = setTimeout(() => setPopoverMounted(false), 150);
    return () => clearTimeout(t);
  }, [activeDetail]);
  useBodyScrollLock(popoverMounted);

  // Escape closes the popover only — there's no enclosing modal here to
  // fall through to on a second press (contrast GameDetailSheet's two-stage
  // Escape handler).
  useEffect(() => {
    if (activeDetail === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDetail();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeDetail]);

  // v0.27.2 (bugfix — see HANDOFF-fronty.md's v0.27.2 entry): this fetch had
  // NO stale-response guard, unlike ProConsensusCard's own effect below
  // (which has always had a `cancelled` flag). A champ/lane change fires a
  // brand-new fetch on every render without cancelling the PREVIOUS one, so
  // two in-flight `/api/build` requests can resolve OUT OF ORDER — e.g. a
  // fresh champion pick (cache MISS, slow) immediately followed by a browser
  // back-navigation to the champion just left (cache HIT, near-instant): the
  // HIT applies first (correct), then the MISS resolves LATER and silently
  // overwrites it with the WRONG (superseded) champion's entire build —
  // runes/summoners/items all swap under the still-correct header, since
  // ChampionHero/Sidebar read the separate, correctly-guarded `champ`/
  // `activeLane` page state, not this component's own `state.build`.
  // Reproduced live on prod (Slow 3G, Viktor -> Ahri search -> immediate
  // back): `/api/build?champ=103...` (Ahri, MISS) landed after
  // `/api/build?champ=112...` (Viktor, HIT, age 1439s) and clobbered the
  // page with Ahri's Electrocute/Ignite build under the "VIKTOR" header.
  // Fixed with the exact same `cancelled`-closure pattern ProConsensusCard
  // already uses — every setState is guarded so a superseded response is
  // inert no matter which order the two requests actually resolve in.
  const load = useCallback(
    async (c: ChampionRef, l: LaneId, rank: string, isCancelled: () => boolean) => {
      setState({ status: "loading" });
      try {
        const roleId = LANE_TO_ROLE_ID[l];
        // Feature 3: `rank` is only appended when non-default — keeps the
        // historical default request byte-identical to before this feature
        // (same CDN/Next fetch-cache key), per the engine handoff's contract
        // note ("the 'all' default MUST be first... byte-identical to the
        // app's historical default").
        const rankParam = rank && rank !== DEFAULT_RANK_BRACKET.id ? `&rank=${rank}` : "";
        const res = await fetch(`/api/build?champ=${c.id}&role=${roleId}${rankParam}`);
        if (isCancelled()) return;
        if (res.status === 404) {
          setState({ status: "empty" });
          return;
        }
        if (!res.ok) {
          setState({ status: "error" });
          return;
        }
        const data: BuildResponse[] = await res.json();
        if (isCancelled()) return;
        if (!Array.isArray(data) || data.length === 0) {
          setState({ status: "empty" });
          return;
        }
        // Spec shows a single primary build, not the top-3 variant switcher
        // the legacy Builds page rendered — the #1 ranked setup only.
        setState({ status: "ok", build: data[0] });
        onPatchResolved?.(data[0].patch);
      } catch {
        if (!isCancelled()) setState({ status: "error" });
      }
    },
    [onPatchResolved]
  );

  useEffect(() => {
    // Wait for the mount-only localStorage read above (see rankHydrated's
    // own doc comment) — avoids a wasted/flashing fetch for the default
    // bracket when a returning user actually has a different one stored.
    if (!rankHydrated) return;
    let cancelled = false;
    load(champ, lane, rankBracket, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [champ, lane, rankBracket, rankHydrated, load]);

  // ── Auto-export: item sets (v1.2.0) + runes (v1.3.0) ─────────────────────
  //
  // v1.3.0: generalized from "once per deep-link page mount" to "once per
  // (champ-select session, championId)" — the companion no longer opens a
  // NEW tab on every hover (attached-tab live-follow, companion.ps1's
  // Test-CompanionHasAttachedTab), so this SAME component instance now sees
  // many champion changes within one champ-select, not just one at mount.
  //
  // v0.35.0 (user on-device evidence): that championId-only key never
  // re-fired on a LANE CHANGE for the SAME champion (e.g. Senna Bot ->
  // Support) — the game was left on the OLD lane's build. Generalized again
  // to "once per (champ-select session, championId, laneId)" via
  // champSelectFollowState.ts's shouldAutoExportForLane/markAutoExported
  // (see that module's doc comment for the "latest wins" model and why it
  // correctly handles a same-champion lane bounce A -> B -> A). The
  // localStorage multi-tab lock (tryClaimAutoExportLock) gained `lane` in
  // its key for the same reason — a lock claimed for one lane must never
  // starve a legitimate re-fire for a different one.
  //
  // The wrong-champion race (P1 audit fix, 2026-07-20) still applies:
  // isCompanionDrivenChampion gates on whether THIS championId was actually
  // reached via a companion signal (initial deep link OR a later live-follow
  // update — both mark it in champSelectFollowState.ts) rather than a
  // transient fallback render (e.g. the page's default champion showing
  // before app/page.tsx's own lookup resolves and swaps in the real one).
  // This is unchanged and gates BOTH the first-ever export AND any later
  // lane re-fire, checked before shouldAutoExportForLane is ever consulted.
  //
  // Compliance (v1.3.0 update): BOTH item sets AND runes may now auto-export
  // — see companion.ps1's header + companionClient.ts's header comment for
  // the reasoning (inert loadout suggestions, not game actions) and the one
  // bright line that doesn't move (rune auto mode never deletes a page it
  // doesn't own).
  //
  // v0.35.0 fold-in fix: both promise chains below now end in a `.catch()`,
  // not just `.then()` — an uncaught rejection anywhere in the attempt
  // (e.g. a pure builder throwing on a genuinely malformed field) used to
  // vanish completely silently (no toast, no companion call, no console
  // signal a user would ever see): exactly the asymmetry investigated after
  // a live report of "runes auto-exported, items silently didn't." Item
  // sets have strictly more surface area that could throw before ever
  // reaching the companion (buildItemSets is a synchronous pure builder
  // called after the async pro-consensus resolution; runes has no
  // equivalent extra step), so this hardening matters more for that path,
  // but it's applied symmetrically to both on the "never let an attempt
  // vanish without at least a visible error toast" principle.
  const [itemsToast, setItemsToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [runesToast, setRunesToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (state.status !== "ok") return;
    const build = state.build;
    const championId = build.champion.id;
    if (!isCompanionDrivenChampion(championId)) return;

    const session = getStoredSession();
    const port = getStoredPort();
    const epoch = getChampSelectPhaseEpoch();

    // Item sets
    if (shouldAutoExportForLane("items", championId, lane) && tryClaimAutoExportLock("items", epoch, championId, lane)) {
      markAutoExported("items", championId, lane);
      autoApplyItemSetsIfEligible(
        { isDeepLink: true, autoEnabled: getAutoItemSetsEnabled(), session, port, alreadyFired: false },
        async () => ({ champ: build.champion, lane, roleLabel: build.roleLabel, build })
      )
        .then((outcome) => {
          if (!outcome.attempted) return; // gate refused, or the companion probe failed -- quiet, no toast
          if (outcome.result.ok) {
            setItemsToast({ kind: "success", message: `Item build added for ${build.champion.name} — check your shop in game.` });
          } else {
            setItemsToast({
              kind: "error",
              message: outcome.result.hint ?? "Couldn't auto-add item builds — add them manually from the Runes & Summoners card.",
            });
          }
          setTimeout(() => setItemsToast(null), 6000);
        })
        .catch(() => {
          // See this effect's header comment (v0.35.0 fold-in fix) — an
          // uncaught exception anywhere in the attempt must surface a
          // visible error, never vanish silently.
          setItemsToast({
            kind: "error",
            message: "Couldn't auto-add item builds — add them manually from the Runes & Summoners card.",
          });
          setTimeout(() => setItemsToast(null), 6000);
        });
    }

    // Runes
    if (shouldAutoExportForLane("runes", championId, lane) && tryClaimAutoExportLock("runes", epoch, championId, lane)) {
      markAutoExported("runes", championId, lane);
      autoApplyRunesIfEligible(
        { isDeepLink: true, autoEnabled: getAutoRunesEnabled(), session, port, alreadyFired: false },
        async () => ({ championName: build.champion.name, roleLabel: build.roleLabel, runes: build.runes })
      )
        .then((outcome) => {
          if (!outcome.attempted) return;
          if (outcome.result.ok) {
            const r = outcome.result;
            setRunesToast({
              kind: "success",
              message:
                r.selected && r.verified
                  ? `Runes applied for ${build.champion.name}.`
                  : `Runes saved for ${build.champion.name} — open the client to select the page.`,
            });
          } else {
            setRunesToast({
              kind: "error",
              message: outcome.result.hint ?? "Couldn't auto-apply runes — use the Apply runes button instead.",
            });
          }
          setTimeout(() => setRunesToast(null), 6000);
        })
        .catch(() => {
          setRunesToast({
            kind: "error",
            message: "Couldn't auto-apply runes — use the Apply runes button instead.",
          });
          setTimeout(() => setRunesToast(null), 6000);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per (epoch, championId, lane) by design (champSelectFollowState's own dedup), not a live-updating effect
  }, [state, lane]);

  if (state.status === "loading") {
    return (
      <div className="mt-5 space-y-5">
        <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
        <BuildLoadingSkeleton />
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="mt-5 space-y-5">
        <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
        <div className="bg-panel border border-line rounded-xl p-10 text-center">
          <div className="text-txt font-semibold mb-1">
            Not enough data for {champ.name} {LANE_LABEL[lane]}
          </div>
          <div className="text-mut text-sm">
            Try a different lane or rank bracket, or check{" "}
            <a
              href="https://coachless.gg"
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal hover:underline"
            >
              coachless.gg
            </a>{" "}
            directly.
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-5 space-y-5">
        <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
        <div className="bg-panel border border-line rounded-xl p-10 text-center">
          <div className="text-txt font-semibold mb-1">Couldn&apos;t load — try again</div>
          <div className="text-mut text-sm">
            Something went wrong fetching {champ.name} {LANE_LABEL[lane]}. Check your connection and
            refresh.
          </div>
        </div>
      </div>
    );
  }

  const { build } = state;
  const ver = versionFromPatch(build.patch);

  return (
    <div className="mt-5 space-y-5">
      <RankBracketSelector value={rankBracket} onChange={handleRankChange} />
      {runesToast && (
        <p
          role="status"
          className={`text-[11.5px] rounded-lg border px-3.5 py-2.5 ${
            runesToast.kind === "success" ? "text-teal border-teal-dim bg-teal/5" : "text-bad border-bad/40 bg-bad/5"
          }`}
        >
          {runesToast.message}
        </p>
      )}
      {itemsToast && (
        <p
          role="status"
          className={`text-[11.5px] rounded-lg border px-3.5 py-2.5 ${
            itemsToast.kind === "success" ? "text-teal border-teal-dim bg-teal/5" : "text-bad border-bad/40 bg-bad/5"
          }`}
        >
          {itemsToast.message}
        </p>
      )}
      <RunesSummonersCard
        runes={build.runes}
        spells={build.spells}
        onOpenDetail={openDetail}
        championName={build.champion.name}
        roleLabel={build.roleLabel}
        build={build}
        lane={lane}
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <StartingCard starter={build.items.starter} onItemClick={openItemPopover} />
        <div className="md:col-span-2">
          <CoreBuildOrderCard items={build.items} onItemClick={openItemPopover} />
        </div>
      </div>
      <SituationalCard items={build.items} onItemClick={openItemPopover} />

      {/* v0.27.0 (user request: "pro players seem to build Rocketbelt on
          Viktor — create another builds and runes space based on what pro
          players are often building"). Complements the WPA recommendation
          above with a plain pick-rate count over the same champion-scoped
          pro-games feed PRO BUILDS lists — own fetch, own loading/hidden
          states (components/hextech/ProConsensusCard.tsx), refetches on
          champ/lane change same as everything else on this tab. Reuses this
          tab's own popover plumbing (openDetail) rather than standing up a
          second popover/scroll-lock instance. */}
      <ProConsensusCard champ={champ} lane={lane} ver={ver} onOpenDetail={openDetail} />

      {/* Always mounted (once any item/rune/shard/spell has ever been
          opened) so its own rendered/visible exit transition — DetailPopover's
          own decoupled pattern — gets to play out on close instead of being
          yanked from the tree mid-fade. `lastDetail` intentionally persists
          across close; only `activeDetail` toggles the `open` prop. Overlay
          state only — never pushed to any nav/history mechanism. */}
      {lastDetail && lastDetail.kind === "item" && (
        <ItemDetailPopover itemId={lastDetail.id} ver={ver} open={activeDetail !== null} onClose={closeDetail} />
      )}
      {lastDetail && lastDetail.kind !== "item" && (
        <EntityDetailPopover
          kind={lastDetail.kind}
          id={lastDetail.id}
          ver={ver}
          open={activeDetail !== null}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
