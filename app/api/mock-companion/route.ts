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
//   GET  /api/mock-companion?path=status -> {version, port, phase, clientConnected}
//   GET  /api/mock-companion?path=live   -> <allgamedata fixture> | {error:'no-live'}
//   POST /api/mock-companion             -> {ok:true} | {ok:false, reason, hint?}

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
