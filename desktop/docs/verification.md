# Desktop verification matrix

The native solution is verified in a Windows environment with the .NET 8 SDK:

```powershell
dotnet restore desktop/CoachBuild.Desktop.sln
dotnet build desktop/CoachBuild.Desktop.sln -c Release
dotnet test desktop/CoachBuild.Desktop.sln -c Release --no-build
dotnet run --project desktop/src/CoachBuild.Desktop/CoachBuild.Desktop.csproj -- -SelfTest
```

The web app remains first-class and is checked independently:

```powershell
npm run build
npm run lint
npm run typecheck
npm run test
```

## Native contract replay

Against the native loopback bridge, replay the same requests the unchanged
`components/live/companionClient.ts` sends:

- OPTIONS and exact-Origin CORS;
- bad-origin and bad-session rejection;
- valid `/status` with `follow` and `detach` parameters;
- `/live`, `/skills`, `/me`, `/apply-runes`, and `/apply-itemsets`.

Compare status codes, JSON envelopes, and no-client behavior with the existing
client expectations. The native overlay does not use `/skills`; its skill data
comes from the in-process LCU snapshot. `/skills` remains available only for
the unchanged hosted web app contract.

## Write safety fixtures

Run the existing rune/item-set fixtures plus the native bridge SelfTest and
assert:

- the five-user-page auto-rune case produces zero DELETEs;
- user-edited CoachBuild pages remain untouched in auto mode;
- manual mode keeps its explicit overwrite behavior;
- foreign item sets survive a CoachBuild write;
- serialized CoachBuild payloads remain bounded.

## Clean-profile install/update matrix

On a clean Windows user profile, install under `%LOCALAPPDATA%\CoachBuild.Desktop`
(Velopack's per-user root: `Update.exe`, `current\`, `packages\`, `velopack.log`;
the separate `%LOCALAPPDATA%\CoachBuild` holds `companion.log` and settings)
without UAC and verify:

1. One tray instance owns `Local\CoachBuildCompanion`; the legacy companion is
   rejected during staged rollout rather than running beside it.
2. The session token survives a restart and the first free bridge port is used.
3. Draft and Builds use one owned WebView2 window. No default-browser process
   is launched.
4. With WebView2 absent, the app-owned fallback and tray repair action remain
   usable; after repair, retry opens `/draft`.
5. Reopen maps ChampSelect to Draft and InProgress to Builds.
6. A downloaded update remains deferred through ChampSelect/InProgress and is
   applied automatically as soon as the busy gate clears; Velopack's own
   pending state is the source of truth.
7. **Self-update, from the released installer, with the window open.** This
   row exists because 1.0.6, 1.0.7 and 1.0.8 all shipped unable to update
   themselves, and every earlier run of this matrix passed. Install the
   *previously released* Setup.exe (not a local build), launch it the way a
   user does — by double-clicking, so the CoachBuild window opens — and leave
   it alone. Within a minute `companion.log` must show `update: <next> available`
   and `update: <next> downloaded and staged`, `%LOCALAPPDATA%\CoachBuild.Desktop\packages`
   must contain the new `.nupkg`, and the tray must offer `Restart to update to
   <next>`. Then close the window: the app must relaunch on the new version.
   A run that only ever launches with `--autostart`, or only ever uses a
   locally built package, does not exercise this and will pass while the
   shipped app cannot update.
8. **Quit and relaunch applies a staged release.** Stage an update as above,
   quit from the tray without closing the window, relaunch. The app must come
   back on the new version. Velopack's own startup auto-apply normally does
   this (`velopack.log`: `Launching app is out-dated` … `Auto apply is true`);
   if it does not, the app's own startup pass logs
   `update: <next> was already downloaded by an earlier run`. Read
   `velopack.log` as well as `companion.log` for this row — the auto-apply
   happens before the app writes anything.

## Performance and release verification

Capture the real app with the procedure in `desktop/perf/README.md`, then test
both borderless and windowed League at at least two display scales. Publish two
test releases to the dedicated feed, download the newer release during a busy
phase, and verify silent apply plus relaunch after the phase ends. Never use the
Electron release repository for this test.

## Reading `companion.log` when the app is not updating itself

Every update transition and every failure is one line prefixed `update:`.
Before 1.0.9 there were none at all — the string did not appear once in a log
covering two missed releases — so the first thing to establish is that any
`update:` line exists. If none do, the running build is 1.0.8 or older and
cannot report anything; install the current release by hand.

