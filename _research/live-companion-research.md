# CoachBuild "Live" Companion — Research Report (rechy, 2026-07-20)

Full verified research feeding the Live-feature design. Confidence flags inline; sources at bottom.

## TL;DR recommendation

- Feasible + Riot-compliant IF the bright line holds: recommend builds/runes/comp-aware items only — never enemy cooldowns/ult timers, never automate game actions (queue-accept/pick/lock/dodge). User-clicked rune-page apply is standard importer behavior.
- **Packaging: pure PowerShell companion via `irm coachbuild.vercel.app/companion.ps1 | iex`.** All compile-to-exe toolchains (bun/pkg/Node SEA/Deno) are ~50MB+ with unsigned-exe SmartScreen walls + real AV false-positive history (bun flagged as trojan, oven-sh/bun #16981). PS 5.1 is preinstalled; `irm|iex` runs in-memory (bypasses ExecutionPolicy); KB footprint.
- **Bridge: hybrid.** Champ-select flow is ZERO-BRIDGE: companion `Start-Process`-opens the right CoachBuild URL (no browser→localhost call, no permission prompt). Browser→companion (rune apply + live in-game poll) uses `fetch('http://127.0.0.1:48291/...')` — **Chrome 142 (Sept 2025) Local Network Access now prompts once per origin for loopback** ("Allow" once). WebSocket is currently NOT LNA-gated (temporary gap, don't build on it).
- **Beating Blitz/u.gg concretely:** zero-login, zero-ads, KB-scale (they're 1-2GB Electron/Overwolf), instant native page-open, comp-aware recos (only Hexgate does this; Blitz/Moba/u.gg are static-build).

## A. LCU mechanics (unofficial but tolerated; can drift without notice)

- Lockfile: `C:\Riot Games\League of Legends\lockfile` = `LeagueClient:<PID>:<PORT>:<PASSWORD>:https`. More robust: `Get-CimInstance Win32_Process -Filter "name='LeagueClientUx.exe'"` → parse `--app-port=` + `--remoting-auth-token=` from CommandLine (WMIC is deprecated/removed on newer Win11).
- Auth: Basic `riot:<token>`, https://127.0.0.1:<port>, self-signed cert. PS5.1 has NO -SkipCertificateCheck → use `[System.Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}` shim. Port+token rotate every client restart — re-read each loop.
- Champ select: `GET /lol-champ-select/v1/session` → `myTeam[]` (cellId, championId, championPickIntent, assignedPosition top|jungle|middle|bottom|utility, spell1Id/spell2Id), `theirTeam[]`, `localPlayerCellId`, `actions[]`, `timer`, `benchChampionIds` (ARAM). My champ+role: myTeam entry where cellId==localPlayerCellId; championId may be 0 until locked (use championPickIntent for hover).
- Websocket: WAMP over `wss://127.0.0.1:<port>/`, same Basic auth; subscribe `[5,"OnJsonApiEvent_lol-champ-select_v1_session"]`, events `[8,"<event>",{data,eventType,uri}]`. Also `OnJsonApiEvent_lol-gameflow_v1_gameflow-phase`. Can't subscribe-all-then-filter. RECOMMENDED HYBRID: poll gameflow-phase ~1.5s to find client + transitions; open champ-select websocket only during ChampSelect.
- Rune write (importer pattern): `GET /lol-perks/v1/currentpage` → `DELETE /lol-perks/v1/pages/{id}` → `POST /lol-perks/v1/pages` body `{name, primaryStyleId, subStyleId, selectedPerkIds[9], current:true}`. selectedPerkIds order: keystone + 3 primary + 2 secondary + 3 stat shards (shards are perk ids like 5007/5002/5001). Do NOT PUT currentpage to an uncreated page. Known bug: isDeletable:true pages can falsely reject DELETE (developer-relations #1013) — fail soft with a "delete a page manually" toast. Exact page cap UNVERIFIED (delete-first pattern makes it moot).
- Perk-id space: LCU selectedPerkIds == CommunityDragon/DDragon perk ids (same id space, importers POST CDragon ids verbatim). **RISK #4 (verify first): confirm CoachBuild stores RAW Riot perk ids, not an internal/coachless index.**
- Gameflow phases: None|Lobby|Matchmaking|ReadyCheck|ChampSelect|GameStart|InProgress|WaitingForStats|PreEndOfGame|EndOfGame.

## B. Live Client Data API (port 2999 — OFFICIAL, supported)

- `https://127.0.0.1:2999/liveclientdata/` — allgamedata, activeplayer, activeplayerrunes, playerlist, playerscores, playeritems, eventdata, gamestats. Swagger at /swagger/v2/swagger.json.
- **playerlist includes ENEMIES: champion, team, position, ITEMS, runes, scores, summoner spells** — the comp-aware recos backbone (Hexgate does exactly this; compliant, it's player-visible info).
- Riot ID migration: name-param endpoints take riotId now. Identify local player via activeplayer, not names.
- Self-signed cert; localhost-only (non-127.0.0.1 rejected). Poll ~1s (community norm). Works in ranked/normal/ARAM/practice/spectator (per-mode matrix community-established, not official — user spot-check). Not champ select (that's LCU's job).

## C. Competitor teardown

| App | Runtime | RAM | Comp-aware? | Complaints |
|---|---|---|---|---|
| Blitz | Electron | GBs after long sessions | No (static) | video ads, stutter (officially acknowledged) |
| Mobalytics | Overwolf x2 | ~1.4-2GB | No | multiple simultaneous lobby video ads, $7.99/mo |
| u.gg desktop | Overwolf | n/a | No | "static builds don't adapt" |
| Porofessor/op.gg | Overwolf | n/a | No | "dated", error reports |
| Hexgate | Tauri | <100MB | YES | Windows-only, 3 games/day free cap, €4.99/mo |

Our wins: no runtime tax (KB script + existing browser), zero ads/login, comp-aware via Live Client Data + coachless WPA, native page-open faster than overlay spin-up, no overlay fatigue.

## D. Packaging + install

- **PowerShell one-liner wins**: `irm coachbuild.vercel.app/companion.ps1 | iex` — KB-scale, in-memory (no ExecutionPolicy wall), no unsigned-exe SmartScreen, lowest AV surface. All exe toolchains ≈50MB+ AND AV drama. Vercel serves .ps1 statically fine (set Content-Type via vercel.json headers if needed).
- Auto-start: Startup-folder .lnk (no admin) or `schtasks /sc onlogon ... powershell -w hidden -ep bypass -f <path>`.
- Auto-update: fetch `companion.version` on launch, re-download script on mismatch.
- Presence: headless (`-w hidden`) + `System.Windows.Forms.NotifyIcon` tray (Quit/Reopen). Never a bare console window.

## E. Browser↔companion bridge (2026 reality)

- **Chrome 142 (Sept 2025): Local Network Access permission prompt now covers loopback fetches from public HTTPS pages.** One "Allow" per origin (persistence UNVERIFIED — verify on device; Chrome 145 split local-network vs loopback-network permissions). Edge follows Chrome. iOS/Safari irrelevant (companion is on the Windows PC; PWA phone use has no companion).
- Escape hatches: (1) PRIMARY champ-select flow is companion→browser `Start-Process <url>` — no bridge, no prompt; (2) `ws://127.0.0.1` from HTTPS currently NOT LNA-gated + loopback exempt from mixed-content — accelerator only, Chrome intends to close it; (3) accept the one-time prompt for fetch (rune apply + live poll) — durable path.
- Companion server: `System.Net.HttpListener` bound 127.0.0.1 ONLY, fixed port 48291 (fallback 48292/48293 — list hardcoded in PWA too; each probed port = its own LNA prompt so keep list tiny), CORS exact-origin `https://coachbuild.vercel.app`, OPTIONS preflight handled, pairing token (companion generates, passes via `?session=<token>` on first open, PWA echoes on every call), Origin header validated.

## F. Riot compliance (cited in full report)

- Live Client Data: official/supported. LCU: officially unsupported-but-tolerated; 2019 LCU policy's "contact us before release" targets DISTRIBUTED apps — personal non-distributed tool is a different posture; conduct rules still bind.
- HARD BANS (never build): enemy ability/summoner cooldown tracking, ult timers (banned Mar 13 2025), power-spike/"do X now" alerts, queue-accept/auto-pick/auto-lock/dodge automation, revealing non-party summoner NAMES in ranked champ select (Patch 12.22 anonymity — we only need champion picks + role, never names).
- Rune importers + champ-select build assistance: allowed in practice (Blitz/Moba/u.gg/op.gg all do it, Vanguard-compatible; Vanguard doesn't police read-only companions).

## Recommended architecture

PS 5.1 companion (served from our Vercel domain) → poll gameflow-phase 1.5s (CIM port/token re-read) → on ChampSelect: WAMP ws for session → extract champ+role → `Start-Process https://coachbuild.vercel.app/champion/<id>?role=<pos>&session=<token>` → PWA "Apply runes" button → fetch 127.0.0.1:48291/apply-runes (one-time LNA Allow) → GET/DELETE/POST perks pages. On InProgress: PWA polls /live (companion proxies 2999/allgamedata) → comp-aware item recos vs enemy playerlist.

## Risks (top)

1. Chrome closes the ws LNA gap — don't depend on ws. 2. LNA Allow persistence unverified — lean on Start-Process flow. 3. LCU endpoint drift — version-guard, fail soft. 4. **CoachBuild rune ids must be raw Riot perk ids — VERIFY FIRST.** 5. Rune DELETE bug #1013 — fail soft. 6. PS5.1 cert shim brittleness. 7. Never ship unsigned exe. 8. Compliance drift — bright-line table is product law. 9. Port collision — fixed tiny list. 10. Use riotId, never summonerName.

## Reality-check list (on gaming PC / in repo before build)
1. CoachBuild stores raw Riot perk ids? (grep recommend/rune data path)
2. LNA Allow persistence on user's Chrome/Edge.
3. Live Client Data in ARAM/practice on user's client.
4. Rune-page cap (moot with delete-first).
5. Which browser the gaming PC uses (Firefox differs on loopback behavior).

## Sources
LCU: hextechdocs.dev/getting-started-with-the-lcu-api/ + /getting-started-with-the-lcu-websocket/ + /how-to-set-runes-using-lcu/ · gist.github.com/xadamxk/8cb5d21d24bb78d63c5241e97087bb23 · gist.github.com/Pupix/eb662b1b784bb704a1390643738a8c15 · github.com/RiotGames/developer-relations/issues/1013 · darkintaqt.com/blog/perk-ids · raw.communitydragon.org
Live Client Data: developer.riotgames.com/docs/lol · github.com/oracle-devrel/leagueoflegends-optimizer (article4)
Competitors: hexgate.app/blog/hexgate-vs-blitz-vs-mobalytics/ · support.blitz.gg (auto-import, vanguard articles)
Packaging: bun.com/docs/bundler/executables · hirenodejs.com SEA 2026 · github.com/oven-sh/bun/issues/16981 · vercel.com/docs/build-output-api/primitives
LNA: developer.chrome.com/blog/local-network-access · chromestatus.com/feature/5152728072060928 · issues.chromium.org/issues/40386732
Compliance: riotgames.com/en/DevRel/changes-to-the-lcu-api-policy · dev.overwolf.com/ow-native/guides/game-compliance/riot-games/ · gameriv.com/third-party-apps-after-champion-select-anonymity/
