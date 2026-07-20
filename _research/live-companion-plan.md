# CoachBuild "Live" — Implementation Plan (Plan agent, 2026-07-20)

Companion research: see `live-companion-research.md` (same dir). This plan is the build spec for the engy/fronty parallel build. Bridge wire contract is the ONE hard interface both sides must honor (§5).

## 0. Pre-flight findings (verified in repo)

- **RISK #4 RESOLVED — raw Riot perk ids everywhere.** `lib/coachless.ts` RuneEntry.rune → `lib/recommend.ts` runeEntryToPick → Pick.id verbatim. TreeId = 8000|8100|8200|8300|8400 (lib/types.ts). Shards are raw perk ids (5008/5005/5007/5010/5002/5003/5001/5011/5013 — lib/staticData.ts SHARD_ICON, components/shardDetail.ts). Deathfire Touch = 8992. LCU POST body = direct assembly from BuildResponse.runes, ZERO remapping.
- **No /champion/[id] route.** Single client page app/page.tsx; champion+lane in React state; URL-param selection was DELIBERATELY rejected (see design note app/page.tsx lines ~113-133; useSheetBackNav raw pushState conflict). Deep-link target: `https://coachbuild.vercel.app/?championId=<id>&role=<0-4>&session=<token>` — home page reads query on MOUNT via window.location.search (NOT Next router params).
- Champion resolution: fetch `/api/champions` → find by id (pattern in components/hextech/SidebarChampionSearch.tsx line ~65).
- Lane mapping: LaneId top|jungle|mid|bot|support; LANE_TO_ROLE_ID top→0 jungle→1 mid→2 bot→3 support→4 (components/hextech/heroContracts.ts). LCU assignedPosition top|jungle|middle|bottom|utility → RoleId in companion; URL carries numeric RoleId.
- vercel.json currently has ONLY crons (no headers). public/ serves statically. sw.js: shell precache ["/"], network-first same-origin.
- BuildResponse has NO summoner-name field anywhere — compliance baseline.

## 1. Companion — public/companion.ps1 (engy; PS 5.1, single file, #region blocks)