| line | meaning |
|---|---|
| `update: checking …/releases.win.json (installed 1.0.9)` | the check ran, and against which version. One per check (launch, then every 2 h). |
| `update: no newer release on the feed (installed X)` | genuinely up to date. |
| `update: X available; downloading` → `X downloaded and staged` | the package is on disk in `%LOCALAPPDATA%\CoachBuild.Desktop\packages`. |
| `update: applying X and restarting` | last line of the old process; the next start logs `installed X`. |
| `update: X is staged; not restarting under the open CoachBuild window` | waiting on the user. Tray → `Restart to update to X`, or close the window. |
| `update: X is staged; holding the restart while the companion is mid-write` | champ select / ready check / an in-flight LCU write. Clears on its own. |
| `update: X was already downloaded by an earlier run; applying it now` | a previous process staged it and exited. |
| `update: cannot check for updates: …` | the updater itself is unavailable — a portable/unpacked run, or `UpdateManager` failed to construct. Never rendered as "up to date". |
| `update: FAILED …` | anything thrown by check, download or apply, with the exception type and message. |

## Reading `companion.log` when the in-game overlay shows nothing

`%LOCALAPPDATA%\CoachBuild\companion.log`. Every line below is deduped to one
per transition, so a whole match is a handful of lines. Work down the list; the
first question that answers "no" is the answer.

1. **`phase: … -> InProgress`** — the LCU half works. Missing means credentials
   were never resolved; look for the `lcu_discovery_failed` JSON line and read
   its `layers` array, which names each of the four discovery layers and why it
   failed.
2. **`poll: phase … -> InProgress`** — the 750 ms snapshot poll (a different
   instrument from the gameflow poller) is alive and saw the game. Present in
   step 1 but missing here means the render loop itself is dead.
3. **`live: 2999 ok`** — Live Client Data answered. `live: 2999 unreachable
   (…)` means a third-party firewall is blocking loopback, or the game process
   is not up yet. A mid-game 404 is routine and does **not** count as
   unreachable.
4. **`live: identity matched by <rung>`** — the local player's own player-list
   entry was found. `<rung>` is the key that actually matched: `RiotId`,
   `GameNameAndTagLine`, `GameName`, `SummonerName`, or `SoleEntry` (Practice
   Tool). If instead you see `live: identity unmatched (me … ; tried … ;
   playerlist n=… riotId=… gameName=… tag=… summonerName=…)`, read the counts:
   all-zero counts mean the payload shape moved, non-zero counts with no match
   mean the two endpoints spell the identity differently. Own-identity values
   are masked to a prefix plus a length because the log redacts anything
   Riot-ID shaped; no other player's name is ever written.
   `live: identity unknown (…)` means `allgamedata` published nothing
   identifying and the `/liveclientdata/activeplayername` fallback is being
   polled.
5. **`live: champion roster loaded (N entries)`** — `GET /api/champions`
   answered. `champion roster unavailable (…); will retry` is not fatal: it is
   re-asked every 20 s, and champ select's own champion id covers the gap.
   Live Client Data publishes the champion by **name** only; this roster is what
   turns that name into the numeric id `/api/skill-order` is keyed by. (Through
   1.0.10 the app read a `championId` field off the player list instead, which
   Riot has never sent, so the in-game skill order could not appear at all.)
6. **`live: champion=<name> id=<id> via=<source> position=<lane>`** — the
   champion was resolved. `via=RawChampionName` is the locale-independent key
   and is the normal case; `via=ChampionName` matched the localised display
   name; `via=ChampSelect` means the roster was unreachable and the id came from
   the champion the LCU watched you lock in.
7. **`overlay: …`** — the render decision:
   - `overlay-hidden (tray: Show overlay)` — the overlay is switched off in the
     tray. Click it.
   - `waiting-live-skill` / `waiting-champion` — the pipeline is running but an
     input has not arrived.
   - `waiting-champion-id` — the champion is known by name and has no numeric id
     yet. Pair it with the `live: champion roster …` line above.
   - `no-skill-order` — no order for this champion+lane. Since 1.0.8 this
     retries on its own; if it persists, that champion+lane genuinely has none.
     Tray → Lane → pick the lane explicitly to force a different key.
   - `no-next-ability` — all 18 points spent. Correct at level 18.
   - `highlight E at 754x879 size 39 visible=True on \.\DISPLAY1 1920x1080@96
     source=league` — the overlay drew. `source=league` means the monitor came
     from the game window; `source=self` means League was not found and the
     overlay's own monitor was used. If the box is still not on screen, check
     the device name against the monitor League is on, then check for the
     `fullscreen:` line below.
8. **`fullscreen: exclusive D3D fullscreen reported by the shell`** — a layered
   overlay cannot composite over a true exclusive swapchain. Set League:
   Settings → Video → Window Mode = **Borderless**. Note this line can appear
   on a machine where the overlay works anyway: Fullscreen Optimizations
   converts most exclusive-fullscreen D3D apps to borderless-flip.
9. **`skill-order: champion <id> returned <status>; retry in <n>s`** — a failed
   or empty fetch, with the retry that follows it. `recovered after N failed
   attempt(s)` closes the loop. `no further retry` means the schedule is
   exhausted (Error: 20 s / 45 s / 90 s; NoData: one attempt at 75 s).
