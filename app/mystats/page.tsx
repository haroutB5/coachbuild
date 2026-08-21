"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import MyStatsRefresher from "@/components/hextech/MyStatsRefresher";
import SessionPanel, { type SessionPanelProps } from "@/components/hextech/SessionPanel";
import AccountPicker from "@/components/hextech/mystats/AccountPicker";
import PostGameReview from "@/components/hextech/postgame/PostGameReview";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
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
  | { status: "ok"; summary: MyStatsSummary; sessions: SessionPanelProps["sessions"] };

function summarySessions(raw: unknown): SessionPanelProps["sessions"] {
  if (!raw || typeof raw !== "object") return [];
  const sessions = (raw as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? (sessions as SessionPanelProps["sessions"]) : [];
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-[9px] bg-panel-glass px-5 py-10 text-center shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <p className="text-[13px] font-semibold text-txt">{title}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-mut">{body}</p>
    </div>
  );
}

/**
 * One headline figure.
 *
 * Two things this tile deliberately refuses to do, both fixed after a phone
 * screenshot showed them side by side:
 *
 * - **A bar that encodes nothing.** `width` is the 0-100 SHARE the bar draws.
 *   `null` means this figure has no ratio (a raw count of games is not a
 *   percentage of anything), and the tile then draws no track at all. It used
 *   to pass `width={100}` for GAMES, producing a full solid bar that looked
 *   like a maxed-out meter.
 * - **A missing figure rendered as a 30px dash.** `value: null` means the
 *   figure genuinely is not measured; the tile says so in words. An em-dash at
 *   headline size reads as a stub bar, not as an absence.
 */
