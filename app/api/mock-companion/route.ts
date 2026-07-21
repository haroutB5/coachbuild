import { NextRequest, NextResponse } from "next/server";

// Dev-only fixture mirroring the Live companion bridge's wire contract
// (public/companion.ps1's #region BridgeServer / SelfTest). This lets
// components/live/companionClient.ts (fronty) be developed and tested in a
// browser with no real League client, LCU, or companion process running.
//
// NOT a security surface: unlike the real bridge (127.0.0.1:48291-3), this
// runs same-origin inside the Next.js server, so there's no CORS/Origin
// check to bypass and no pairing token to guess. ?session= is accepted for
// parity with the real contract but never validated here.
//
// Wire contract mirrored exactly (see companion.ps1 header comment):
//   GET  /api/mock-companion?path=status -> {version, port, phase, clientConnected,
//                                             lastOpen, champSelect, lastPollAt, lastError}
//   GET  /api/mock-companion?path=live   -> <allgamedata fixture> | {error:'no-live'}
//   POST /api/mock-companion             -> {ok:true} | {ok:false, reason, hint?}
//
// v1.4.0 (Draft recommender, plan §5): `?phase=ChampSelect` now populates a
// full `champSelect` snapshot (previously this mock never returned one at
// all, even in ChampSelect -- a real gap vs. companion.ps1's actual /status
// shape). Query params let a dev drive draftLiveSync.ts / CompanionProvider
// against realistic champ-select data with no real League client:
//   ?theirTeam=1,2,3   -- csv of enemy championIds (default: a 3-enemy fixture)
//   ?timerPhase=BAN_PICK -- default "BAN_PICK"; pass an empty string for null
//   ?roleId=0-4        -- default 2 (mid)
//   ?cellChampionId=<id>, ?pickIntent=<id>, ?actionChampionId=<id> -- default 0 (null)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MOCK_VERSION = "1.0.0-mock";
const MOCK_PORT = 48291;

// A representative slice of https://127.0.0.1:2999/liveclientdata/allgamedata
// (the OFFICIAL, supported Live Client Data API companion.ps1's /live route
// passes through verbatim). Enough shape for LivePanel/compHighlight dev
// work: enemy champions, team side, position, items. Real endpoint also
// includes summoner/riotId fields for the local player's own team (that's
// player-visible, official-API data, not the champ-select anonymity case) --
// fixture mirrors that shape too since it's a raw-passthrough contract; it's
// fronty's LivePanel *model* layer that must omit names from what it renders
// (asserted by their livePanelModel.test.ts), not this passthrough fixture.
function buildLiveFixture() {
  return {
    activePlayer: {
      summonerName: "MockSummoner",
      riotId: "MockSummoner#DEV1",
      championStats: {},
      currentGold: 1250.5,
    },
    allPlayers: [
      { championName: "Ahri", riotId: "MockSummoner#DEV1", team: "ORDER", position: "MIDDLE", items: [], scores: { kills: 2, deaths: 1, assists: 3 } },
      { championName: "LeeSin", riotId: "Ally2#DEV2", team: "ORDER", position: "JUNGLE", items: [], scores: { kills: 3, deaths: 0, assists: 1 } },
      { championName: "Zed", riotId: "Enemy1#DEV3", team: "CHAOS", position: "MIDDLE", items: [], scores: { kills: 1, deaths: 2, assists: 0 } },
      { championName: "LeBlanc", riotId: "Enemy2#DEV4", team: "CHAOS", position: "TOP", items: [], scores: { kills: 0, deaths: 1, assists: 2 } },
    ],
    events: { Events: [] },
    gameData: { gameTime: 612.3, mapName: "Map11" },
  };
}

/** ?theirTeam=1,2,3 -> [1,2,3]; malformed/absent entries dropped, never throws. */
function parseTheirTeamParam(raw: string | null): number[] {
  if (!raw) return [45, 91, 238]; // default 3-enemy fixture (Ekko/Talon/Zed-ish ids)
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseIntOrZero(raw: string | null): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Builds the champSelect snapshot exactly per companion.ps1's own
 *  Set-ChampSelectSnapshot shape -- see this route's header comment for the
 *  query params. Only meaningful when phase === "ChampSelect" (the real
 *  bridge nulls this field outside that phase; this mock mirrors that). */
function buildChampSelectFixture(searchParams: URLSearchParams) {
  const nullIfZero = (n: number) => (n > 0 ? n : null);
  const timerPhaseParam = searchParams.get("timerPhase");
  return {
    localPlayerCellId: parseIntOrZero(searchParams.get("localPlayerCellId")),
    cellChampionId: nullIfZero(parseIntOrZero(searchParams.get("cellChampionId"))),
    pickIntent: nullIfZero(parseIntOrZero(searchParams.get("pickIntent"))),
    actionChampionId: nullIfZero(parseIntOrZero(searchParams.get("actionChampionId"))),
    roleId: searchParams.has("roleId") ? parseIntOrZero(searchParams.get("roleId")) : 2,
    theirTeam: parseTheirTeamParam(searchParams.get("theirTeam")),
    timerPhase: timerPhaseParam === null ? "BAN_PICK" : timerPhaseParam || null,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path") || "status";

  if (path === "status") {
    const phase = searchParams.get("phase") || "InProgress";
    const clientConnected = searchParams.get("clientConnected") !== "false";
    return NextResponse.json({
      version: MOCK_VERSION,
      port: MOCK_PORT,
      phase,
      clientConnected,
      lastOpen: null,
      champSelect: phase === "ChampSelect" ? buildChampSelectFixture(searchParams) : null,
      lastPollAt: new Date().toISOString(),
      lastError: null,
    });
  }

  if (path === "live") {
    if (searchParams.get("live") === "false") {
      return NextResponse.json({ error: "no-live" });
    }
    return NextResponse.json(buildLiveFixture());
  }

  return NextResponse.json({ error: "unknown mock path" }, { status: 404 });
}

export async function POST(req: NextRequest) {
  // Same-shaped fail-soft envelope as the real bridge's /apply-runes,
  // including the #1013 delete-fail case -- pass ?fail=delete to exercise
  // the manual-delete-hint toast without a real LCU.
  const { searchParams } = new URL(req.url);
  const fail = searchParams.get("fail");

  if (fail === "delete") {
    return NextResponse.json({ ok: false, reason: "delete-failed", hint: "delete a rune page manually and retry" });
  }
  if (fail === "create") {
    return NextResponse.json({ ok: false, reason: "create-failed" });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-body" });
  }

  const perks = (body as { selectedPerkIds?: unknown[] } | null)?.selectedPerkIds;
  if (!Array.isArray(perks) || perks.length !== 9) {
    return NextResponse.json({ ok: false, reason: "invalid-body" });
  }

  return NextResponse.json({ ok: true });
}