- Config: COMPANION_VERSION '1.0.0'; AppOrigin https://coachbuild.vercel.app; BridgePorts 48291,48292,48293; PollMs 1500; LivePollMs 1000; Session = [guid]::NewGuid().ToString('N').
- SingleInstance: named mutex `Local\CoachBuildCompanion`; exit if held.
- TlsShim: force TLS1.2 + `[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}` (PS5.1 has NO -SkipCertificateCheck).
- LcuDiscovery: `Get-CimInstance Win32_Process -Filter "name='LeagueClientUx.exe'"` → parse --app-port / --remoting-auth-token from CommandLine (CIM, NOT WMIC — removed on new Win11; CommandLine can be $null — guard). Fallback: lockfile `C:\Riot Games\League of Legends\lockfile` = LeagueClient:PID:PORT:PASSWORD:https. Auth = Basic riot:<token>. RE-READ EVERY LOOP (rotates per client restart).
- LcuRequest: Invoke-RestMethod wrapper, -UseBasicParsing, try/catch → $null (fail-soft everywhere).
- GameflowPoll main loop 1.5s: GET /lol-gameflow/v1/gameflow-phase → state machine (None/Lobby/Matchmaking/ReadyCheck idle; ChampSelect → champ-select flow; InProgress → live ready). $script:Phase for /status.
- **ChampSelect: SESSION POLLING, NO WEBSOCKET** (decision: PS5.1/.NET 4.x ClientWebSocket lacks per-connection cert callback — WS against LCU self-signed cert is a dead-end; 1s polling of /lol-champ-select/v1/session while phase==ChampSelect is trivial + sufficient). My cell: myTeam where cellId==localPlayerCellId; champion = championId if >0 else championPickIntent; role = assignedPosition map (""→skip). **Debounce: open once per champ-select; re-open ONLY on champion CHANGE** ($LastOpenedChampId / $OpenedThisSelect, reset on ChampSelect enter/leave; never reopen on timer/teammate events). Open = `Start-Process "$AppOrigin/?championId=$cid&role=$roleId&session=$Session"` (zero-bridge, no LNA).
- BridgeServer: HttpListener http://127.0.0.1:<first free of 48291/2/3>/ on background runspace. Every request: Origin must equal AppOrigin exactly; CORS headers (Allow-Origin exact, Allow-Headers content-type, Allow-Methods GET,POST,OPTIONS, Max-Age 600); OPTIONS → 204; non-OPTIONS require ?session=<token> else 403. Routes:
  - GET /status → {version, port, phase, clientConnected}
  - GET /live → raw passthrough proxy of https://127.0.0.1:2999/liveclientdata/allgamedata (fail-soft {error:'no-live'} with 200). NO cooldown/timer computation ever.
  - POST /apply-runes (body = LCU page JSON from PWA): GET /lol-perks/v1/currentpage → DELETE /lol-perks/v1/pages/{id} (on non-2xx: return {ok:false, reason:'delete-failed', hint:'delete a rune page manually and retry'} — bug #1013 fail-soft; only POST after successful delete or no current page) → POST /lol-perks/v1/pages {name, primaryStyleId, subStyleId, selectedPerkIds, current:true} → {ok:true}. Never PUT currentpage to uncreated page.
- Tray: WinForms NotifyIcon (STA; Application.Run on dedicated STA thread; loops on runspace). Menu: Reopen page / Quit (dispose all). Icon: SystemIcons.Application or embedded base64. Never a bare console (-w hidden).
- AutoUpdate: on launch fetch /companion.version; if newer → tray balloon "re-run install command" (no silent self-overwrite).
- Install: -Install flag → Startup-folder .lnk via WScript.Shell (target powershell.exe -w hidden -ep bypass -Command "irm <ScriptUrl> | iex"); -Uninstall removes. No admin/schtasks.
- -SelfTest: bridge-only against in-memory mock LCU: asserts OPTIONS→204+CORS, wrong-Origin rejected, missing token 403, /apply-runes GET→DELETE→POST sequencing + delete-fail envelope. Exit 0/1.
- -Mock: full loop against fixture JSON (phase script Lobby→ChampSelect(hover Ahri→lock)→InProgress); asserts deep-link string + debounce. -Once/timeout flag for CI.
- PS5.1 gotchas (top comment): TLS callback shim; force TLS1.2; no WS; CIM not WMIC; -UseBasicParsing; ConvertTo-Json -Depth 10 (default 2 truncates!); -Compress bridge responses; STA for WinForms; HttpListener loopback needs NO netsh ACL; LCU JSON numbers may be Int64 — cast for URL.
- Compliance header comment = bright line: no cooldowns/timers/ult tracking, no automation (queue-accept/pick/lock/dodge), no summoner names, rune apply only via user-clicked bridge call.

## 2. Web Live mode (fronty)

(a) app/live-setup/page.tsx (new, client): install one-liner (copyable) `irm https://coachbuild.vercel.app/companion.ps1 | iex` + `-Install` variant; pairing capture from ?session= (useSearchParams in <Suspense> OR window.location.search); LNA explainer + **Test connection** button (probes ports 48291→3 with ?session=; the deliberate LNA-prompt moment; shows {version,phase,clientConnected}); status indicator green/amber/grey.
(b) app/page.tsx (edit, surgical): mount-only effect reading window.location.search (match file's deliberate router-param avoidance): parse championId/role/session; persist session; fetch /api/champions → find by id; setChamp + setActiveLane EXPLICITLY (bypass handleChampionSelect's most-played-lane auto-correction — honor champ-select role; bump mostPlayedLaneRequestRef to kill in-flight override); run-once guard. Pure helper components/live/deepLink.ts: parseLiveDeepLink(search) + roleIdToLane.
(c) Apply runes: components/hextech/runeApplyBody.ts (new, pure): buildRuneApplyBody(champ, roleLabel, runes) → {name:`CoachBuild <champ> <role>`, primaryStyleId: runes.primaryTree.id, subStyleId: runes.secondaryTree.id, selectedPerkIds: [keystone, 3 primary, 2 secondary, shards offense→flex→defense], current:true}; assert length 9. Button in components/hextech/RunesSummonersCard.tsx shown only when companionClient.hasSession(); STRICTLY user-clicked; toasts {ok:true} / delete-failed hint.
(d) Live panel: components/live/LivePanel.tsx (new) polls companionClient.getLive() 1s while phase InProgress; enemy comp (champion icons + positions ONLY — NEVER names) reusing components/TeamComp.tsx / teamCompDisplay.ts; comp-aware highlights via components/live/compHighlight.ts (new, pure): selectCompAwareHighlights(situational, enemyChampionIds) REORDERS flattenSituational output only (never invents recos); render via SituationalCard extended with optional highlightIds prop. Home page shows "Live game detected" banner when companion phase InProgress.
(e) companionClient (components/live/companionClient.ts, new): probeCompanion (port walk), getStatus, getLive, applyRunes, session/port persistence (localStorage coachbuild:companion:*). Graceful states: no-companion (grey) / companion-no-client (amber) / LNA-denied (distinguish via fetch TypeError; "click Allow" + re-test).

## 3. Compliance guardrails (asserted in code + tests)

Champ-select path reads ONLY championId/championPickIntent + assignedPosition (never summonerId/name); deep-link carries only championId+role+session. LivePanel model omits name fields (unit-test asserts). No cooldown/timer computation anywhere. applyRunes called only from the button handler.

## 4. Serving + versioning (engy)

public/companion.ps1 + public/companion.version (JSON {"version":"1.0.0"}). vercel.json ADD headers block: /companion.ps1 → text/plain; charset=utf-8, Cache-Control no-store, nosniff; /companion.version → application/json, no-store. COMPANION_VERSION independent of app version; bump companion.version only when the script changes. sw.js: explicit bypass at top of fetch handler for /companion.ps1 + /companion.version (never cached, not in precache).

## 5. Scope split + wire contract

**engy:** public/companion.ps1 (new), public/companion.version (new), vercel.json (SHARED — engy owns), public/sw.js (SHARED — engy owns), optional app/api/mock-companion/route.ts (new; mirrors bridge contract for local UI dev).
**fronty:** app/live-setup/page.tsx, components/live/companionClient.ts (file owner; engy owns the WIRE CONTRACT — co-review), components/live/deepLink.ts, components/hextech/runeApplyBody.ts, components/live/compHighlight.ts, components/live/LivePanel.tsx, app/page.tsx (SHARED — fronty owns, surgical), components/hextech/RunesSummonersCard.tsx (SHARED — fronty), components/hextech/SituationalCard.tsx (SHARED — fronty, highlightIds prop).

**WIRE CONTRACT (agree before coding; comment block in BOTH companion.ps1 and companionClient.ts):** ports [48291,48292,48293]; ?session= on all non-OPTIONS; exact Origin https://coachbuild.vercel.app; GET /status → {version:string, port:number, phase:string, clientConnected:boolean}; GET /live → allgamedata passthrough | {error:'no-live'}; POST /apply-runes body {name, primaryStyleId, subStyleId, selectedPerkIds:number[9], current:true} → {ok:true} | {ok:false, reason:string, hint?:string}.

**Untestable off gaming PC:** real LCU discovery/gameflow/champ-select/perks endpoints (+#1013), real 2999 data, real LNA prompt, real browser open. Test seam: companion -Mock/-SelfTest (CI-runnable); web-side fetch mocks; optional /api/mock-companion for browser dev.

**User 5-min self-test (ship on /live-setup):** (1) one-liner → tray, no console; (2) Test connection → Allow LNA → version + clientConnected; (3) champ select → auto-open correct champ+role; hover change → page changes; same champ → no reopen; (4) Apply runes → in-client page "CoachBuild <champ> <role>" selected (delete-fail → manual-delete toast); (5) live game → banner → panel: enemy champs+positions, highlights reorder, NO names/timers.

## 6. Test plan

Vitest (pure .ts, JSX-free per repo convention): runeApplyBody.test.ts (9-id order, styles, shard order, name, length assert, real fixture); deepLink.test.ts; compHighlight.test.ts (reorders only, never invents ids — compliance); companionClient.test.ts (port walk, persistence, state classification); livePanelModel.test.ts (asserts NO name fields — compliance guard). Companion: -SelfTest + -Mock, exit-code gated.

## 7. Decisions

- WAMP vs polling → **SESSION POLLING** (PS5.1 WS cert dead-end; 1s champ-select-only poll).
- Live panel transport → **fetch + one-time LNA Allow** (champ-select open stays Start-Process zero-bridge; /live-setup Test button is the deliberate prompt moment; LNA-denied degrades gracefully).
- Risks 1-10 carried from research with mitigations (see research file); #4 CLOSED.
