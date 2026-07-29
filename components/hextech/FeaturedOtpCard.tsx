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
// which is smaller than the source's career total. The card says so in words
// rather than quietly implying the bigger number.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { itemIconUrl, spellIconUrl, spellName, treeIconUrl, resolveRuneDisplay, shardIconUrl, shardName } from "@/components/proAssets";
import { getItemDetailMap, type ItemDetail } from "@/components/itemDetail";
import { STARTING_ITEM_ALLOWLIST } from "./proConsensus";

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

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">{children}</p>;
}

/** A completed item, not a component or consumable. Same rule the build lines
 *  use: something with nothing to build INTO is finished.
 *
 *  Starters are excluded and shown on their own line below. HARD RULE, standing
 *  user directive 2026-07-22: a starting item must never render inside a list of
 *  completed items. Doran's Ring passes the `into` test on its own (it upgrades
 *  into nothing) and would otherwise sit between Rabadon's and Zhonya's as if it
 *  were a build slot. */
function isCompleted(id: number, meta: ItemDetail | undefined): boolean {
  if (!meta) return false;
  if (STARTING_ITEM_ALLOWLIST.has(id)) return false;
  if (meta.purchasable === false) return false;
  const tags = meta.tags ?? [];
  if (tags.includes("Consumable") || tags.includes("Trinket")) return false;
  if (tags.includes("Boots")) return true;
  return Array.isArray(meta.into) && meta.into.length === 0;
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1 w-full rounded-full bg-panel2 overflow-hidden" aria-hidden="true">
      <div
        className="h-full rounded-full bg-teal/70"
        style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

export default function FeaturedOtpCard({ champ, ver }: { champ: ChampionRef; ver: string }) {
  const [data, setData] = useState<FeaturedResponse | null>(null);
  const [meta, setMeta] = useState<ReadonlyMap<number, ItemDetail>>(new Map());
  const [keystone, setKeystone] = useState<{ name: string; icon: string } | null>(null);
  const [skillPriority, setSkillPriority] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `cancelled` closure, not an AbortController: the same stale-response guard
    // ProConsensusCard uses. Switching champion fast otherwise lets an older
    // response land last and paint the wrong player's build.
    let cancelled = false;
    setLoading(true);
    setKeystone(null);
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
      // Keystone art resolves separately and is DECORATIVE — a failure here
      // costs an icon, never the card. Same posture proAssets already takes.
      const ks = body?.runes?.page?.keystone;
      if (typeof ks === "number") {
        try {
          const d = await resolveRuneDisplay(ks, ver);
          if (!cancelled) setKeystone({ name: d.name, icon: d.icon });
        } catch {
          /* icon only */
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [champ.id, ver]);

  if (loading) {
    return (
      <div className="bg-panel border border-line rounded-xl p-5 animate-pulse">
        <div className="h-2.5 w-32 bg-panel2 rounded mb-4" />
        <div className="h-10 w-full bg-panel2 rounded mb-3" />
        <div className="h-24 w-full bg-panel2 rounded" />
      </div>
    );
  }

  const player = data?.player ?? null;
  const sample = data?.sample ?? null;

  if (!player || !sample || sample.games === 0) {
    return (
      <div className="bg-panel border border-line rounded-xl p-5">
        <Label>One-trick</Label>
        <p className="mt-3 text-[13px] text-mut leading-relaxed">
          No one-trick tracked for {champ.name} yet. We only feature an account with{" "}
          <span className="text-txt">150+ games</span> on the champion, so this fills in as the
          ingest works through the roster.
        </p>
      </div>
    );
  }

  const items = data!.items
    .filter((i) => isCompleted(i.itemId, meta.get(i.itemId)))
    .filter((i) => i.pct >= MIN_DISPLAY_PCT);

  // Their most-common opener, on its own line rather than mixed into the build.
  // Genuinely useful on a one-trick card — Dun opens Doran's Ring in 4 games out
  // of 10 and Dark Seal in nearly 6, which is a real read on how he plays the
  // lane — but it is not a build slot and must not look like one.
  const starter = data!.items
    .filter((i) => STARTING_ITEM_ALLOWLIST.has(i.itemId) && meta.get(i.itemId))
    .sort((a, b) => b.games - a.games)[0];

  const winPct = Math.round((sample.wins / sample.games) * 100);
  // Below the floor we show WHO, never percentages — see MIN_SAMPLE_GAMES.
  const thinSample = sample.games < MIN_SAMPLE_GAMES;
  const runes = data!.runes;
  const runeDisplay = keystone;

  return (
    <div className="bg-panel border border-line rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Label>Best one-trick</Label>
          <h3 className="mt-1.5 text-[19px] font-semibold text-txt leading-tight">
            {player.gameName}
            <span className="text-mut font-normal">#{player.tagLine}</span>
          </h3>
          <p className="mt-1 text-[11.5px] text-mut">
            {[player.tier, player.lp != null ? `${player.lp} LP` : null, player.server]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <dl className="flex gap-4 text-right">
          {player.sourceGames != null && (
            <div>
              <dt className="text-[9.5px] uppercase tracking-[0.12em] text-mut">Games</dt>
              <dd className="text-[15px] font-semibold text-txt tabular-nums">{player.sourceGames}</dd>
            </div>
          )}
          {player.winratePct != null && (
            <div>
              <dt className="text-[9.5px] uppercase tracking-[0.12em] text-mut">Win rate</dt>
              <dd className="text-[15px] font-semibold text-txt tabular-nums">{player.winratePct}%</dd>
            </div>
          )}
          {player.championSharePct != null && (
            <div>
              <dt className="text-[9.5px] uppercase tracking-[0.12em] text-mut">{champ.name}</dt>
              <dd className="text-[15px] font-semibold text-txt tabular-nums">{player.championSharePct}%</dd>
            </div>
          )}
        </dl>
      </div>

      {thinSample ? (
        <p className="mt-3 text-[11.5px] text-mut leading-relaxed">
          Still collecting their games — we hold{" "}
          <span className="text-txt tabular-nums">{sample.games}</span> of the{" "}
          <span className="text-txt tabular-nums">{MIN_SAMPLE_GAMES}</span> needed before build
          percentages mean anything. Their card fills in as the ingest catches up.
        </p>
      ) : (
        <p className="mt-3 text-[11px] text-mut/80 leading-relaxed">
          Percentages below are across their last{" "}
          <span className="text-txt tabular-nums">{sample.games}</span> ranked {champ.name} games that
          we hold ({winPct}% won) — not their full career.
        </p>
      )}

      {!thinSample && starter && (
        <div className="mt-4 flex items-center gap-2.5">
          <Label>Opens</Label>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={itemIconUrl(starter.itemId, ver)}
            alt=""
            width={22}
            height={22}
            className="rounded border border-line flex-shrink-0"
            loading="lazy"
          />
          <span className="text-[12px] text-txt truncate">{meta.get(starter.itemId)?.name}</span>
          <span className="text-[12px] font-semibold text-txt tabular-nums ml-auto">{starter.pct}%</span>
        </div>
      )}

      {!thinSample && items.length > 0 && (
        <div className="mt-4">
          <Label>Builds most often</Label>
          <ul className="mt-2.5 space-y-2">
            {items.map((it) => (
              <li key={it.itemId} className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={itemIconUrl(it.itemId, ver)}
                  alt=""
                  width={30}
                  height={30}
                  className="rounded-md border border-line flex-shrink-0"
                  loading="lazy"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] text-txt truncate">
                      {meta.get(it.itemId)?.name ?? `Item ${it.itemId}`}
                    </span>
                    <span className="text-[12px] font-semibold text-txt tabular-nums flex-shrink-0">
                      {it.pct}%
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Bar pct={it.pct} />
                    <span className="text-[9.5px] text-mut tabular-nums flex-shrink-0 w-[52px] text-right">
                      {it.games}/{sample.games}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!thinSample && (runes || data!.spells) && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {runes && (
            <div>
              <Label>Most-run runes</Label>
              <div className="mt-2 flex items-center gap-2">
                {runeDisplay?.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={runeDisplay.icon} alt="" width={30} height={30} className="flex-shrink-0" loading="lazy" />
                )}
                {runes.page.secondaryTree != null && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={treeIconUrl(runes.page.secondaryTree)}
                    alt=""
                    width={18}
                    height={18}
                    className="flex-shrink-0 opacity-80"
                    loading="lazy"
                  />
                )}
                <span className="text-[12px] text-txt truncate">{runeDisplay?.name ?? "Rune page"}</span>
                <span className="ml-auto text-[12px] font-semibold text-txt tabular-nums">{runes.pct}%</span>
              </div>
              {runes.page.shards.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5">
                  {runes.page.shards.map((s, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={`${s}-${i}`}
                      src={shardIconUrl(s)}
                      alt={shardName(s)}
                      title={shardName(s)}
                      width={16}
                      height={16}
                      className="rounded-sm"
                      loading="lazy"
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {data!.spells && (
            <div>
              <Label>Summoners</Label>
              <div className="mt-2 flex items-center gap-2">
                {data!.spells.spells.map((s) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={s}
                    src={spellIconUrl(s, ver)}
                    alt={spellName(s)}
                    title={spellName(s)}
                    width={26}
                    height={26}
                    className="rounded-md border border-line"
                    loading="lazy"
                  />
                ))}
                <span className="ml-auto text-[12px] font-semibold text-txt tabular-nums">
                  {data!.spells.pct}%
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {!thinSample && skillPriority && (
        <div className="mt-5">
          <Label>Skill order</Label>
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
          {/* Said out loud rather than implied. Every other number on this card
              is this player's own; this one is not, because match-v5 does not
              carry skill order without a second timeline call per game. */}
          <p className="mt-1.5 text-[10.5px] text-mut/70 leading-relaxed">
            The champion&apos;s common order, not {player.gameName}&apos;s own — skill order is not in
            the match data we store.
          </p>
        </div>
      )}

      {!thinSample && items.length === 0 && (
        <p className="mt-4 text-[12px] text-mut">
          No item reaches {MIN_DISPLAY_PCT}% across the games we hold yet.
        </p>
      )}
    </div>
  );
}
