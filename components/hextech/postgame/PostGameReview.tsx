"use client";

import { IconWithFallback } from "@/components/IconWithFallback";
import {
  computeRecentWinLoss,
  myStatsRoleLabel,
  type IconEntry,
  type MyStatsRecentGame,
  type MyStatsSummary,
} from "@/components/hextech/myStats";
import { itemIconUrl, versionFromPatch } from "@/components/proAssets";

export interface PostGameReviewProps {
  summary: MyStatsSummary;
  iconOf: (championId: number) => IconEntry | undefined;
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function formatKda(game: MyStatsRecentGame): string {
  if (game.kills === null || game.deaths === null || game.assists === null) return "—";
  return `${game.kills} / ${game.deaths} / ${game.assists}`;
}

function ResultBanner({ game, iconOf }: { game: MyStatsRecentGame; iconOf: PostGameReviewProps["iconOf"] }) {
  const icon = iconOf(game.championId);
  const name = icon?.name ?? `Champion #${game.championId}`;
  const duration = formatDuration(game.gameDurationSec);
  const result = game.win ? "VICTORY" : "DEFEAT";
  const resultTone = game.win ? "good" : "bad";

  return (
    <section
      className={`relative overflow-hidden rounded-[10px] px-5 py-5 sm:px-6 sm:py-6 bg-gradient-to-br ${
        game.win
          ? "from-good/[0.16] via-[#1c1e2b] to-[#191b27]"
          : "from-bad/[0.16] via-[#211d28] to-[#191b27]"
      } shadow-[inset_0_0_0_1px_rgba(70,199,155,.26)] ${game.win ? "" : "shadow-[inset_0_0_0_1px_rgba(232,115,110,.28)]"}`}
    >
      <div className="pointer-events-none absolute inset-0 opacity-70 [background:repeating-linear-gradient(115deg,rgba(145,132,217,.05)_0_1px,transparent_1px_9px)]" />
      <div className="relative flex flex-wrap items-center gap-4 sm:gap-5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <span
            className={`flex h-[60px] w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-black/25 shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)] ${
              game.win ? "ring-1 ring-good/30" : "ring-1 ring-bad/30"
            }`}
          >
            <IconWithFallback src={icon?.icon ?? ""} alt={name} fallbackGlyph={name} className="h-full w-full object-cover" size={60} />
          </span>
          <div className="min-w-0">
            <p className={`text-[10px] font-medium uppercase tracking-[0.16em] ${resultTone === "good" ? "text-good" : "text-bad"}`}>
              {result} · RANKED SOLO{duration ? ` · ${duration}` : ""}
            </p>
            <h1 className="mt-1 truncate text-[26px] font-semibold leading-none tracking-[-0.02em] text-txt">
              {name} · {myStatsRoleLabel(game.role)}
            </h1>
            <p className="mt-1 text-[11px] text-mut">Latest recorded game · display only</p>
          </div>
        </div>

        <div className="flex w-full shrink-0 items-end gap-7 sm:w-auto sm:gap-8">
          <BannerStat label="KDA" value={formatKda(game)} />
          <BannerStat label="CS / MIN" value={game.csPerMin === null ? "—" : game.csPerMin.toFixed(1)} />
          <BannerStat label="DAMAGE SHARE" value="—" title="Damage share is not stored in My Stats." />
        </div>
      </div>
    </section>
  );
}

function BannerStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-[9px] font-medium uppercase tracking-[0.12em] text-mut">{label}</p>
      <p className="mt-1 whitespace-nowrap text-[24px] font-semibold leading-none tracking-[-0.03em] text-txt tabular-nums">{value}</p>
    </div>
  );
}

type FixKind = "BUILD" | "JUDGMENT" | "KEEP";

function FixCard({ index, kind, title, body, stat }: { index: number; kind: FixKind; title: string; body: string; stat: string }) {
  const tone = kind === "KEEP" ? "good" : kind === "JUDGMENT" ? "accent" : "bad";
  const toneClass = tone === "good" ? "bg-good/15 text-good" : tone === "bad" ? "bg-bad/15 text-bad" : "bg-teal/15 text-teal";
  const tagClass = tone === "good" ? "bg-good/10 text-good" : tone === "bad" ? "bg-bad/10 text-bad" : "bg-teal/10 text-teal";

  return (
    <article className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-start gap-3 rounded-[9px] bg-panel-glass px-3.5 py-3.5 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:px-4">
      <span className={`flex h-[34px] w-[34px] items-center justify-center rounded-[7px] text-[13px] font-semibold tabular-nums ${toneClass}`}>{index}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-txt">{title}</h3>
          <span className={`rounded-[4px] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${tagClass}`}>{kind}</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-mut">{body}</p>
      </div>
      <div className="pt-0.5 text-right">
        <p className={`text-[16px] font-semibold leading-none tabular-nums ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-teal"}`}>{stat}</p>
      </div>
    </article>
  );
}

