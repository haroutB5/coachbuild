"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ChampionRef } from "@/lib/types";
import { LANE_LABEL, LANE_ORDER, LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { useCompanion } from "@/components/live/CompanionProvider";
import { buildLiveDeepLink } from "@/components/live/deepLink";
import { resolveChampSelectRoleId } from "@/components/live/champSelectFollow";
import {
  resolveDraftLiveTarget,
  shouldShowResetToLive,
  resolveChampSelectEntry,
  INITIAL_CHAMP_SELECT_ENTRY_STATE,
  MAX_DRAFT_ENEMIES,
  type ChampSelectEntryState,
} from "@/components/live/draftLiveSync";
import { resolveLockedPickChampionId, shouldShowLockedPickBanner } from "@/components/live/draftLockedPick";
import {
  fetchDraftRecommend,
  type DraftRecommendResponse,
  type DraftRecommendMeta,
  type DraftPlayResult,
} from "@/components/live/draftRecommend";
import { IconWithFallback } from "@/components/IconWithFallback";
import ThemedSelect, { type ThemedSelectOption } from "@/components/ThemedSelect";
import { POOL_MIN_PICKRATE } from "@/lib/draft/score";
import { DRAFT_BRACKET } from "@/lib/rankBrackets";
import type { BlindPickResult } from "@/lib/draft/blindPick";
import { aggregateEnemyComp } from "@/lib/draft/compRatings";
import { deriveTakeaways } from "@/lib/draft/compTakeaways";
import {
  DEFAULT_DRAFT_ASSISTANT_FILTERS,
  filterDraftAssistantCandidates,
  filterCounterCandidates as filterPositiveCounters,
  resolveVisibleDraftAssistantRanking,
  resolveTopRecommendationCards,
  resolveRecommendedDetailCandidates,
  type DraftAssistantCandidate,
  type DraftAssistantDetailSort,
  type DraftLaneStat,
  type DraftMatchupPreview,
} from "@/components/hextech/draftAssistantModel";
import DraftCompBars from "@/components/hextech/DraftCompBars";
import DraftPicksTable from "@/components/hextech/DraftPicksTable";
import DraftControls from "@/components/hextech/draft/DraftControls";
import DraftLockInCard from "@/components/hextech/draft/DraftLockInCard";
import DraftMatchupGrid from "@/components/hextech/draft/DraftMatchupGrid";
import DraftRecommendation from "@/components/hextech/draft/DraftRecommendation";
import { preserveOriginalDraftRanks } from "@/components/hextech/draft/draftRanking";

const RECOMMEND_DEBOUNCE_MS = 300;
const MAX_ALLIED_ADDITIONAL = 4;

type AssistantView = "recommended" | "blind" | "counters" | "comfort";
type DetailSort = DraftAssistantDetailSort;

type FetchState =
  | { status: "loading" }
  | { status: "ok"; data: DraftRecommendResponse }
  | { status: "pending"; meta?: DraftRecommendMeta }
  | { status: "empty"; meta: DraftRecommendMeta }
  | { status: "error" };

interface BlindPickResponse {
  picks: BlindPickResult[];
  meta: {
    patch: string | null;
    tier: number;
    lane: number;
    fetchedAt: string | null;
    poolCandidates: number;
    qualifiedCandidates: number;
    excludedByLaneShare: number;
    excludedByMassGate: number;
    excludedUncomputable: number;
    returnedCandidates: number;
    topN: number;
    /** v0.109.0 — see the route's BlindPickMeta.emptyReason. Absent on an
     *  older cached response degrades to null, which the panel treats as "we
     *  do not know why", not as "no data". */
    emptyReason: "no-data" | "all-withheld" | "no-candidates" | null;
  };
  pending?: boolean;
}

type BlindPickFetchState =
  | { status: "loading" }
  | { status: "ok"; data: BlindPickResponse }
  | { status: "pending"; data: BlindPickResponse }
  | { status: "empty"; data: BlindPickResponse }
  | { status: "error" };

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function normalizeBlindPickResponse(raw: unknown): BlindPickResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Partial<BlindPickResponse> & { meta?: Partial<BlindPickResponse["meta"]> };
  const meta = body.meta;
  if (
    !meta ||
    (typeof meta.patch !== "string" && meta.patch !== null) ||
    typeof meta.tier !== "number" ||
    typeof meta.lane !== "number" ||
    (typeof meta.fetchedAt !== "string" && meta.fetchedAt !== null) ||
    ![
      meta.poolCandidates,
      meta.qualifiedCandidates,
      meta.excludedByLaneShare,
      meta.excludedByMassGate,
      meta.excludedUncomputable,
      meta.returnedCandidates,
      meta.topN,
    ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
  ) {
    return null;
  }

  const picks: BlindPickResult[] = [];
  if (Array.isArray(body.picks)) {
    for (const rawPick of body.picks) {
      if (!rawPick || typeof rawPick !== "object") continue;
      const pick = rawPick as Partial<BlindPickResult>;
      if (
        typeof pick.rank !== "number" ||
        typeof pick.champId !== "number" ||
        typeof pick.blindScore !== "number" ||
        typeof pick.fieldWr !== "number" ||
        typeof pick.es10 !== "number" ||
        typeof pick.badMass !== "number" ||
        typeof pick.totalGames !== "number" ||
        typeof pick.coverageMass !== "number" ||
        ![
          pick.rank,
          pick.champId,
          pick.blindScore,
          pick.fieldWr,
          pick.es10,
          pick.badMass,
          pick.totalGames,
          pick.coverageMass,
        ].every((value) => Number.isFinite(value))
      ) {
        continue;
      }
      const worst = pick.worstMatchup;
      const worstMatchup =
        worst &&
        typeof worst === "object" &&
        typeof worst.oppId === "number" &&
        typeof worst.wr === "number" &&
        typeof worst.games === "number" &&
        Number.isFinite(worst.oppId) &&
        Number.isFinite(worst.wr) &&
        Number.isFinite(worst.games)
          ? { oppId: worst.oppId, wr: worst.wr, games: worst.games }
          : null;
      picks.push({
        rank: pick.rank,
        champId: pick.champId,
        blindScore: pick.blindScore,
        fieldWr: pick.fieldWr,
        es10: pick.es10,
        badMass: pick.badMass,
        worstMatchup,
        totalGames: pick.totalGames,
        coverageMass: pick.coverageMass,
      });
    }
  }

  return {
    picks,
    meta: {
      patch: meta.patch,
      tier: meta.tier,
      lane: meta.lane,
      fetchedAt: meta.fetchedAt,
      poolCandidates: meta.poolCandidates,
      qualifiedCandidates: meta.qualifiedCandidates,
      excludedByLaneShare: meta.excludedByLaneShare,
      excludedByMassGate: meta.excludedByMassGate,
      excludedUncomputable: meta.excludedUncomputable,
      returnedCandidates: meta.returnedCandidates,
      topN: meta.topN,
      emptyReason:
        meta.emptyReason === "no-data" || meta.emptyReason === "all-withheld" || meta.emptyReason === "no-candidates"
          ? meta.emptyReason
          : null,
    },
    pending: body.pending === true,
  };
}

const LANE_SELECT_OPTIONS: readonly ThemedSelectOption<LaneId>[] = LANE_ORDER.map((role) => ({
  value: role,
  label: `${LANE_LABEL[role]} Lane`,
}));

const MIN_PICK_RATE_OPTIONS: readonly ThemedSelectOption<number>[] = [
  { value: 0, label: "0%" },
  { value: 0.005, label: "0.5%" },
  { value: 0.01, label: "1.0%" },
  { value: 0.02, label: "2.0%" },
  { value: 0.05, label: "5.0%" },
];

/** v0.109.0: was 0 / 1,000 / 5,000 / 10,000, chosen against u.gg tier 10 where
 *  a lane carries ~4.86M games. /draft has served tier 15 (~601k per lane)
 *  since v0.108.0, where the top two options stop being a filter and start
 *  being a wall. MEASURED, patch 16.14 tier 15, champions surviving each value
 *  (top/jungle/mid/bot/support), against 114/73/101/71/81 actually served:
 *      250 -> 136/82/128/95/110 (above the served pool: no-op, as intended for a low rung)
 *      500 -> 120/76/110/75/85
 *    1,000 ->  98/70/ 87/59/70
 *    2,500 ->  73/64/ 71/47/51
 *    5,000 ->  56/51/ 47/44/43   (the old second rung — cuts the list roughly in half)
 *   10,000 ->  fewer still
 *  The rungs below are spaced so each one is a real, distinguishable narrowing
 *  on the bucket the page actually serves. Re-derive them if the rank bucket
 *  moves again — that is the mistake this release exists to undo. */
const MINIMUM_GAMES_OPTIONS: readonly ThemedSelectOption<number>[] = [
  { value: 0, label: "Any games" },
  { value: 250, label: "250" },
  { value: 500, label: "500" },
  { value: 1000, label: "1,000" },
  { value: 2500, label: "2,500" },
];

const ASSISTANT_VIEW_LABELS: Record<AssistantView, string> = {
  recommended: "Recommended",
  blind: "Blind Picks",
  counters: "Counters",
  comfort: "Comfort",
};

const DETAIL_SORT_LABELS: Record<DetailSort, string> = {
  winRate: "Win Rate",
  pickRate: "Pick Rate",
  games: "Games",
};

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function formatGames(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString() : "—";
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function championEntry(champIcons: Map<number, ChampionIconEntry>, id: number): ChampionIconEntry {
  return champIcons.get(id) ?? { name: `Champion #${id}`, icon: "" };
}

function EmptyPanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-[9px] p-6 text-center" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }}>
      <p className="text-[13px] font-semibold text-txt">{title}</p>
      <p className="mt-1 text-[12px] leading-[1.5] text-txt/[0.55]">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function DraftLoadingCard() {
  return (
    <div className="space-y-3 rounded-[9px] p-4" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }} aria-label="Loading draft recommendations">
      <div className="h-4 w-36 rounded bg-txt/[0.05]" />
      <div className="h-[118px] w-full rounded-[8px] bg-txt/[0.05]" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-16 rounded-[8px] bg-txt/[0.05]" />
        <div className="h-16 rounded-[8px] bg-txt/[0.05]" />
      </div>
    </div>
  );
}