function StatTile({ label, value, sublabel, width = null, barLabel, accent = false }: { label: string; value: React.ReactNode | null; sublabel?: string; width?: number | null; barLabel?: string; accent?: boolean }) {
  return (
    <section className={`rounded-[9px] px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] ${accent ? "bg-teal/[0.06] shadow-[inset_0_0_0_1px_rgba(145,132,217,.22)]" : "bg-panel-glass"}`}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-mut">{label}</p>
      {value === null ? (
        <p className="mt-2.5 text-[13px] leading-none text-mut">Not measured yet</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
          <p className={`min-w-0 truncate text-[30px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${accent ? "text-teal" : "text-txt"}`}>{value}</p>
          {sublabel && <p className="truncate text-[10px] text-mut">{sublabel}</p>}
        </div>
      )}
      {width !== null && (
        <div className="mt-3 h-1 rounded-full bg-white/[0.06]" role="img" aria-label={barLabel ?? `${label}: ${Math.round(width)} percent`}>
          <div className={`h-full rounded-full ${accent ? "bg-teal" : "bg-white/85"}`} style={{ width: `${Math.max(0, Math.min(100, width))}%` }} />
        </div>
      )}
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
              {/* The empty track that used to sit beside an unmeasured "—" is
                  gone: a bar with nothing to encode reads as a zero reading. */}
              <span className="flex items-center justify-end gap-2" title={samplePct === null ? "Champion-specific adherence is not present in the available recent-game sample." : `Recent champion adherence over ${sample?.resolved} resolved games.`}>
                {samplePct !== null && <span className="h-1.5 w-10 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-teal" style={{ width: `${samplePct}%` }} /></span>}
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
                {/* Segments, not a fixed template. The old line read
                    "CS 6.6 · thin · — adh": an abbreviation nobody can expand
                    and a dash standing in for an unmeasured value. Each segment
                    now spells itself out and is simply absent when it has no
                    reading, so no dash ever carries a unit. */}
                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[9px] tabular-nums text-mut/70">
                  {row.csPerMin !== null && <span className="whitespace-nowrap">CS {row.csPerMin.toFixed(1)}/min</span>}
                  {csThin && <span className="whitespace-nowrap rounded-[3px] bg-white/[0.07] px-1 py-px text-[8px] font-semibold uppercase tracking-[0.06em] text-mut/80" title={`CS/min covers ${row.csGames} of ${row.games} games.`}>Thin sample</span>}
                  {row.csPerMin !== null && samplePct !== null && <span aria-hidden="true" className="text-mut/40">·</span>}
                  {samplePct !== null && <span className="whitespace-nowrap">{samplePct}% build adherence</span>}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className={`block text-[12px] font-semibold tabular-nums ${row.lowSample ? "text-mut" : row.winrate >= 0.5 ? "text-good" : "text-bad"}`}>{formatPct(row.winrate)}</span>
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

function MyStatsSurface({ summary, sessions, icons, onSwitched }: { summary: MyStatsSummary; sessions: SessionPanelProps["sessions"]; icons: Map<number, ChampionIconEntry>; onSwitched: () => void }) {
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
      {/* Stacked below lg: side by side, the title column was squeezed to a
          third of a 390px viewport and both the eyebrow and the H1 wrapped
          mid-phrase while the accounts card floated beside them. The
          side-by-side arrangement is kept only at the width it actually fits. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-teal">RANKED SOLO · {coverage.seasonClaimSafe ? "FULL SEASON" : "RECORDED SO FAR"} · DISPLAY ONLY</p>
          <h1 className="mt-1.5 text-[34px] font-semibold leading-none tracking-[-0.025em] text-txt">My Stats</h1>
        </div>
        {(summary.accounts?.length ?? 0) > 0 && (
          <div className="min-w-0 lg:max-w-[420px] lg:flex-shrink-0">
            <AccountPicker
              accounts={summary.accounts ?? []}
              activeRiotId={summary.riotId}
              activeId={summary.accountId ?? null}
              onSwitched={onSwitched}
              collapsed={false}
            />
          </div>
        )}
      </div>

      {coverage.pill && <p className="mt-3 text-[11px] text-mut" title={coverage.pill.title}>{coverage.pill.text} · {coverage.games} games stored so far</p>}
      {overall.games === 0 ? (
        <div className="mt-5"><EmptyState title={coverage.seasonClaimSafe ? "No games yet this season" : "Still collecting your games"} body="The ranked solo history is empty for the active account. Refresh after the next match is recorded." /></div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {/* A raw game count is not a share of anything, so no bar. */}
            <StatTile label="Games" value={overall.games} sublabel={coverage.seasonClaimSafe ? "this season" : "recorded"} />
            <StatTile label="Win rate" value={formatPct(overall.winrate)} sublabel={`${overall.wins}W · ${overall.losses}L`} width={overall.winrate * 100} barLabel={`Win rate ${formatPct(overall.winrate)} of ${overall.games} recorded games`} />
            <StatTile
              label="Main"
              value={main?.name ?? null}
              sublabel={main ? `${main.games} of ${overall.games} games` : undefined}
              width={main && overall.games > 0 ? (main.games / overall.games) * 100 : null}
              barLabel={main ? `${main.name} is ${Math.round((main.games / overall.games) * 100)} percent of your recorded games` : undefined}
            />
            <StatTile
              label="Build adherence"
              value={adherence === null || adherence === undefined ? null : `${Math.round(adherence)}%`}
              sublabel={adherence === null || adherence === undefined ? undefined : "season avg"}
              width={adherence ?? null}
              barLabel={adherence === null || adherence === undefined ? undefined : `Build adherence ${Math.round(adherence)} percent across the comparable season sample`}
              accent
            />
          </div>

          <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_372px]">
            <ChampionPool rows={rows} recentGames={recentGames} />
            <aside className="space-y-4">
              <PatternCard summary={summary} games={recentGames} overall={overall} />
              <LastTwenty games={recentGames} iconOf={(id) => icons.get(id)} />
              <SessionPanel sessions={sessions} />
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
      .then((raw: unknown) => {
        if (!cancelled) {
          // Keep the established summary fields on the shared normalizer.
          // Sessions come from this same response, so mounting the panel does
          // not introduce another request or data path.
          const summary = normalizeMyStatsSummary(raw);
          setState(summary ? { status: "ok", summary, sessions: summarySessions(raw) } : { status: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  function handleAccountSwitched() {
    setState({ status: "loading" });
    setRefreshKey((key) => key + 1);
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
      {isPostGame ? <PostGameReview summary={state.summary} iconOf={iconOf} /> : <MyStatsSurface summary={state.summary} sessions={state.sessions} icons={icons} onSwitched={handleAccountSwitched} />}
      {showAccountLinking && <AccountPicker accounts={state.summary.accounts ?? []} activeRiotId={state.summary.riotId} activeId={state.summary.accountId ?? null} onSwitched={handleAccountSwitched} collapsed={false} />}
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