function ThingsToFix({ game }: { game: MyStatsRecentGame }) {
  const adherence = game.onWpaBuild === true ? "ON BUILD" : game.onWpaBuild === false ? "OFF BUILD" : "NO DATA";
  const buildTitle = game.onWpaBuild === false ? "The recorded build was off recommendation" : game.onWpaBuild === true ? "You stayed on the recorded recommendation" : "The build comparison is unresolved";
  const buildBody = game.onWpaBuild === false
    ? "This is the stored adherence result for the match; it describes the build comparison, not the cause of the result."
    : game.onWpaBuild === true
      ? "This match is marked on the WPA build. Keep the item order available to the coachless pipeline for a closer review."
      : game.patchDataPending
        ? "The match patch has no populated coachless build snapshot yet, so no off-build claim is made."
        : "No build comparison was recorded for this match, so item-order feedback is withheld.";

  const judgmentBody = game.kills !== null && game.deaths !== null && game.assists !== null
    ? `The stored KDA is ${formatKda(game)}. This JUDGMENT card is an interpretation boundary, not a measured explanation of why the game went this way.`
    : "KDA was not stored for this match. This JUDGMENT card says so out loud rather than treating a missing field as a zero.";

  const keepStat = game.win ? "WIN" : "LOSS";
  return (
    <section>
      <SectionLabel>Three things to fix</SectionLabel>
      <div className="space-y-2.5">
        <FixCard index={1} kind="BUILD" title={buildTitle} body={buildBody} stat={adherence} />
        <FixCard index={2} kind="JUDGMENT" title="Read the timeline as a prompt, not a verdict" body={judgmentBody} stat="JUDGMENT" />
        <FixCard
          index={3}
          kind="KEEP"
          title={game.win ? "The result was a win" : "The result was a loss"}
          body="The outcome is measured. The summary does not store enough opponent context to turn it into a causal story."
          stat={keepStat}
        />
      </div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-mut">{children}</p>;
}

type BuildComparisonProps = {
  game: MyStatsRecentGame;
};

function BuildComparison({ game }: BuildComparisonProps) {
  // The current My Stats summary deliberately carries adherence/KDA/CS, not
  // final item ids or a historical recommendation snapshot. Keep this adapter
  // open for a richer response without fabricating item order today.
  const extended = game as MyStatsRecentGame & { itemIds?: number[]; recommendedItemIds?: number[]; patch?: string };
  const yours = Array.isArray(extended.itemIds) ? extended.itemIds.slice(0, 6) : [];
  const recommended = Array.isArray(extended.recommendedItemIds) ? extended.recommendedItemIds.slice(0, 6) : [];
  const hasOrder = yours.length > 0 || recommended.length > 0;
  const ver = versionFromPatch(extended.patch);

  return (
    <section className="rounded-[9px] bg-panel-glass px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)] sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>What you built vs. what we&apos;d build</SectionLabel>
        <span className="text-[10px] text-mut">Position order matters more than item count</span>
      </div>
      <div className="space-y-3">
        <BuildRow label="Yours" ids={yours} otherIds={recommended} tone="yours" ver={ver} />
        <BuildRow label="CoachBuild" ids={recommended} otherIds={yours} tone="recommended" ver={ver} />
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-mut">
        {hasOrder
          ? "Red rings mark positions that differ in the stored order; the accent rings show the corresponding CoachBuild positions."
          : "Final item order is not stored in the My Stats summary, so no position difference is asserted for this match."}
      </p>
    </section>
  );
}

function BuildRow({ label, ids, otherIds, tone, ver }: { label: string; ids: number[]; otherIds: number[]; tone: "yours" | "recommended"; ver: string }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
      <span className={`w-[92px] shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] ${tone === "recommended" ? "text-teal" : "text-mut"}`}>{label}</span>
      <div className="min-w-0 overflow-x-auto">
        <div className="flex min-w-max gap-2">
        {Array.from({ length: 6 }).map((_, index) => {
          const id = ids[index];
          const different = id !== undefined && otherIds[index] !== undefined && id !== otherIds[index];
          const ring = different ? tone === "yours" ? "ring-1 ring-bad/70" : "ring-1 ring-teal/80" : "ring-1 ring-white/[0.08]";
          return (
            <span key={`${label}-${index}`} className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-gradient-to-br from-[#2b2e42] to-[#1c1e2c] ${ring}`} title={id === undefined ? "Item order not recorded" : `Item ${id}`}>
              {id !== undefined ? (
                <IconWithFallback src={itemIconUrl(id, ver)} alt={`Item ${id}`} className="h-full w-full object-cover" size={40} />
              ) : (
                <span className="text-[11px] text-mut/60">—</span>
              )}
            </span>
          );
        })}
        </div>
      </div>
    </div>
  );
}

function AdherenceDonut({ summary }: { summary: MyStatsSummary }) {
  const value = summary.buildAdherencePct;
  const circumference = 2 * Math.PI * 56;
  const safe = value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  const resolvedGames = (summary.nOnBuild ?? 0) + (summary.nOffBuild ?? 0);

  return (
    <section className="rounded-[9px] bg-panel-glass px-4 py-4 text-center shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <SectionLabel>Build adherence</SectionLabel>
      <div className="relative mx-auto h-[132px] w-[132px]">
        <svg viewBox="0 0 132 132" className="h-full w-full -rotate-90" role="img" aria-label={safe === null ? "Build adherence is not measured" : `${Math.round(safe)} percent build adherence`}>
          <circle cx="66" cy="66" r="56" fill="none" stroke="rgba(233,233,237,.07)" strokeWidth="10" />
          {safe !== null && (
            <circle cx="66" cy="66" r="56" fill="none" stroke="#9184d9" strokeWidth="10" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - safe / 100)} />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div>
            <p className="text-[34px] font-semibold leading-none tracking-[-0.04em] text-txt tabular-nums">{safe === null ? "—" : Math.round(safe)}<span className="text-[16px] text-mut">{safe === null ? "" : "%"}</span></p>
            <p className="mt-1 text-[10px] text-mut">season</p>
          </div>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-mut">
        {safe === null
          ? "No same-patch build snapshot has measured a game yet."
          : resolvedGames > 0
            ? `${resolvedGames} games had a comparable build snapshot.`
            : "The summary has no resolved build sample behind this value."}
      </p>
    </section>
  );
}

function AdherenceState({ game }: { game: MyStatsRecentGame }) {
  if (game.onWpaBuild === true) return <span className="rounded-[4px] bg-good/10 px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.05em] text-good">On build</span>;
  if (game.onWpaBuild === false) return <span className="rounded-[4px] bg-bad/10 px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.05em] text-bad">Off build</span>;
  return <span className="rounded-[4px] bg-white/[0.05] px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.05em] text-mut">No patch data</span>;
}

function RecentGames({ games, iconOf }: { games: MyStatsRecentGame[]; iconOf: PostGameReviewProps["iconOf"] }) {
  const visible = games.slice(0, 5);
  const wl = computeRecentWinLoss(visible);
  return (
    <section className="rounded-[9px] bg-panel-glass px-4 py-4 shadow-[inset_0_0_0_1px_rgba(233,233,237,.08)]">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Recent games</SectionLabel>
        <span className="text-[10px] text-mut tabular-nums">{wl.n} recorded</span>
      </div>
      {visible.length === 0 ? (
        <p className="text-[11.5px] text-mut">No recent games recorded yet.</p>
      ) : (
        <div>
          {visible.map((game, index) => {
            const entry = iconOf(game.championId);
            const name = entry?.name ?? `Champion #${game.championId}`;
            return (
              <div key={`${game.championId}-${index}`} className="flex items-center gap-2.5 border-t border-white/[0.06] py-2.5 first:border-t-0">
                <span className={`h-8 w-[3px] shrink-0 rounded-full ${game.win ? "bg-good" : "bg-bad"}`} aria-hidden="true" />
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-black/25 shadow-[inset_0_0_0_1px_rgba(233,233,237,.12)]"><IconWithFallback src={entry?.icon ?? ""} alt={name} fallbackGlyph={name} className="h-full w-full object-cover" size={32} /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold text-txt">{name} · {myStatsRoleLabel(game.role)}</p>
                  <p className="text-[10px] text-mut tabular-nums">{formatKda(game)}</p>
                </div>
                <AdherenceState game={game} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function PostGameReview({ summary, iconOf }: PostGameReviewProps) {
  const game = summary.recentGames?.[0] ?? null;
  if (!game) {
    return (
      <div className="mx-auto max-w-[1120px] px-4 pb-16 pt-8 sm:px-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-teal">Post-game · ranked solo</p>
        <h1 className="mt-2 text-[34px] font-semibold leading-none tracking-[-0.025em] text-txt">No recent game to review</h1>
        <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-mut">Post-Game uses the latest ranked solo game in your My Stats summary. Nothing has been recorded for the active account yet.</p>
      </div>
    );
  }

  return (
    <div className="pt-0">
      <ResultBanner game={game} iconOf={iconOf} />
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_372px] xl:items-start">
        <div className="space-y-4">
          <ThingsToFix game={game} />
          <BuildComparison game={game} />
        </div>
        <aside className="space-y-4">
          <AdherenceDonut summary={summary} />
          <RecentGames games={summary.recentGames ?? []} iconOf={iconOf} />
        </aside>
      </div>
    </div>
  );
}