function laneAverage(laneStats: DraftLaneStat[]): number | null {
  let games = 0;
  let wins = 0;
  for (const stat of laneStats) {
    if (stat.baselineWr === null || stat.totalGames === null || stat.totalGames <= 0) continue;
    games += stat.totalGames;
    wins += stat.baselineWr * stat.totalGames;
  }
  return games > 0 ? wins / games : null;
}

function floorForCandidate(candidate: DraftAssistantCandidate, blindPicks: BlindPickResult[]): number | null {
  if (candidate.floor !== null) return candidate.floor;
  return blindPicks.find((pick) => pick.champId === candidate.champId)?.es10 ?? null;
}

function reasonForCandidate(args: {
  candidate: DraftAssistantCandidate;
  laneOpponentName: string | null;
  preview: DraftMatchupPreview | undefined;
  floor: number | null;
  compTakeaway: string | null;
}): { chip: string | null; reason: string | null } {
  const parts: string[] = [];
  let chip: string | null = null;
  if (args.laneOpponentName && typeof args.candidate.synergyDelta === "number" && args.candidate.synergyDelta > 0) {
    chip = `Favored into ${args.laneOpponentName}`;
    parts.push(`It answers ${args.laneOpponentName} with the strongest available matchup evidence.`);
  }
  const bestMatchup = args.preview?.best[0];
  if (bestMatchup) {
    parts.push(`It holds up well into ${bestMatchup.oppId === args.candidate.champId ? "the current enemy field" : "popular enemy picks"}.`);
  }
  if (args.floor !== null) {
    chip = chip ?? "Blind-safe";
    parts.push("Its first-pick floor stays useful before the enemy lane is known.");
  }
  if (args.compTakeaway) {
    const plainTakeaway = args.compTakeaway.split(" — ")[0].toLowerCase();
    parts.push(`The enemy read is ${plainTakeaway}, so this keeps the call focused.`);
  }
  return { chip, reason: parts.length > 0 ? parts.join(" ") : null };
}

