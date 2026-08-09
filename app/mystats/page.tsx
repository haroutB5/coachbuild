"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import MyStatsRefresher from "@/components/hextech/MyStatsRefresher";
import AccountPicker from "@/components/hextech/mystats/AccountPicker";
import PostGameReview from "@/components/hextech/postgame/PostGameReview";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { selectAccount } from "@/components/live/mystatsAccount";
import {
  buildMyStatsRows,
  computeHistoryCoverage,
  computeMainChampion,
  computeMyStatsOverall,
  computeRecentWinLoss,
  getMyStatsScopeLabels,
  normalizeMyStatsSummary,
  type IconEntry,
  type MyStatsRecentGame,
  type MyStatsSummary,
} from "@/components/hextech/myStats";

type SummaryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; summary: MyStatsSummary };

function relativeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[9px] bg-panel-glass px-5 py-10 text-center shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <p className="text-[13px] font-semibold text-txt">{title}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-mut">{body}</p>
    </div>
  );
}

function AccountChip({ summary, onSwitch }: { summary: MyStatsSummary; onSwitch: (id: number) => void }) {
  const activeId = summary.accountId ?? summary.accounts?.find((a) => a.active)?.id ?? null;
  const active = summary.accounts?.find((account) => account.id === activeId) ?? null;
  const riotId = summary.riotId ?? active?.riotId ?? "No account active";
  const latest = summary.records.reduce<string | null>((best, row) => {
    if (!best) return row.lastPlayed;
    return Date.parse(row.lastPlayed) > Date.parse(best) ? row.lastPlayed : best;
  }, null);
  const age = relativeAge(latest);

  if ((summary.accounts?.length ?? 0) <= 1) {
    return (
      <div className="rounded-[8px] bg-panel-glass px-3 py-2 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
        <p className="text-[11px] font-semibold text-txt">{riotId}</p>
        <p className="mt-0.5 text-[10px] text-mut">{age ? `Latest stored game ${age}` : "Account synced when data is available"}</p>
      </div>
    );
  }

  return (
    <label className="flex items-center gap-2 rounded-[8px] bg-panel-glass px-2.5 py-2 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <span className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-teal/15 text-[10px] font-semibold text-teal">
        {active?.region?.slice(0, 2).toUpperCase() ?? "ID"}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold text-txt">{riotId}</span>
        <span className="block text-[10px] text-mut">{age ? `Latest stored game ${age}` : "Account synced when data is available"}</span>
      </span>
      <select
        value={activeId ?? ""}
        onChange={(event) => {
          const id = Number(event.target.value);
          if (Number.isFinite(id)) onSwitch(id);
        }}
        aria-label="Choose My Stats account"
        className="ml-1 min-h-[44px] min-w-[44px] max-w-[44px] cursor-pointer appearance-none bg-transparent text-transparent outline-none focus-visible:ring-2 focus-visible:ring-teal lg:min-h-0 lg:min-w-0 lg:max-w-[22px]"
      >
        {summary.accounts?.map((account) => (
          <option key={account.id} value={account.id} className="bg-panel text-txt">
            {account.riotId}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatTile({ label, value, sublabel, width, accent = false }: { label: string; value: React.ReactNode; sublabel: string; width: number; accent?: boolean }) {
  return (
    <section className={`rounded-[9px] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] ${accent ? "bg-teal/[0.06] shadow-[inset_0_0_0_1px_rgba(145,132,217,.22)]" : "bg-panel-glass"}`}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-mut">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <p className={`min-w-0 truncate text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${accent ? "text-teal" : "text-txt"}`}>{value}</p>
        <p className="truncate text-[10px] text-mut">{sublabel}</p>
      </div>
      <div className="mt-3 h-1 rounded-full bg-white/[0.06]">
        <div className={`h-full rounded-full ${accent ? "bg-teal" : "bg-white/85"}`} style={{ width: `${Math.max(0, Math.min(100, width))}%` }} />
      </div>
    </section>
  );
}

function adherenceByChampion(games: MyStatsRecentGame[]) {
  const values = new Map<number, { resolved: number; on: number }>();
  for (const game of games) {
    if (game.onWpaBuild === null || game.onWpaBuild === undefined) continue;
    const current = values.get(game.championId) ?? { resolved: 0, on: 0 };
    current.resolved += 1;
    if (game.onWpaBuild) current.on += 1;
    values.set(game.championId, current);
  }
  return values;
}

function ChampionPool({ rows, recentGames }: { rows: ReturnType<typeof buildMyStatsRows>; recentGames: MyStatsRecentGame[] }) {
  const adherence = adherenceByChampion(recentGames);
  if (rows.length === 0) {
    return <EmptyState title="No champion pool data yet" body="Recorded ranked solo games will appear here once the active account has a season history." />;
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-[9px] bg-panel-glass shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <div className="flex items-baseline justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mut">Champion pool</p>
        <p className="text-[10px] text-mut tabular-nums">{rows.length} rows · {rows.reduce((sum, row) => sum + row.games, 0)} games</p>
      </div>
      <div className="hidden grid-cols-[minmax(150px,1fr)_52px_72px_72px_92px] gap-2 bg-white/[0.025] px-4 py-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-mut sm:grid sm:grid-cols-[minmax(220px,1fr)_68px_82px_82px_112px] sm:px-5">
        <span>Champion</span><span className="text-right">Games</span><span className="text-right">Win rate</span><span className="text-right">CS/min</span><span className="text-right">Adherence</span>
      </div>
      <div className="hidden overflow-x-auto sm:block">
        {rows.map((row) => {
          const sample = adherence.get(row.championId);
          const samplePct = sample && sample.resolved > 0 ? Math.round((sample.on / sample.resolved) * 100) : null;
          const csThin = row.csPerMin !== null && row.csGames < row.games;
          return (
            <Link key={`${row.championId}-${row.role}`} href={`/?championId=${row.championId}&role=${row.role}`} className="grid min-w-[520px] grid-cols-[minmax(150px,1fr)_52px_72px_72px_92px] items-center gap-2 border-t border-white/[0.06] px-4 py-2.5 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal sm:min-w-[650px] sm:grid-cols-[minmax(220px,1fr)_68px_82px_82px_112px] sm:px-5">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-black/25 shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)]"><IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="h-full w-full object-cover" size={32} /></span>
                <span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-txt">{row.name}</span><span className="block text-[9px] uppercase tracking-[0.08em] text-mut">{row.roleLabel}</span></span>
              </span>
              <span className="text-right text-[12px] text-mut tabular-nums">{row.games}</span>
              <span className={`text-right text-[12px] font-semibold tabular-nums ${row.lowSample ? "text-mut" : row.winrate >= 0.5 ? "text-good" : "text-bad"}`}>{formatPct(row.winrate)}</span>
              <span className={`text-right text-[12px] tabular-nums ${csThin ? "text-mut/60" : "text-mut"}`} title={row.csPerMin === null ? "CS/min was not measured for this row." : `${row.csGames} games behind this CS/min value.`}>{row.csPerMin === null ? "—" : row.csPerMin.toFixed(1)}</span>
              <span className="flex items-center justify-end gap-2" title={samplePct === null ? "Champion-specific adherence is not present in the available recent-game sample." : `Recent champion adherence over ${sample?.resolved} resolved games.`}>
                <span className="h-1.5 w-10 overflow-hidden rounded-full bg-white/[0.07]">{samplePct !== null && <span className="block h-full rounded-full bg-teal" style={{ width: `${samplePct}%` }} />}</span>
                <span className={`w-8 text-right text-[11px] tabular-nums ${samplePct === null ? "text-mut/50" : "text-mut"}`}>{samplePct === null ? "—" : `${samplePct}%`}</span>
              </span>
            </Link>
          );
        })}
      </div>
      <div className="divide-y divide-white/[0.06] sm:hidden">
        {rows.map((row) => {
          const sample = adherence.get(row.championId);
          const samplePct = sample && sample.resolved > 0 ? Math.round((sample.on / sample.resolved) * 100) : null;
          const csThin = row.csPerMin !== null && row.csGames < row.games;
          return (
            <Link key={`${row.championId}-${row.role}`} href={`/?championId=${row.championId}&role=${row.role}`} className="flex min-h-[72px] items-center gap-2.5 px-4 py-3 transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-black/25 shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)]"><IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="h-full w-full object-cover" size={32} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-txt">{row.name}</span>
                <span className="mt-0.5 block truncate text-[9px] uppercase tracking-[0.08em] text-mut">{row.roleLabel} · {row.games} games</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={`block text-[12px] font-semibold tabular-nums ${row.lowSample ? "text-mut" : row.winrate >= 0.5 ? "text-good" : "text-bad"}`}>{formatPct(row.winrate)}</span>
                <span className="mt-0.5 block text-[9px] tabular-nums text-mut/70">CS {row.csPerMin === null ? "—" : row.csPerMin.toFixed(1)}{csThin ? " · thin" : ""} · {samplePct === null ? "—" : `${samplePct}%`} adh</span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function PatternCard({ summary, games, overall }: { summary: MyStatsSummary; games: MyStatsRecentGame[]; overall: ReturnType<typeof computeMyStatsOverall> }) {
  const adherence = summary.buildAdherencePct;
  if (adherence === null || adherence === undefined || overall.games <= 0) return null;
  const recent = computeRecentWinLoss(games);
  return (
    <section className="rounded-[9px] bg-teal/[0.06] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(145,132,217,.22)] sm:px-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal">The pattern</p>
      <p className="mt-2 text-[13px] leading-relaxed text-txt">
        You are at <span className="font-semibold tabular-nums">{formatPct(overall.winrate)}</span> over <span className="font-semibold tabular-nums">{overall.games}</span> recorded games, with <span className="font-semibold tabular-nums">{Math.round(adherence)}%</span> build adherence across the comparable season sample.
      </p>
      {recent.n > 0 && <p className="mt-2 text-[11px] leading-relaxed text-mut">The last {recent.n} recorded games are {recent.wins}W–{recent.losses}L. These are connected observations, not a causal verdict.</p>}
    </section>
  );
}

function LastTwenty({ games, iconOf }: { games: MyStatsRecentGame[]; iconOf: (id: number) => IconEntry | undefined }) {
  const visible = games.slice(0, 20);
  return (
    <section className="rounded-[9px] bg-panel-glass px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:px-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mut">Last 20 games</p>
        <p className="text-[10px] text-mut tabular-nums">{visible.length} recorded</p>
      </div>
      {visible.length === 0 ? <p className="mt-3 text-[11.5px] text-mut">No recent games recorded yet.</p> : <>
        <div className="mt-3 grid grid-cols-10 gap-1">
          {visible.map((game, index) => {
            const icon = iconOf(game.championId);
            const name = icon?.name ?? `Champion #${game.championId}`;
            return <span key={`${game.championId}-${index}`} title={`${name} · ${game.win ? "win" : "loss"}`} aria-label={`${name}, ${game.win ? "win" : "loss"}`} className={`h-7 w-full rounded-[4px] ${game.win ? "bg-good/25 ring-1 ring-good/60" : "bg-bad/20 ring-1 ring-bad/55"}`} />;
          })}
        </div>
        <div className="mt-3 flex items-center gap-3 text-[10px] text-mut"><span><span className="text-good tabular-nums">{visible.filter((game) => game.win).length}</span> wins</span><span><span className="text-bad tabular-nums">{visible.filter((game) => !game.win).length}</span> losses</span></div>
      </>}
    </section>
  );
}

function MyStatsSurface({ summary, icons, onSwitch }: { summary: MyStatsSummary; icons: Map<number, ChampionIconEntry>; onSwitch: (id: number) => void }) {
  const rows = buildMyStatsRows(summary.records, (id) => icons.get(id));
  const overall = computeMyStatsOverall(summary.records);
  const main = computeMainChampion(summary.records, (id) => icons.get(id));
  const recentGames = summary.recentGames ?? [];
  const coverage = computeHistoryCoverage({ accountUnresolved: summary.accountUnresolved, historyComplete: summary.historyComplete, games: overall.games });
  const scope = getMyStatsScopeLabels(coverage.seasonClaimSafe);
  const adherence = summary.buildAdherencePct;
  const latest = summary.records.length > 0 ? Math.max(...summary.records.map((row) => Date.parse(row.lastPlayed)).filter(Number.isFinite)) : NaN;
  const age = Number.isFinite(latest) ? relativeAge(new Date(latest).toISOString()) : null;

  if (summary.accountUnresolved) {
    return <EmptyState title="No account is active yet" body="Link a Riot account through the companion, then return here to see ranked solo stats." />;
  }

  return (
    <>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-teal">RANKED SOLO · {coverage.seasonClaimSafe ? "FULL SEASON" : "RECORDED SO FAR"} · DISPLAY ONLY</p>
          <h1 className="mt-1.5 text-[34px] font-semibold leading-none tracking-[-0.025em] text-txt">My Stats</h1>
        </div>
        <AccountChip summary={summary} onSwitch={onSwitch} />
      </div>

      {coverage.pill && <p className="mt-3 text-[11px] text-mut" title={coverage.pill.title}>{coverage.pill.text} · {coverage.games} games stored so far</p>}
      {overall.games === 0 ? (
        <div className="mt-5"><EmptyState title={coverage.seasonClaimSafe ? "No games yet this season" : "Still collecting your games"} body="The ranked solo history is empty for the active account. Refresh after the next match is recorded." /></div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Games" value={overall.games} sublabel={coverage.seasonClaimSafe ? "this season" : "recorded"} width={100} />
            <StatTile label="Win rate" value={formatPct(overall.winrate)} sublabel={`${overall.wins}W · ${overall.losses}L`} width={overall.winrate * 100} />
            <StatTile label="Main" value={main?.name ?? "—"} sublabel={main ? `${main.games} games` : "not measured"} width={main && overall.games > 0 ? (main.games / overall.games) * 100 : 0} />
            <StatTile label="Build adherence" value={adherence === null || adherence === undefined ? "—" : `${Math.round(adherence)}%`} sublabel={adherence === null || adherence === undefined ? "not measured" : "season avg"} width={adherence ?? 0} accent />
          </div>

          <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_372px]">
            <ChampionPool rows={rows} recentGames={recentGames} />
            <aside className="space-y-4">
              <PatternCard summary={summary} games={recentGames} overall={overall} />
              <LastTwenty games={recentGames} iconOf={(id) => icons.get(id)} />
            </aside>
          </div>
        </>
      )}

      <p className="mt-5 text-[11px] text-mut">{age ? `Latest stored game ${age}.` : "Stats are shown from the active account's stored ranked solo history."} Personal data is display-only and never changes a recommendation score.</p>
    </>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-label="Loading My Stats">
      <div className="h-12 w-64 rounded bg-panel-glass" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-[106px] rounded-[9px] bg-panel-glass" />)}</div>
      <div className="h-[360px] rounded-[9px] bg-panel-glass" />
    </div>
  );
}

function MyStatsContent() {
  const searchParams = useSearchParams();
  const isPostGame = searchParams.get("intent") === "game-detail";
  const [state, setState] = useState<SummaryState>({ status: "loading" });
  const [icons, setIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const [refreshKey, setRefreshKey] = useState(0);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((map) => {
      if (!cancelled) setIcons(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/mystats/summary")
      .then(async (response) => {
        if (!response.ok) throw new Error("summary request failed");
        return response.json();
      })
      .then((raw) => {
        if (!cancelled) {
          // Keep all wire-shape validation in the shared normalizer. The page
          // never renders raw API fields or assumes a missing value is zero.
          const summary = normalizeMyStatsSummary(raw);
          setState(summary ? { status: "ok", summary } : { status: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function handleSwitch(id: number) {
    setSwitchError(null);
    const result = await selectAccount(id);
    if (!result.ok) {
      setSwitchError("Account switch was not completed. The current stats remain selected.");
      return;
    }
    if (result.result.switched) {
      setState({ status: "loading" });
      setRefreshKey((key) => key + 1);
  }
}

  if (state.status === "loading") {
    return <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6"><Skeleton /></main>;
  }

  if (state.status === "error") {
    return <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6"><EmptyState title="Couldn&apos;t load My Stats" body="Your personal ranked history could not be read right now. Refresh to try again." /></main>;
  }

  const iconOf = (id: number): IconEntry | undefined => icons.get(id);
  const showAccountLinking = state.summary.accountUnresolved || (state.summary.accounts?.length ?? 0) === 0;
  return (
    <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6">
      <MyStatsRefresher onRefreshed={() => setRefreshKey((key) => key + 1)} />
      {isPostGame ? <PostGameReview summary={state.summary} iconOf={iconOf} /> : <MyStatsSurface summary={state.summary} icons={icons} onSwitch={handleSwitch} />}
      {showAccountLinking && <AccountPicker accounts={state.summary.accounts ?? []} activeRiotId={state.summary.riotId} activeId={state.summary.accountId ?? null} onSwitched={() => { setState({ status: "loading" }); setRefreshKey((key) => key + 1); }} collapsed={false} />}
      {switchError && <p className="mt-3 text-[11px] text-bad" role="status">{switchError}</p>}
      <footer className="mt-10 border-t border-white/[0.06] pt-4 text-[11px] text-mut">Your own match history · shown for context only, never blended into any recommendation or ranking.</footer>
    </main>
  );
}

export default function MyStatsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-6">
          <Skeleton />
        </main>
      }
    >
      <MyStatsContent />
    </Suspense>
  );
}
