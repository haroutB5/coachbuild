// ─────────────────────────────────────────────────────────────────────────────
// GET /api/otp/featured?championId=<n>
//
// The ONE one-trick we feature for a champion, and what they actually build.
//
// Deliberately a NEW route rather than a change to /api/otp: that one serves the
// eight-account consensus the OTP card was built on, and this replaces the card
// rather than the data behind it. Two routes, two shapes, no shared failure.
//
// Read-only. Every Riot call for this data happens in
// scripts/ingest-otp-featured.mjs on a machine that can drive a browser — see
// that script's header for why discovery cannot run here.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/pro/db";
import {
  buildFeaturedModel,
  type FeaturedGame,
  type FeaturedMatchRow,
  type OtpRunePageSamples,
} from "@/lib/otp/featured";
import { getChampionById, resolveChampionKit } from "@/lib/staticData";
import type { ChampionKit, SkillOrderModel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface FeaturedOtpResponse {
  /** Null when this champion has no eligible one-trick yet. */
  player: {
    gameName: string;
    tagLine: string;
    server: string | null;
    tier: string | null;
    lp: number | null;
    /** Share of THEIR games that are this champion, 0-100. */
    championSharePct: number | null;
    /** Games on the champion per the source — bigger than what we store. */
    sourceGames: number | null;
    winratePct: number | null;
    kda: number | null;
    refreshedAt: string | null;
  } | null;
  /** Build rates over the games WE hold, which is the honest denominator for
   *  every percentage below. Never the source's larger game count. */
  sample: { games: number; wins: number } | null;
  items: { itemId: number; games: number; pct: number }[];
  /** One entry per stored game, NEWEST FIRST: the deduplicated final inventory
   *  (raw ids, no classification — same posture as `items`, see the note below
   *  the query) plus whether they won it.
   *
   *  The card needs the GAMES, not just the per-item rates, to answer "which
   *  items did they finish holding TOGETHER" honestly — `lib/otp/featuredBuild.ts`
   *  explains why a build assembled from rates and one somebody actually played
   *  must not look alike. The `win` flag is what lets the card prefer, and then
   *  truthfully label, a game they WON when it has to fall back to a single
   *  game; the ORDER is what makes its recency tiebreak deterministic. */
  gameLog: FeaturedGame[];
  /** `games`/`pct` are the EXACT-PAGE figure (how often all slots matched at
   *  once). `slots` is the per-rune breakdown, each entry over its own
   *  denominator — see `buildRunePageSamples`. The two answer different
   *  questions and the card must never present one as the other. */
  runes: { page: unknown; games: number; pct: number; slots: OtpRunePageSamples } | null;
  spells: { spells: number[]; games: number; pct: number } | null;
  skillOrder: SkillOrderModel | null;
}

const EMPTY: FeaturedOtpResponse = {
  player: null,
  sample: null,
  items: [],
  gameLog: [],
  runes: null,
  spells: null,
  skillOrder: null,
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const champParam = searchParams.get("championId");
  if (!champParam || !/^\d+$/.test(champParam)) {
    return NextResponse.json({ error: "Invalid or missing championId" }, { status: 400 });
  }
  const championId = parseInt(champParam, 10);

  const sql = getSql();
  if (!sql) return NextResponse.json(EMPTY);

  try {
    const featured = (await sql`
      SELECT game_name, tag_line, server, tier, lp, champion_share_pct,
             source_games, winrate_pct, kda, puuid, refreshed_at
      FROM coachbuild.otp_featured
      WHERE champion_id = ${championId}
      LIMIT 1
    `) as unknown as {
      game_name: string;
      tag_line: string;
      server: string | null;
      tier: string | null;
      lp: number | null;
      champion_share_pct: number | null;
      source_games: number | null;
      winrate_pct: number | null;
      kda: string | number | null;
      puuid: string;
      refreshed_at: string;
    }[];

    if (featured.length === 0) return NextResponse.json(EMPTY);
    const f = featured[0];

    const rows = (await sql`
      SELECT win, final_items, runes, spells, skill_order
      FROM coachbuild.otp_matches
      WHERE puuid = ${f.puuid} AND champion_id = ${championId}
      ORDER BY game_creation DESC
    `) as unknown as FeaturedMatchRow[];

    let kit: ChampionKit | null = null;
    try {
      const champion = await getChampionById(championId);
      kit = champion?.key ? await resolveChampionKit(championId, champion.key) : null;
    } catch {
      // A recorded order must not silently fall back to standard caps when kit
      // resolution fails for a champion that may be non-standard.
      kit = null;
    }

    // No item filter here: the client already holds the item metadata map and
    // knows which ids are completed items. Filtering by a guess on the server
    // is how components end up presented as builds.
    const model = buildFeaturedModel(rows, undefined, kit);

    const body: FeaturedOtpResponse = {
      player: {
        gameName: f.game_name,
        tagLine: f.tag_line,
        server: f.server,
        tier: f.tier,
        lp: f.lp,
        championSharePct: f.champion_share_pct,
        sourceGames: f.source_games,
        winratePct: f.winrate_pct,
        kda: f.kda == null ? null : Number(f.kda),
        refreshedAt: f.refreshed_at,
      },
      sample: { games: model.games, wins: model.wins },
      items: model.items,
      gameLog: model.gameLog,
      runes: model.runes
        ? {
            page: model.runes.page,
            games: model.runes.games,
            pct: model.runes.pct,
            slots: model.runes.slots,
          }
        : null,
      spells: model.spells
        ? { spells: model.spells.spells, games: model.spells.games, pct: model.spells.pct }
        : null,
      skillOrder: model.skillOrder,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error("[/api/otp/featured] Unexpected error:", err);
    return NextResponse.json(EMPTY);
  }
}