export default function DraftPage() {
  const router = useRouter();
  const companion = useCompanion();

  const sessionAppliedRef = useRef(false);
  useEffect(() => {
    if (sessionAppliedRef.current) return;
    sessionAppliedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const session = params.get("session");
    if (session) companion.setSession(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [lane, setLane] = useState<LaneId>("mid");
  const [enemyIds, setEnemyIds] = useState<number[]>([]);
  const [laneOpponentId, setLaneOpponentId] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [dismissedLockedPickId, setDismissedLockedPickId] = useState<number | null>(null);
  const [myPoolOnly, setMyPoolOnly] = useState(false);
  const [allyIds, setAllyIds] = useState<number[]>([]);
  const [assistantView, setAssistantView] = useState<AssistantView>("recommended");
  const [minPickRate, setMinPickRate] = useState(DEFAULT_DRAFT_ASSISTANT_FILTERS.minPickRate);
  const [includeOffMeta, setIncludeOffMeta] = useState(DEFAULT_DRAFT_ASSISTANT_FILTERS.includeOffMeta);
  const [minimumGames, setMinimumGames] = useState(DEFAULT_DRAFT_ASSISTANT_FILTERS.minimumGames);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [detailSort, setDetailSort] = useState<DetailSort>("winRate");
  const [selectedDetailChampionId, setSelectedDetailChampionId] = useState<number | null>(null);
  const [showFullTable, setShowFullTable] = useState(false);
  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [blindState, setBlindState] = useState<BlindPickFetchState>({ status: "loading" });

  const laneRef = useRef(lane);
  const enemyIdsRef = useRef(enemyIds);
  const laneOpponentIdRef = useRef(laneOpponentId);
  const hoverRef = useRef(hover);
  useEffect(() => {
    laneRef.current = lane;
    enemyIdsRef.current = enemyIds;
    laneOpponentIdRef.current = laneOpponentId;
    hoverRef.current = hover;
  }, [lane, enemyIds, laneOpponentId, hover]);
  const entryStateRef = useRef<ChampSelectEntryState>(INITIAL_CHAMP_SELECT_ENTRY_STATE);

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  // Live sync is intentionally kept as the existing CompanionProvider-driven
  // state machine. Presentation changes below never write to the companion.
  useEffect(() => {
    if (!companion.statusFresh) {
      entryStateRef.current = INITIAL_CHAMP_SELECT_ENTRY_STATE;
      return;
    }

    const entryResult = resolveChampSelectEntry(entryStateRef.current, companion.phase);
    entryStateRef.current = entryResult.next;
    if (entryResult.isEntry) {
      setDismissedLockedPickId(null);
      if (dirty) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the existing dirty latch clears on the one-time fresh entry transition.
        setDirty(false);
        return;
      }
    }

    const target = resolveDraftLiveTarget({
      phase: companion.phase,
      champSelect: companion.champSelect,
      statusFresh: companion.statusFresh,
      dirty,
    });
    if (!target) return;
    if (target.lane !== undefined && target.lane !== laneRef.current) setLane(target.lane);
    if (!arraysEqual(target.enemies, enemyIdsRef.current)) setEnemyIds(target.enemies);
    if (target.hover !== hoverRef.current) setHover(target.hover);
  }, [companion.tick, companion.phase, companion.champSelect, companion.statusFresh, dirty]);

  const reqIdRef = useRef(0);
  useEffect(() => {
    const requestId = ++reqIdRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading is the existing debounced request state transition.
    setState({ status: "loading" });
    const laneNum = LANE_TO_ROLE_ID[lane];
    const timer = setTimeout(() => {
      fetchDraftRecommend({ lane: laneNum, enemies: enemyIds, hover, laneOpp: laneOpponentId }).then((data) => {
        if (reqIdRef.current !== requestId) return;
        if (!data) {
          setState({ status: "error" });
          return;
        }
        if (data.pending) {
          setState({ status: "pending", meta: data.meta });
          return;
        }
        if (data.plays.length === 0 && data.potentialPlays.length === 0) {
          setState({ status: "empty", meta: data.meta });
          return;
        }
        setState({ status: "ok", data });
      });
    }, RECOMMEND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lane, enemyIds, laneOpponentId, hover]);

  const blindReqIdRef = useRef(0);
  const [blindRetry, setBlindRetry] = useState(0);
  useEffect(() => {
    const requestId = ++blindReqIdRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- independent blind-pick loading state is preserved.
    setBlindState({ status: "loading" });
    const controller = new AbortController();
    const laneNum = LANE_TO_ROLE_ID[lane];
    fetch(`/api/draft/blind-pick?lane=${laneNum}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`blind pick ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((raw) => {
        if (blindReqIdRef.current !== requestId) return;
        const data = normalizeBlindPickResponse(raw);
        if (!data) {
          setBlindState({ status: "error" });
          return;
        }
        if (data.pending) {
          setBlindState({ status: "pending", data });
          return;
        }
        setBlindState({ status: data.picks.length > 0 ? "ok" : "empty", data });
      })
      .catch(() => {
        if (blindReqIdRef.current === requestId) setBlindState({ status: "error" });
      });
    return () => controller.abort();
  }, [lane, blindRetry]);

  function handleLaneChange(next: LaneId) {
    setDirty(true);
    setLane(next);
  }

  function handleAddEnemy(champ: ChampionRef) {
    setDirty(true);
    setEnemyIds((prev) => (prev.includes(champ.id) || prev.length >= MAX_DRAFT_ENEMIES ? prev : [...prev, champ.id]));
  }

  function handleAddAlly(champ: ChampionRef) {
    setAllyIds((prev) => (prev.includes(champ.id) || prev.length >= MAX_ALLIED_ADDITIONAL ? prev : [...prev, champ.id]));
  }

  function handleRemoveAlly(id: number) {
    setAllyIds((prev) => prev.filter((value) => value !== id));
  }

  function handleAssistantViewChange(view: AssistantView) {
    setAssistantView(view);
    setMyPoolOnly(view === "comfort");
    setShowFullTable(false);
  }

  function handleAssistantTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: AssistantView) {
    const views: AssistantView[] = ["recommended", "blind", "counters", "comfort"];
    const currentIndex = views.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % views.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + views.length) % views.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = views.length - 1;
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    const next = views[nextIndex];
    handleAssistantViewChange(next);
    window.setTimeout(() => document.getElementById(`draft-tab-${next}`)?.focus(), 0);
  }

  function handleRemoveEnemy(id: number) {
    setDirty(true);
    setEnemyIds((prev) => prev.filter((value) => value !== id));
    setLaneOpponentId((prev) => (prev === id ? null : prev));
  }

  function handleToggleLaneOpponent(id: number) {
    setDirty(true);
    setLaneOpponentId((prev) => (prev === id ? null : id));
  }

  function handleHoverChange(champ: ChampionRef) {
    setDirty(true);
    setHover(champ.id);
  }

  function handleClearHover() {
    setDirty(true);
    setHover(null);
  }

  const showResetToLive = shouldShowResetToLive(dirty, companion.phase, companion.champSelect, companion.statusFresh);
  const liveSyncing = companion.statusFresh && companion.phase === "ChampSelect" && !dirty;
  const lockedPickInput = {
    phase: companion.phase,
    session: companion.session,
    cellChampionId: companion.champSelect?.cellChampionId,
    dismissedChampionId: dismissedLockedPickId,
    statusFresh: companion.statusFresh,
  };
  const lockedChampionId = resolveLockedPickChampionId(lockedPickInput);
  const showLockedPickBanner = shouldShowLockedPickBanner(lockedPickInput);
  const lockedChampionEntry = lockedChampionId === null ? undefined : champIcons.get(lockedChampionId);
  const lockedChampionName = lockedChampionEntry?.name ?? (lockedChampionId === null ? "" : `Champion #${lockedChampionId}`);
  const lockedBuildHref =
    lockedChampionId !== null && companion.session
      ? buildLiveDeepLink({ championId: lockedChampionId, role: resolveChampSelectRoleId(companion.champSelect), session: companion.session })
      : null;

  const isStalePatchData =
    state.status === "ok" &&
    state.data.meta.currentPatch !== null &&
    state.data.meta.patch !== null &&
    state.data.meta.currentPatch !== state.data.meta.patch;
  const isIngestUnhealthy = state.status === "ok" && state.data.meta.ingestHealthy === false;
  const isDirectionCheckStale = state.status === "ok" && state.data.meta.directionCheckOk === false;
  // v0.109.0 — champions dropped by the pre-scoring pool floor. Rendered only
  // when we actually know both numbers AND something was withheld: a note
  // saying "0 excluded" is noise, and a note computed from a missing field
  // would be an invention. See RecommendMeta.poolTotal.
  const poolMeta = state.status === "ok" ? state.data.meta : null;
  const poolWithheld =
    poolMeta && poolMeta.poolTotal !== null && poolMeta.poolIncluded !== null
      ? Math.max(0, poolMeta.poolTotal - poolMeta.poolIncluded)
      : null;
  const poolNote =
    poolWithheld !== null && poolWithheld > 0 && poolMeta?.poolFloorGames != null
      ? `Ranking ${poolMeta.poolIncluded} of ${poolMeta.poolTotal} champions in this lane — ${poolWithheld} held back below the ${formatGames(poolMeta.poolFloorGames)}-game lane floor (0.1% of lane games).`
      : null;
  const serverInferredLaneOpponentId = state.status === "ok" ? state.data.meta.laneOppInferred : null;
  const effectiveLaneOpponentId = laneOpponentId ?? serverInferredLaneOpponentId;
  const laneOpponentName = effectiveLaneOpponentId === null ? null : championEntry(champIcons, effectiveLaneOpponentId).name;

  const basePlays: DraftPlayResult[] = state.status === "ok" ? state.data.plays : [];
  const basePotentialPlays: DraftPlayResult[] = state.status === "ok" ? state.data.potentialPlays : [];
  const hasAnyMyPoolData = basePlays.some((play) => play.personalOverall.games >= 1) || basePotentialPlays.some((play) => play.personalOverall.games >= 1);
  const blindMeta = blindState.status === "ok" || blindState.status === "empty" ? blindState.data.meta : null;
  const blindPoolAfterShare = blindMeta ? Math.max(0, blindMeta.poolCandidates - blindMeta.excludedByLaneShare) : 0;
  const blindExclusionNote = blindMeta
    ? [
        blindMeta.excludedByLaneShare > 0 ? `${blindMeta.excludedByLaneShare} of ${blindMeta.poolCandidates} pool champions excluded below ${formatPercent(POOL_MIN_PICKRATE)} lane share` : null,
        blindMeta.excludedByMassGate > 0 ? `${blindMeta.excludedByMassGate} of ${blindPoolAfterShare} remaining pool champions excluded by matchup mass` : null,
        blindMeta.excludedUncomputable > 0 ? `${blindMeta.excludedUncomputable} remaining pool champions excluded for missing matchup rows` : null,
      ].filter((part): part is string => part !== null).join("; ")
    : "";

  const laneStats: DraftLaneStat[] = state.status === "ok" ? state.data.laneStats ?? [] : [];
  const laneStatMap = new Map<number, DraftLaneStat>(laneStats.map((stat) => [stat.champId, stat]));
  const matchupPreviewMap = new Map<number, DraftMatchupPreview>(state.status === "ok" ? (state.data.matchupPreviews ?? []).map((preview) => [preview.champId, preview]) : []);
  const activeFilters = { minPickRate, includeOffMeta, minimumGames };
  const rankedRecommendedRows = preserveOriginalDraftRanks([basePlays, basePotentialPlays], myPoolOnly);
  const recommendedFilterRows = rankedRecommendedRows.filter(({ play }) => !basePotentialPlays.includes(play)).map(({ play, rank }) => {
    const stat = laneStatMap.get(play.champId);
    return { play, rank, synergyDelta: play.synergyDelta, champId: play.champId, laneShare: stat?.laneShare ?? null, totalGames: stat?.totalGames ?? null };
  });
  const potentialFilterRows = rankedRecommendedRows.filter(({ play }) => basePotentialPlays.includes(play)).map(({ play, rank }) => {
    const stat = laneStatMap.get(play.champId);
    return { play, rank, synergyDelta: play.synergyDelta, champId: play.champId, laneShare: stat?.laneShare ?? null, totalGames: stat?.totalGames ?? null };
  });
  const filteredRecommendedRows = filterDraftAssistantCandidates(recommendedFilterRows, activeFilters);
  const filteredPotentialRows = filterDraftAssistantCandidates(potentialFilterRows, activeFilters);
  const blindPicks = blindState.status === "ok" ? blindState.data.picks : [];
  const blindFilterRows = blindPicks.map((pick) => {
    const stat = laneStatMap.get(pick.champId);
    return { pick, champId: pick.champId, laneShare: stat?.laneShare ?? null, totalGames: stat?.totalGames ?? pick.totalGames };
  });
  const filteredBlindRows = filterDraftAssistantCandidates(blindFilterRows, activeFilters);
  const filteredBlindCandidates: DraftAssistantCandidate[] = filteredBlindRows.map(({ pick }) => {
    const stat = laneStatMap.get(pick.champId);
    return {
      champId: pick.champId,
      winRate: pick.fieldWr,
      floor: pick.es10,
      totalGames: stat?.totalGames ?? pick.totalGames,
      laneShare: stat?.laneShare ?? null,
      rank: pick.rank,
      isPotential: false,
      personalOverall: { games: 0, wins: 0 },
      source: "blind" as const,
    };
  });
  const filteredCounterRows = filterPositiveCounters([...filteredRecommendedRows, ...filteredPotentialRows]);
  const toRecommendedCandidate = (row: (typeof recommendedFilterRows)[number], isPotential: boolean): DraftAssistantCandidate => {
    const stat = laneStatMap.get(row.play.champId);
    return {
      champId: row.play.champId,
      winRate: row.play.score,
      floor: null,
      totalGames: stat?.totalGames ?? null,
      laneShare: stat?.laneShare ?? null,
      rank: row.rank,
      isPotential,
      personalOverall: row.play.personalOverall,
      source: "recommended",
      synergyDelta: row.play.synergyDelta,
    };
  };
  const matchupDetailCandidates = [
    ...filteredRecommendedRows.map((row) => toRecommendedCandidate(row, false)),
    ...filteredPotentialRows.map((row) => toRecommendedCandidate(row, true)),
  ];
  const currentViewRows: DraftAssistantCandidate[] =
    assistantView === "blind"
      ? filteredBlindCandidates
      : assistantView === "counters" && enemyIds.length === 0
        ? []
        : assistantView === "counters"
          ? filteredCounterRows.map((row) => toRecommendedCandidate(row, basePotentialPlays.includes(row.play)))
          : assistantView === "recommended"
            ? resolveRecommendedDetailCandidates({ recommended: matchupDetailCandidates, blind: filteredBlindCandidates, noEnemies: enemyIds.length === 0 })
            : matchupDetailCandidates;
  const preserveDetailOrder = assistantView === "comfort" || assistantView === "counters";
  const topCards = resolveTopRecommendationCards({ rows: currentViewRows });
  const topCandidate = topCards[0]?.candidate ?? null;
  const detailAverage = laneAverage(laneStats);
  const matchupRows = resolveVisibleDraftAssistantRanking({ rows: currentViewRows, sort: detailSort, limit: 5, preserveOrder: preserveDetailOrder }).map((row) => row.candidate);
  const compTakeaway = enemyIds.length > 0 ? deriveTakeaways(aggregateEnemyComp(enemyIds))[0] ?? null : null;
  const topFloor = topCandidate ? floorForCandidate(topCandidate, blindPicks) : null;
  const topReason = topCandidate
    ? reasonForCandidate({ candidate: topCandidate, laneOpponentName, preview: matchupPreviewMap.get(topCandidate.champId), floor: topFloor, compTakeaway })
    : { chip: null, reason: null };

  function selectCandidate(championId: number) {
    const entry = championEntry(champIcons, championId);
    handleHoverChange({ id: championId, key: "", name: entry.name, icon: entry.icon });
  }

  function viewBuild(championId: number) {
    router.push(`/?championId=${championId}&role=${LANE_TO_ROLE_ID[lane]}`);
  }

  const filterSummary = `Min ${minimumGames > 0 ? formatGames(minimumGames) : "any"} games · off-meta ${includeOffMeta ? "on" : "off"}`;

  return (
    <main className="min-w-0 overflow-x-clip">
      <div className="mx-auto min-w-0 max-w-[1520px] px-5 py-5 lg:px-6 lg:py-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-accent-400">Champ select · {LANE_LABEL[lane]} lane · pick 4</p>
            <h1 className="mt-1 text-[34px] font-semibold leading-none tracking-[-0.025em] text-txt">Draft Assistant</h1>
          </div>
          <div className="text-right text-[11px] leading-[1.5] text-txt/[0.42] tabular-nums">
            {/* RANK SCOPE (v0.109.0). /draft rendered win rates with no rank
                label at all: `meta.tier` came down the wire as a bare number
                and stopped there, so a reader could not tell which population
                a draft win rate described — nor that it is a DIFFERENT one
                from the Builds page, which has carried its own scope note
                since v0.107.0. The two brackets differ deliberately (u.gg has
                a Diamond II+ cut, coachless has no division axis at all), and
                a deliberate difference nobody can see is indistinguishable
                from an inconsistency. Full-alpha `text-mut` for the second
                line, NOT a dimmed alpha — same contrast reasoning as
                ChampionHero's scope note. */}
            <p className="font-semibold uppercase tracking-[0.08em] text-mut">
              All data from <span className="text-[#d2cefd]">{DRAFT_BRACKET.label}</span>
            </p>
            <p className="normal-case tracking-normal text-mut">{DRAFT_BRACKET.description} — Builds uses a wider Diamond+ sample</p>
            <p className="mt-1">u.gg matchup matrix · patch {state.status === "ok" ? state.data.meta.patch || "—" : "—"} · refreshed {state.status === "ok" ? formatRelativeTime(state.data.meta.fetchedAt) : "—"}</p>
            {isStalePatchData && state.status === "ok" && <p>Patch {state.data.meta.currentPatch} data is not ready yet — showing patch {state.data.meta.patch}.</p>}
            {isIngestUnhealthy && state.status === "ok" && <p className="text-bad" title={state.data.meta.ingestLastError ?? undefined}>Last data refresh reported an error.</p>}
            {/* An explicit `false` only — `null` means the tripwire has never
                recorded a verdict, and "unknown" must never be rendered as
                either reassurance or alarm. `mut`, not `bad`: nothing has
                FAILED here — the external check simply is not currently
                vouching, and colouring that like an error would be its own
                kind of lie. */}
            {isDirectionCheckStale && state.status === "ok" && (
              <p className="text-mut" title={state.data.meta.directionCheckNote ?? undefined}>
                External matchup cross-check has not verified this data.
              </p>
            )}
          </div>
        </header>

        {liveSyncing && <p className="mb-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-good"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good motion-reduce:animate-none" aria-hidden="true" />Companion live · following champ select</p>}

        {showLockedPickBanner && lockedChampionId !== null && lockedBuildHref && (
          <div role="status" className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-[8px] p-2.5" style={{ boxShadow: "inset 0 0 0 1px rgba(70,199,155,.24)", background: "rgba(70,199,155,.08)" }}>
            <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-[7px]" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.12)" }}><IconWithFallback src={lockedChampionEntry?.icon ?? ""} alt={lockedChampionName} fallbackGlyph={lockedChampionName} className="h-full w-full object-cover" size={32} /></span>
            <p className="min-w-0 flex-1 text-[11px] text-txt/[0.58]">Your locked pick: <strong className="font-semibold text-txt">{lockedChampionName}</strong></p>
            <button type="button" onClick={() => router.push(lockedBuildHref)} className="rounded-[7px] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-accent-300 transition-colors duration-[120ms] ease-in hover:bg-accent/[0.12] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">Open build</button>
            <button type="button" onClick={() => setDismissedLockedPickId(lockedChampionId)} aria-label={`Dismiss ${lockedChampionName} locked pick banner`} className="rounded-[5px] px-1.5 py-1 text-[15px] leading-none text-txt/[0.42] hover:text-txt focus-visible:outline-2 focus-visible:outline-accent">×</button>
          </div>
        )}

        {dirty && (
          <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-[8px] px-3 py-2.5" style={{ background: "rgba(145,132,217,.12)", boxShadow: "inset 0 0 0 1px rgba(145,132,217,.22)" }}>
            <span className="text-[11px] font-semibold text-accent-300">Manual mode</span>
            <span className="min-w-0 flex-1 text-[10.5px] text-txt/[0.5]">Live champ-select updates are paused until you re-attach.</span>
            {showResetToLive && <button type="button" onClick={() => setDirty(false)} className="rounded-[6px] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-accent-300 hover:bg-accent/[0.12] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">Re-attach to live</button>}
          </div>
        )}

        <DraftControls
          lane={lane}
          laneOptions={LANE_SELECT_OPTIONS}
          onLaneChange={handleLaneChange}
          hover={hover}
          allyIds={allyIds}
          champIcons={champIcons}
          onPick={handleHoverChange}
          onClearPick={handleClearHover}
          onAddAlly={handleAddAlly}
          onRemoveAlly={handleRemoveAlly}
          enemyIds={enemyIds}
          effectiveLaneOpponentId={effectiveLaneOpponentId}
          laneOpponentId={laneOpponentId}
          serverInferredLaneOpponentId={serverInferredLaneOpponentId}
          onAddEnemy={handleAddEnemy}
          onRemoveEnemy={handleRemoveEnemy}
          onToggleLaneOpponent={handleToggleLaneOpponent}
          enemyAnalysis={state.status === "ok" ? state.data.enemyAnalysis : []}
          hoverSelected={hover !== null}
        />

        <div className="mt-4 grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_372px]">
          <div className="min-w-0 space-y-4">
            {topCandidate ? (
              <DraftRecommendation
                candidate={topCandidate}
                floor={topFloor}
                laneAverageValue={detailAverage}
                laneOpponentName={laneOpponentName}
                verdictChip={topReason.chip}
                reason={topReason.reason}
                champIcons={champIcons}
                roleLabel={LANE_LABEL[lane].toUpperCase()}
                alternates={topCards.slice(1)}
                onSelect={selectCandidate}
                onViewBuild={viewBuild}
              />
            ) : state.status === "loading" ? (
              <DraftLoadingCard />
            ) : state.status === "error" ? (
              <EmptyPanel title="Couldn&apos;t load recommendations" body="Something went wrong fetching the current draft data." />
            ) : state.status === "pending" ? (
              <EmptyPanel title="Draft data being prepared" body={`Patch ${state.meta?.patch || "the current"} data is still being ingested — check back shortly.`} />
            ) : state.status === "empty" ? (
              <EmptyPanel title="No data yet for this lane" body="Try a different role, or check back after the next data refresh." />
            ) : assistantView === "counters" && enemyIds.length === 0 ? (
              <EmptyPanel title="Add an enemy to see counters" body="Counters use favourable shrunk matchup deltas against the entered enemies." />
            ) : assistantView === "comfort" && !hasAnyMyPoolData ? (
              <EmptyPanel title="No Comfort Picks yet" body="Link an account and play ranked solo games this season to see your pool." />
            ) : (
              <EmptyPanel title="No recommendations meet the filters" body="Lower the filters or return to Recommended to see the full ranking." />
            )}

            <section aria-labelledby="draft-tabs-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="draft-tabs-heading" className="sr-only">Draft ranking views</h2>
                  <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[9px] bg-panel2 p-[3px]" role="tablist" aria-label="Draft views">
                    {(["recommended", "blind", "counters", "comfort"] as AssistantView[]).map((value) => (
                      <button
                        key={value}
                        id={`draft-tab-${value}`}
                        type="button"
                        role="tab"
                        aria-selected={assistantView === value}
                        aria-controls="draft-view-panel"
                        tabIndex={assistantView === value ? 0 : -1}
                        onClick={() => handleAssistantViewChange(value)}
                        onKeyDown={(event) => handleAssistantTabKeyDown(event, value)}
                        className={`min-h-[44px] rounded-[6px] px-3 py-1.5 text-[10.5px] font-medium transition-colors duration-[120ms] ease-in focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0 ${assistantView === value ? "bg-accent/[0.2] text-accent-200" : "text-txt/[0.45] hover:bg-txt/[0.05] hover:text-txt/[0.8]"}`}
                      >
                        {ASSISTANT_VIEW_LABELS[value]}
                      </button>
                    ))}
                  </div>
                </div>
                <button type="button" aria-expanded={filtersExpanded} onClick={() => setFiltersExpanded((value) => !value)} className="min-h-[44px] rounded-[7px] px-3 py-2 text-[10px] font-medium text-txt/[0.55] transition-colors duration-[120ms] ease-in hover:bg-txt/[0.06] hover:text-txt focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.12)" }}>
                  {filterSummary} <span className="ml-1 text-txt/[0.35]">{filtersExpanded ? "⌃" : "⌄"}</span>
                </button>
              </div>

              <div id="draft-view-panel" role="tabpanel" aria-labelledby={`draft-tab-${assistantView}`} className="mt-2">
                {/* The pool floor runs BEFORE scoring, so the champions it
                    drops have no row, no badge and no dash anywhere on this
                    page — they are simply not here. That was invisible for a
                    release while the floor was 8x too strict. State it. */}
                {poolNote && <p className="mb-2 text-[10.5px] leading-[1.45] text-txt/[0.45]">{poolNote}</p>}
                {assistantView !== "recommended" && <p className="mb-2 text-[10.5px] leading-[1.45] text-txt/[0.45]">{assistantView === "blind" ? "Blind Picks filter the existing pool by first-pick safety; they never re-score the recommendation order." : assistantView === "comfort" ? "Comfort filters the existing ranking to champions you have played; it never re-scores or reorders it." : "Counters keep only candidates with a positive shrunk matchup delta against the entered enemies."}</p>}
                {assistantView === "counters" && enemyIds.length > 0 && filteredCounterRows.length === 0 && <EmptyPanel title="No favourable counters in this ranking" body="No candidate has a positive shrunk matchup delta against the entered enemies." />}
                {assistantView === "blind" && blindState.status === "loading" && <DraftLoadingCard />}
                {assistantView === "blind" && blindState.status === "error" && <EmptyPanel title="Couldn&apos;t load blind picks" body="The first-pick feed failed to load." action={<button type="button" onClick={() => setBlindRetry((value) => value + 1)} className="rounded-[7px] px-3 py-1.5 text-[11px] font-medium text-txt hover:bg-txt/[0.07] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.14)" }}>Try again</button>} />}
                {/* PENDING RENDERED NOTHING AT ALL before v0.109.0 — the blind
                    tab simply came up blank when no data existed for the lane,
                    which is the one state that most needs saying. The two
                    empty shapes are now distinct: "nothing has been ingested"
                    vs "candidates existed and every one was held back". */}
                {assistantView === "blind" && blindState.status === "pending" && (
                  <EmptyPanel
                    title="Blind-pick data being prepared"
                    body={`Patch ${blindState.data.meta.patch || "the current"} first-pick data has not been ingested for this lane yet — check back shortly.`}
                  />
                )}
                {assistantView === "blind" && blindState.status === "empty" && (
                  <EmptyPanel
                    title={blindState.data.meta.emptyReason === "all-withheld" ? "Every candidate was held back" : "No qualifying blind picks yet"}
                    body={
                      blindState.data.meta.emptyReason === "all-withheld"
                        ? "This lane has real candidates, but each one fell short of a publication gate — the counts below say which. Nothing is missing from the data; it was withheld deliberately."
                        : "There is not enough matchup evidence for an honest first-pick list."
                    }
                  />
                )}
                {blindExclusionNote && assistantView === "blind" && <p className="mb-2 text-[10px] text-txt/[0.4]">{blindExclusionNote}.</p>}
              </div>
            </section>

            {filtersExpanded && (
              <section className="grid min-w-0 gap-3 rounded-[8px] p-3.5 md:grid-cols-3" style={{ boxShadow: "inset 0 0 0 1px rgba(233,233,237,.08)", background: "#1b1d2a" }}>
                <label className="min-w-0"><span className="mb-1.5 block text-[9px] font-medium uppercase tracking-[0.12em] text-txt/[0.45]">Min. pick rate</span><ThemedSelect value={minPickRate} options={MIN_PICK_RATE_OPTIONS} onChange={setMinPickRate} ariaLabel="Minimum pick rate" triggerClassName="min-h-[44px] px-2.5 py-2 lg:min-h-0" /></label>
                <button type="button" role="switch" aria-checked={includeOffMeta} onClick={() => setIncludeOffMeta((value) => !value)} className="flex min-h-[44px] min-w-[44px] items-end justify-between gap-3 rounded-[6px] text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 lg:min-h-0 lg:min-w-0">
                  <span><span className="block text-[9px] font-medium uppercase tracking-[0.12em] text-txt/[0.45]">Include off-meta</span><span className="mt-1 block text-[11px] text-txt/[0.7]">Show niche picks</span></span>
                  <span className="relative mb-0.5 h-5 w-9 flex-shrink-0 rounded-full" style={{ background: includeOffMeta ? "#9184d9" : "rgba(233,233,237,.12)" }}><span className="absolute left-0 top-1 h-3 w-3 rounded-full bg-bg transition-transform duration-[120ms] motion-reduce:transition-none" style={{ transform: includeOffMeta ? "translateX(20px)" : "translateX(4px)" }} /></span>
                </button>
                <label className="min-w-0"><span className="mb-1.5 block text-[9px] font-medium uppercase tracking-[0.12em] text-txt/[0.45]">Minimum games</span><ThemedSelect value={minimumGames} options={MINIMUM_GAMES_OPTIONS} onChange={setMinimumGames} ariaLabel="Minimum games" triggerClassName="min-h-[44px] px-2.5 py-2 lg:min-h-0" /></label>
                <div className="flex items-end md:col-span-3"><span className="text-[10px] text-txt/[0.38]">Filters apply to the selected view and preserve the server&apos;s order.</span><button type="button" onClick={() => { setMinPickRate(DEFAULT_DRAFT_ASSISTANT_FILTERS.minPickRate); setIncludeOffMeta(DEFAULT_DRAFT_ASSISTANT_FILTERS.includeOffMeta); setMinimumGames(DEFAULT_DRAFT_ASSISTANT_FILTERS.minimumGames); }} className="ml-auto rounded-[6px] px-2 py-1 text-[10px] font-medium text-accent-300 hover:bg-accent/[0.1] focus-visible:outline-2 focus-visible:outline-accent">Reset</button></div>
              </section>
            )}

            <DraftPicksTable
              rows={currentViewRows}
              champIcons={champIcons}
              laneAverageValue={detailAverage}
              sort={detailSort}
              onSortChange={(nextSort) => { if (!preserveDetailOrder) { setDetailSort(nextSort); setShowFullTable(false); } }}
              selectedChampionId={selectedDetailChampionId}
              onSelect={setSelectedDetailChampionId}
              showAll={showFullTable}
              onShowAll={() => setShowFullTable(true)}
              preserveOrder={preserveDetailOrder}
              showNoEnemyBlindHint={assistantView === "recommended" && enemyIds.length === 0}
              showCountersNoEnemies={assistantView === "counters" && enemyIds.length === 0}
              suppressEmptyState={(assistantView === "counters" && enemyIds.length === 0) || (assistantView === "comfort" && !hasAnyMyPoolData)}
            />
          </div>

          <aside className="min-w-0 space-y-3 lg:sticky lg:top-4">
            <div className="[&_span.truncate]:w-[110px]">
              <DraftCompBars enemyIds={enemyIds} />
            </div>
            <DraftMatchupGrid candidates={matchupRows} enemyIds={enemyIds} champIcons={champIcons} previews={matchupPreviewMap} />
            <DraftLockInCard />
          </aside>
        </div>

        <footer className="mt-8 border-t border-txt/[0.08] pt-3 text-center text-[10px] text-txt/[0.32]">
          <p>Suggestions only — statistical trends, not a recommendation to auto-pick. Never applied to the client automatically.</p>
          <p className="mt-1">Build data © coachless.gg / Riot Games. Not endorsed by Riot Games.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="mt-1">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </main>
  );
}
