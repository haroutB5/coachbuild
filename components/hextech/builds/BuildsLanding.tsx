"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { MagnifyingGlass, TrendUp, ArrowUpRight, ArrowDownRight } from "@phosphor-icons/react";
import type { ChampionRef } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";
import { LANE_LABEL, LANE_ORDER, getHeroStats } from "@/components/hextech/heroContracts";
import { buildMyStatsRows, fetchMyStatsSummary, type MyStatsChampionRow } from "@/components/hextech/myStats";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import { emitChampionSearch } from "@/components/hextech/championSearchBus";
import { readRecentChampions, type RecentChampionEntry } from "@/lib/recentChampions";
import { CARD_CLASS, Scanline, SectionLabel, TierBadge } from "./BuildVisuals";

const EMPTY_RECENT_CHAMPIONS: RecentChampionEntry[] = [];
let recentChampionsSnapshot = EMPTY_RECENT_CHAMPIONS;
const subscribeToRecentChampions = () => () => {};
function getRecentChampionsSnapshot(): RecentChampionEntry[] {
  const next = readRecentChampions();
  if (
    next.length === recentChampionsSnapshot.length &&
    next.every((entry, index) => {
      const previous = recentChampionsSnapshot[index];
      return previous?.championId === entry.championId && previous?.lane === entry.lane;
    })
  ) {
    return recentChampionsSnapshot;
  }
  recentChampionsSnapshot = next;
  return recentChampionsSnapshot;
}

interface Mover {
  championId: number;
  championName: string;
  role: number;
  deltaPp: number;
}

interface MoversResponse {
  patch: string;
  prevPatch: string;
  movers: Mover[];
}

interface TierRow {
  champion: ChampionRef;
  winRate: number | null;
  games: number | null;
  delta: number | null;
}

