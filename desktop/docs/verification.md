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

On a clean Windows user profile, install under `%LOCALAPPDATA%\CoachBuild\Desktop`
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

## Performance and release verification

Capture the real app with the procedure in `desktop/perf/README.md`, then test
both borderless and windowed League at at least two display scales. Publish two
test releases to the dedicated feed, download the newer release during a busy
phase, and verify silent apply plus relaunch after the phase ends. Never use the
Electron release repository for this test.