const ROLE_TO_LANE: LaneId[] = ["top", "jungle", "mid", "bot", "support"];
const BUILD_SEARCH_LISTBOX_ID = "builds-champion-listbox";
const buildSearchOptionId = (index: number) => `builds-champion-opt-${index}`;

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function games(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function gamesLabel(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "game" : "games"}`;
}

function championRefFromIcon(id: number, entry: ChampionIconEntry | undefined): ChampionRef | null {
  if (!entry) return null;
  const key = entry.icon.match(/\/champion\/([^/.]+)\./)?.[1] ?? entry.name.replace(/\s+/g, "");
  return { id, key, name: entry.name, icon: entry.icon, difficulty: entry.difficulty, tags: entry.tags };
}

function Art({ champion, size = 34 }: { champion: ChampionRef; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-[linear-gradient(150deg,#2b2e42,#1c1e2c)] shadow-[inset_0_0_0_1px_rgba(233,233,237,0.12)]" style={{ width: size, height: size }}>
      <IconWithFallback src={champion.icon} alt={champion.name} fallbackGlyph={champion.name} className="h-full w-full object-cover" size={size} />
    </span>
  );
}

function SearchResults({
  matches,
  open,
  activeIndex,
  onActiveIndexChange,
  onPick,
}: {
  matches: ChampionRef[];
  open: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onPick: (champion: ChampionRef) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open || !matches.length) return null;
  return (
    <div className="absolute left-0 right-0 top-[50px] z-20 overflow-hidden rounded-[8px] bg-[#232532] p-1 shadow-[0_14px_30px_rgba(0,0,0,0.45),inset_0_0_0_1px_rgba(233,233,237,0.12)]">
      <ul ref={listRef} id={BUILD_SEARCH_LISTBOX_ID} role="listbox" className="max-h-[240px] overflow-y-auto">
        {matches.map((champion, index) => {
          const isActive = index === activeIndex;
          return (
            <li key={champion.id} id={buildSearchOptionId(index)} data-idx={index} role="option" aria-selected={isActive}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onPick(champion)}
                onMouseEnter={() => onActiveIndexChange(index)}
                className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-[12px] text-[#e9e9ed] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] ${isActive ? "bg-[#9184d9]/15" : "hover:bg-white/[0.05]"}`}
              >
                <Art champion={champion} size={28} />
                <span>{champion.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One "pick up where you left off" card.
 *
 * The win rate / games / bar block is the user's OWN ranked-solo record on this
 * champion+lane, which very often does not exist — a champion viewed in champ
 * select is not a champion played. It used to render that absence as a 22px
 * "—" beside a "—g" and a 0%-filled track, i.e. three placeholder shapes that
 * each read as a broken value (hard rule 4's spirit: an absence must look like
 * an absence, not like a figure that failed to load). The whole block is now
 * conditional — when there is no record the card says so in one quiet line and
 * draws no bar, because a bar with nothing to encode is noise.
 */
function RecentCard({ champion, lane, winRate, gamesCount, onPick }: { champion: ChampionRef; lane: LaneId; winRate: number | null; gamesCount: number | null; onPick: () => void }) {
  const measured = winRate !== null && gamesCount !== null;
  const share = winRate === null ? 0 : Math.max(0, Math.min(100, winRate));
  const barTone = winRate !== null && winRate >= 50 ? "bg-good" : "bg-bad";
  return (
    <button
      type="button"
      onClick={onPick}
      className="min-w-0 rounded-[8px] bg-[#232532] p-3 text-left shadow-[inset_0_0_0_1px_rgba(233,233,237,0.08)] transition-colors hover:bg-[#2a2c3b] hover:shadow-[inset_0_0_0_1px_rgba(145,132,217,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9]"
    >
      <div className="flex items-center gap-2.5">
        <Art champion={champion} size={38} />
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-semibold text-[#e9e9ed]">{champion.name}</span>
          <span className="mt-0.5 block text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/60">{LANE_LABEL[lane]}</span>
        </span>
      </div>
      {measured ? (
        <>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
            <span className="text-[22px] font-semibold leading-none tabular-nums text-[#e9e9ed]">{pct(winRate)}</span>
            <span className="text-[10px] tabular-nums text-[#9397ab]/60">{gamesLabel(gamesCount)}</span>
          </div>
          <div className="mt-2 h-1 rounded-full bg-white/[0.06]" role="img" aria-label={`Your win rate on ${champion.name} ${LANE_LABEL[lane]}: ${pct(winRate)} over ${gamesLabel(gamesCount)}`}>
            <span className={`block h-full rounded-full ${barTone}`} style={{ width: `${share}%` }} />
          </div>
        </>
      ) : (
        <p className="mt-3 text-[10px] leading-relaxed text-[#9397ab]/55">No ranked games recorded this season</p>
      )}
    </button>
  );
}

// Placeholder rows shown WHILE the tier list is loading, so the card never
// asserts "No mid-lane tier data is available yet." before the data has had
// its chance to arrive (hard rule 4 — a definitive negative used as a loading
// state is a dishonest signal). The pulse is disabled under prefers-reduced-
// motion; the grid template matches a real row so the layout does not jump
// when the data lands.
function TierListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="grid w-full grid-cols-[28px_30px_minmax(0,1fr)_70px_52px] items-center gap-2 border-t border-white/[0.05] px-3 py-2.5 first:border-t-0"
        >
          <span className="mx-auto h-3 w-3 rounded bg-white/[0.06] motion-safe:animate-pulse" />
          <span className="h-4 w-6 rounded bg-white/[0.06] motion-safe:animate-pulse" />
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-7 w-7 shrink-0 rounded bg-white/[0.06] motion-safe:animate-pulse" />
            <span className="h-3 w-20 rounded bg-white/[0.06] motion-safe:animate-pulse" />
          </span>
          <span className="h-1 rounded-full bg-white/[0.06]" />
          <span className="ml-auto h-3 w-10 rounded bg-white/[0.06] motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function TierList({ rows, status, onPick }: { rows: TierRow[]; status: "loading" | "ready"; onPick: (champion: ChampionRef) => void }) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <SectionLabel>Mid lane tier list</SectionLabel>
        <span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/50" aria-live="polite">{status === "loading" ? "loading…" : "current sample"}</span>
      </div>
      <div className={`${CARD_CLASS} overflow-hidden`}>
        {status === "loading" && !rows.length ? <TierListSkeleton /> : rows.length ? rows.map((row, index) => {
          const deltaTone = row.delta === null ? "text-[#9397ab]/60" : row.delta >= 0 ? "text-[#46c79b]" : "text-[#e8736e]";
          const barTone = row.winRate === null ? "bg-accent" : row.winRate >= 50 ? "bg-good" : "bg-bad";
          return (
            <button
              key={row.champion.id}
              type="button"
              onClick={() => onPick(row.champion)}
              className="grid w-full grid-cols-[28px_30px_minmax(0,1fr)_70px_52px] items-center gap-2 border-t border-white/[0.05] px-3 py-2.5 text-left first:border-t-0 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#9184d9]"
            >
              <span className="text-center text-[11px] tabular-nums text-[#9397ab]/45">{index + 1}</span>
              <TierBadge tier={index === 0 ? "S+" : index < 3 ? "S" : index < 5 ? "A" : "B"} />
              <span className="flex min-w-0 items-center gap-2">
                <Art champion={row.champion} size={28} />
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold text-[#e9e9ed]">{row.champion.name}</span>
                  <span className="block truncate text-[9px] text-[#9397ab]/60">{row.games === null ? "data pending" : `${games(row.games)} games`}</span>
                </span>
              </span>
              <span className="h-1 rounded-full bg-white/[0.06]"><span className={`block h-full rounded-full ${barTone}`} style={{ width: `${Math.max(4, Math.min(100, row.winRate ?? 0))}%` }} /></span>
              <span className="text-right text-[12px] font-semibold tabular-nums text-[#e9e9ed]">{pct(row.winRate)} <span className={`block text-[10px] ${deltaTone}`}>{row.delta === null ? "—" : `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)}`}</span></span>
            </button>
          );
        }) : (
          <div className="px-3 py-4 text-[11px] text-[#9397ab]/65">No mid-lane tier data is available yet.</div>
        )}
      </div>
    </section>
  );
}

function LanesCard({ rows, onPick }: { rows: MyStatsChampionRow[]; onPick: (id: number, lane: LaneId) => void }) {
  const byLane = new Map<LaneId, MyStatsChampionRow>();
  for (const row of rows) {
    const lane = ROLE_TO_LANE[row.role];
    if (lane && !byLane.has(lane)) byLane.set(lane, row);
  }
  const laneValues = LANE_ORDER.map((lane) => byLane.get(lane));
  const maxGames = Math.max(...laneValues.map((row) => row?.games ?? 0), 1);
  return (
    <section className={`${CARD_CLASS} p-4`}>
      <div className="mb-3 flex items-baseline justify-between"><SectionLabel>Your lanes · this season</SectionLabel><span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/50">My Stats</span></div>
      <div className="space-y-3">
        {LANE_ORDER.map((lane) => {
          const row = byLane.get(lane);
          // This width is a share of games played relative to the user's
          // busiest lane, not a win-rate signal; keep its fill neutral.
          const width = Math.round(((row?.games ?? 0) / maxGames) * 100);
          return (
            <button key={lane} type="button" onClick={() => row && onPick(row.championId, lane)} disabled={!row} className="grid min-h-[44px] w-full grid-cols-[34px_minmax(0,1fr)_38px] items-center gap-2 text-left disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:min-h-0">
              <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-[#9397ab]/55">{lane === "jungle" ? "JG" : lane === "support" ? "SUP" : lane.slice(0, 3).toUpperCase()}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5"><span className="truncate text-[11px] font-medium text-[#e9e9ed]/80">{row?.name ?? "No games"}</span>{row && <span className="shrink-0 text-[10px] tabular-nums text-[#9397ab]/55">{pct(row.winrate * 100)}</span>}</span>
                {/* No row means no share to draw. A 4%-wide stub bar under
                    "No games" reads as a real (tiny) value, so draw nothing. */}
                {row && <span className="mt-1 block h-1 rounded-full bg-white/[0.06]"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(3, width)}%` }} /></span>}
              </span>
              <span className="text-right text-[10px] tabular-nums text-[#9397ab]/55">{row ? `${row.games}g` : ""}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function TrendingCard({ data, iconMap, onPick }: { data: MoversResponse | null; iconMap: Map<number, ChampionIconEntry>; onPick: (id: number, lane: LaneId) => void }) {
  return (
    <section className={`${CARD_CLASS} p-4`}>
      <div className="mb-3 flex items-baseline justify-between"><SectionLabel>Trending this patch</SectionLabel><span className="text-[9px] tabular-nums text-[#9397ab]/50">{data ? `${data.prevPatch} → ${data.patch}` : "—"}</span></div>
      {data?.movers.length ? <div className="divide-y divide-white/[0.05]">{data.movers.slice(0, 5).map((mover) => {
        const entry = iconMap.get(mover.championId);
        const champ = championRefFromIcon(mover.championId, entry);
        const lane = mover.role >= 0 && mover.role <= 4 ? ROLE_TO_LANE[mover.role] : "mid";
        const positive = mover.deltaPp >= 0;
        return <button key={`${mover.championId}-${mover.role}`} type="button" onClick={() => onPick(mover.championId, lane)} className="flex w-full items-center gap-2.5 py-2.5 text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#9184d9]">{champ ? <Art champion={champ} size={28} /> : <span className="h-7 w-7 rounded-[6px] bg-white/[0.06]" />}<span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-medium text-[#e9e9ed]/85">{mover.championName}</span><span className="block text-[9px] uppercase tracking-[0.08em] text-[#9397ab]/55">{LANE_LABEL[lane]}</span></span><span className={`flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${positive ? "text-[#46c79b]" : "text-[#e8736e]"}`}>{positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{positive ? "+" : ""}{mover.deltaPp.toFixed(2)}pp</span></button>;
      })}</div> : <div className="text-[11px] leading-relaxed text-[#9397ab]/65">Patch mover data is not available yet.</div>}
      <Link href="/movers" className="mt-3 inline-flex min-h-[44px] items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#b5abfc] hover:text-[#d2cefd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9184d9] lg:min-h-0"><TrendUp size={13} /> See all patch movers</Link>
    </section>
  );
}

export default function BuildsLanding({ onQuickPick }: { onQuickPick: (championId: number, lane: LaneId) => void }) {
  const [champions, setChampions] = useState<ChampionRef[]>([]);
  const [iconMap, setIconMap] = useState<Map<number, ChampionIconEntry>>(new Map());
  const recent = useSyncExternalStore(subscribeToRecentChampions, getRecentChampionsSnapshot, () => EMPTY_RECENT_CHAMPIONS);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [myRows, setMyRows] = useState<MyStatsChampionRow[]>([]);
  const [movers, setMovers] = useState<MoversResponse | null>(null);
  const [tierRows, setTierRows] = useState<TierRow[]>([]);
  // The tier list loads in two chained hops (champions → per-champion
  // hero-stats), so for up to a second — longer on a slow link — `tierRows` is
  // legitimately empty while requests are still in flight. Rendering the
  // "No mid-lane tier data is available yet." absence claim during that window
  // is a dishonest negative (hard rule 4): it asserts data is ABSENT while it
  // is merely LOADING. `tierStatus` distinguishes the two so the absence text
  // only shows once loading has genuinely settled empty. `baseLoaded` marks
  // the first data hop as done (success OR failure) so a total fetch failure
  // still settles to a real empty state instead of a permanent skeleton.
  //
  // `tierStatus` is DERIVED, not stored: the "nothing to fetch" settle used to
  // be a setState in the effect body (a cascading render, and a lint error),
  // and it is really just a fact about state we already hold — the first hop
  // finished and produced no candidates.
  const [tierFetchSettled, setTierFetchSettled] = useState(false);
  const [baseLoaded, setBaseLoaded] = useState(false);

  const searchMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return champions.filter((champion) => champion.name.toLowerCase().includes(needle)).slice(0, 6);
  }, [champions, query]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/champions").then((response) => response.ok ? response.json() as Promise<ChampionRef[]> : []),
      getChampionIconMap(),
      fetchMyStatsSummary(),
      fetch("/api/patch-movers").then((response) => response.ok ? response.json() as Promise<MoversResponse> : null).catch(() => null),
    ]).then(([championList, map, summary, moverData]) => {
      if (cancelled) return;
      setChampions(Array.isArray(championList) ? championList : []);
      setIconMap(map);
      if (summary && !summary.accountUnresolved) setMyRows(buildMyStatsRows(summary.records.filter((row) => row.role >= 0 && row.role <= 4), (id) => map.get(id)));
      setMovers(moverData && Array.isArray(moverData.movers) ? moverData : null);
    }).catch(() => {
      // Landing is a navigation surface; each card owns its honest empty state.
    }).finally(() => {
      // First data hop is done regardless of outcome — lets the tier-list
      // effect below settle a genuinely-empty result out of "loading" even
      // when /api/champions failed and `champions` never populated.
      if (!cancelled) setBaseLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const midCandidates = useMemo(() => {
    const candidates = new Map<number, ChampionRef>();
    for (const champion of champions) if (!candidates.has(champion.id)) candidates.set(champion.id, champion);
    for (const entry of recent) {
      const champion = candidates.get(entry.championId);
      if (champion) candidates.set(champion.id, champion);
    }
    for (const row of myRows) {
      const champion = candidates.get(row.championId) ?? championRefFromIcon(row.championId, iconMap.get(row.championId));
      if (champion) candidates.set(champion.id, champion);
    }
    return Array.from(candidates.values()).slice(0, 8);
  }, [champions, iconMap, myRows, recent]);

  // Ready once the fetch has landed, or once the first hop has settled with
  // nothing to fetch. Before either, it is loading, not absent.
  const tierStatus: "loading" | "ready" = tierFetchSettled || (baseLoaded && midCandidates.length === 0) ? "ready" : "loading";

  useEffect(() => {
    let cancelled = false;
    if (!midCandidates.length) return;
    Promise.all(midCandidates.map(async (champion) => ({ champion, stats: await getHeroStats(champion.id, "mid") }))).then((entries) => {
      if (cancelled) return;
      const valid = entries.filter((entry) => entry.stats.winRatePct !== null || entry.stats.gamesCount !== null);
      const sorted = valid.sort((a, b) => (b.stats.winRatePct ?? -1) - (a.stats.winRatePct ?? -1));
      const baseline = sorted.length ? (sorted.reduce((sum, entry) => sum + (entry.stats.winRatePct ?? 0), 0) / sorted.length) : null;
      setTierRows(sorted.slice(0, 6).map(({ champion, stats }) => ({ champion, winRate: stats.winRatePct, games: stats.gamesCount, delta: baseline === null || stats.winRatePct === null ? null : stats.winRatePct - baseline })));
      setTierFetchSettled(true);
    });
    return () => { cancelled = true; };
  }, [midCandidates]);

  function pickChampion(champion: ChampionRef) {
    setQuery("");
    setSearchOpen(false);
    setSearchActiveIndex(0);
    emitChampionSearch(champion);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!searchOpen) setSearchOpen(true);
      setSearchActiveIndex((index) => Math.min(index + 1, Math.max(searchMatches.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSearchActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSearchActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setSearchActiveIndex(Math.max(searchMatches.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const champion = searchMatches[searchActiveIndex];
      if (champion) pickChampion(champion);
    } else if (event.key === "Escape") {
      setSearchOpen(false);
    }
  }

  const recentCards = recent.slice(0, 4).map((entry) => {
    const champion = champions.find((item) => item.id === entry.championId) ?? championRefFromIcon(entry.championId, iconMap.get(entry.championId));
    // Resolve the personal row ONCE. The old inline version read `?.winrate`
    // as a truthiness test, so a genuine 0% win rate (a real, common figure on
    // a 1-game champion) fell through to null and rendered as "no data".
    const record = myRows.find((row) => row.championId === entry.championId && ROLE_TO_LANE[row.role] === entry.lane) ?? null;
    return champion ? { entry, champion, record } : null;
  }).filter((entry): entry is { entry: RecentChampionEntry; champion: ChampionRef; record: MyStatsChampionRow | null } => entry !== null);

  return (
    <div className="space-y-5">
      <section className="relative overflow-visible rounded-[10px] bg-[radial-gradient(120%_180%_at_8%_0%,#2a2748,#1d1f2c_55%,#1a1c28)] px-6 py-7 shadow-[0_0_0_1px_rgba(145,132,217,0.2),0_14px_40px_rgba(0,0,0,0.24)] sm:px-7">
        <Scanline />
        <div className="relative z-10 max-w-[820px]">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#9184d9]">Builds</p>
          <h1 className="mt-2 text-[34px] font-semibold leading-none tracking-[-0.025em] text-[#e9e9ed]">What are we playing?</h1>
          <p className="mt-3 max-w-[690px] text-[13px] leading-relaxed text-[#e9e9ed]/60">Search any champion for the WPA-ranked build, the pro consensus, and what the best one-trick in your region actually does. In champ select the companion opens this for you automatically.</p>
          <div className="relative mt-4 max-w-[420px]">
            <MagnifyingGlass size={17} className="pointer-events-none absolute left-3.5 top-3.5 text-[#9184d9]" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchActiveIndex(0);
                setSearchOpen(true);
              }}
              onFocus={() => {
                setSearchOpen(true);
                setSearchActiveIndex(0);
              }}
              onClick={() => setSearchOpen(true)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search a champion…"
              aria-label="Search a champion"
              role="combobox"
              aria-expanded={searchOpen}
              aria-controls={BUILD_SEARCH_LISTBOX_ID}
              aria-autocomplete="list"
              aria-activedescendant={searchOpen && searchMatches[searchActiveIndex] ? buildSearchOptionId(searchActiveIndex) : undefined}
              className="h-11 w-full rounded-[8px] bg-[#1c1e2c] pl-10 pr-3 text-[13px] text-[#e9e9ed] shadow-[inset_0_0_0_1px_rgba(145,132,217,0.35)] outline-none placeholder:text-[#9397ab]/65 focus-visible:ring-2 focus-visible:ring-[#9184d9]"
            />
            <SearchResults
              matches={searchMatches}
              open={searchOpen}
              activeIndex={searchActiveIndex}
              onActiveIndexChange={setSearchActiveIndex}
              onPick={pickChampion}
            />
          </div>
        </div>
      </section>

      <div aria-hidden="true" className="hr" />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_372px]">
        <main className="min-w-0 space-y-5">
          <section>
            {/* flex-wrap + gap: at 390px the label and the right-aligned meta
                used to butt into each other. The meta now drops to its own
                line instead of colliding. */}
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"><SectionLabel>Pick up where you left off</SectionLabel><span className="text-[9px] uppercase tracking-[0.1em] text-[#9397ab]/45">recent on this device</span></div>
            {recentCards.length ? <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">{recentCards.map(({ entry, champion, record }) => <RecentCard key={`${entry.championId}-${entry.lane}`} champion={champion} lane={entry.lane} winRate={record ? record.winrate * 100 : null} gamesCount={record?.games ?? null} onPick={() => onQuickPick(entry.championId, entry.lane)} />)}</div> : <div className={`${CARD_CLASS} px-4 py-4 text-[11px] text-[#9397ab]/65`}>Your recent champions will appear here after your first build view.</div>}
          </section>
          <TierList rows={tierRows} status={tierStatus} onPick={pickChampion} />
        </main>
        <aside className="min-w-0 space-y-5">
          <LanesCard rows={myRows} onPick={onQuickPick} />
          <TrendingCard data={movers} iconMap={iconMap} onPick={onQuickPick} />
        </aside>
      </div>
      <p className="flex items-center gap-1.5 text-[10px] text-[#9397ab]/55"><SparkleIcon /> Search, compare, then lock in the build that fits the game.</p>
    </div>
  );
}

function SparkleIcon() {
  return <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />;
}
