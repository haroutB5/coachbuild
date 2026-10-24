# CoachBuild: bounded Tauri 2 experiment

Base: `ea52debfb6d1f28b137bc7673afcd9aa1a8eff0a`. This directory does not integrate
with or release the WPF application. The committed Rust API is **one deterministic,
stateless function**, `coachbuild_core::merge`, implementing
`ItemSetMergeService.Merge`. The CLI only adapts JSON input/output to that function.
No performance improvement is claimed from this prototype.

## The benefit worth testing, and when to stop

Harout should see the Draft window become usable sooner after opening CoachBuild
and retain more memory for League while CoachBuild sits in the tray. The hypothesis
is that replacing the .NET/WPF host with a smaller native host helps those two
experiences. Keeping WebView2, site tabs and an equivalent overlay may erase that
benefit. Rust alone is not evidence of a faster app, and this merge function is
not a measured bottleneck.

Before building a full replacement, measure the shipping WPF app and a minimal
Tauri shell on the **same gaming PC**, same release optimization, WebView2 runtime,
assets, warm cache state and dark UI. Use 10 paired launches and report medians
and p95: process start to interactive Draft, working set after 60 seconds in tray,
installed bytes, download bytes, frame time while the overlay is visible, and CPU
while idle/in champ select. Keep the real League process and display configuration
the same for both. Collect timings without account identifiers.

Continue only if the Tauri shell saves **at least 20% and 150 ms** in median
start-to-interactive time **or at least 20% and 30 MiB** of steady tray working set,
with no p95 interaction/frame-time regression, no data loss and no missing
workflow. These are prospective go/no-go criteria, not measured results or loosened
existing budgets. If neither benefit survives equivalent tabs and overlay, stop
the migration and keep WPF. Also stop if safe remote-site isolation, an approved
signed update/rollback path, or reliable gaming-PC overlay behavior cannot be
demonstrated without weakening current behavior. Do not keep translating services
while these questions remain unanswered.

## What is ported and what is deliberately not ported

| C# component | Rust mapping / status | Reason / next proof required |
| --- | --- | --- |
| `ItemSetMergeService.Merge` | `coachbuild-core/src/lib.rs::merge`, complete stateless scope | Clone existing document; remove title/uid-owned sets; preserve foreign JSON; append non-null new sets; ignore `replacePrefix`; null for non-object input. Differential corpus calls actual C# implementation. |
| `ItemSetMergeService.SerializedUtf8Length` | Not ported | System.Text.Json escaping differs from serde_json; structural equality does not prove byte-size parity. Keep the existing serializer/limits until byte contract is independently specified. |
| `ItemSetApplyService` and `ApplyPayloadValidation` | Not ported | Full-document write ordering, cancellation, account connection and validation belong to a host lifecycle. The merge function itself intentionally accepts foreign/malformed new values just as C# does. A future adapter must retain existing write gates before invoking it. |
| `RuneApplyService` | Not ported | Destructive account operations require lifecycle/transport tests, not isolated method translations. Resolve manual-consent and capacity behavior before any experiment writes pages. |
| `RuneOwnershipLedger` | Not ported | Synchronised mutable state is meaningful only with its gameflow reset, reconnect and session ownership lifecycle. Method-level tests cannot establish that lifecycle. |
| `ChampionDirectory`, `ChampionIdLookup`, `LiveLocalPlayerResolver` | Not ported | Outside the narrowed merge experiment. Caching, retry and local-player identity must be validated in context. Filter alternate-art ids >=60000 before requests in a future adapter. |
| `LaneScoreModel`, `LaneScoreStore`, `LaneScoreAggregator`, `LaneScoreService` | Not ported | Persistence/capture, per-path synchronization, crash-safe replacement and game-end identity require host-state tests. Even the pure aggregator adds no evidence to the current migration decision. |
| `LcuCredentials`, parser/resolver and `LcuHttpClient` | Not ported | Windows WMI/CIM access, shared lockfile reads, fixed-drive paths, invalidation and reconnect are host-state concerns. Never inspect League memory; retain current process-query approach. |
| `RedactedLog`, `WireContracts`, `JsonOptions` | Not ported | Redaction/file rotation and bridge routing/session/origin behavior require host integration. serde_json output from this CLI is not a replacement wire protocol. |
| WPF `TrayController`, WebView2 window/environment, overlay classes, Velopack updater | Not ported | Windows/native shell work, detailed below. |

Drafted during the wider initial brief: rune decision/ledger, champion identity/
directory, credential discovery, lane model/store/aggregation, wire/log and item
apply modules. All were removed from the narrowed deliverable before commit.
No partial stateful translation is shipped here.

## Ordered migration path

1. **Close the merge experiment.** Build and execute native tests on an approved
   Windows runner, run the portable WASI tests, regenerate and verify the C# oracle
   corpus against the current source hashes. The two original C# tests that exercise
   the merge function are mirrored. Request validation, HTTP writes, concurrency,
   title generation and rune/persistence tests are deliberately excluded. Review
   the structural-vs-byte serialization boundary before using the crate elsewhere.

2. **Baseline and disposable shell only.** Create a separate opt-in Tauri 2 shell,
   separate application identifier/user-data root, no account writes, no production
   feed. Load a copy of the existing Next static export; use `frontendDist` pointing
   to the export. Tauri expects static output rather than a Next server. Keep WPF
   installed and unchanged. Do not assume GNU core compilation proves the Windows
   Tauri toolchain: validate the documented MSVC/Windows SDK prerequisites first.
   Measure the benefit and apply the stop criteria above before proceeding.

3. **Specify the host boundary before translating state.** Record bridge requests,
   response unions/nulls, allowed origins, session/attach rules and cancellation.
   Plan host-managed commands/events or a compatibility loopback adapter with
   explicit capabilities. Keep untrusted u.gg/Coachless/op.gg views separate from
   the privileged local Draft view, without remote-page command permissions.
   Bind any retained HTTP bridge to loopback, preserve session gates and ports
   48291-48293 until the client contract is intentionally migrated. A different
   local origin breaks `https://coachbuild.local` assumptions unless handled.

4. **Read-only integration first.** Implement Windows credential discovery and
   polling behind one owned lifecycle with cancellation/shutdown tests. Test
   elevated/null command lines, non-default installs, lockfile replacement,
   negative cache, 401 invalidation, League restart and champ-select-to-game
   transitions. Never return credentials to JavaScript or logs. Move blocking
   filesystem/discovery work off the UI event loop. Keep all write capabilities
   disabled by default.

5. **Stateful writes only after lifecycle proof.** Design ownership as one
   service, including session reset and user edits. Replay full read/merge/write,
   overlapping imports/cancellation and lost-response cases using fake transport.
   Prove foreign pages/sets never change, three-page cap, reconnect/session reset,
   rollback on failed writes and fail-soft cleanup. Resolve the C# manual path
   that can replace the current foreign rune page, and create-then-prune behavior,
   against the desired safety contract. Do not silently claim identical behavior
   and stronger guarantees at once. The experiment flag must permit **only one**
   writer (WPF or Tauri), with immediate fallback to WPF; never dual-write.

6. **Migrate persistence as a separate project.** Reuse exact lane-score schema,
   unknown field preservation, unique temp+atomic move, unreadable-file refusal,
   per-path locks and note bounds. Start on synthetic copied history in a throwaway
   root. Preserve real history paths only after an explicit migration/rollback
   design; do not use this prototype to touch user history.

7. **Windows shell parity and gaming-PC checks.** Replace tray behavior (close
   hides, reopen, quit, calibration and updates) explicitly. WPF XAML, native
   HWND ownership, DirectComposition overlay rendering, hotkeys and DPI handling
   cannot simply be carried into a webview. Prototype a dedicated native Windows
   overlay or preserve it as a separate component before replacing it. Tauri on
   Windows still uses WebView2: runtime install/repair, profiles, cookies, page
   extraction, popup/navigation handling and process lifetime need new adapters.
   Do not assume a webview overlay has equivalent click-through/fullscreen behavior.

8. **Installer/update transition last.** Tauri updater signatures and its manifest
   are different from Velopack feeds. Use a separate signed prerelease channel and
   explicit per-user install path/app id, test update/rollback and duplicate tray
   prevention. Signing update artifacts does not itself provide Windows executable
   signing/trust. Design the one-time handoff from Velopack before considering a
   production cutover; never overwrite the existing feed with a Tauri manifest.
   DevOps owns shipping, QA checks the UI before each release. Keep a supported
   return to WPF until all gates pass.

## Gaming PC verification required

This laptop cannot establish these outcomes. Do not infer them from WASI/core tests:

- Real League champ select, reconnect, dodge, game launch/end and client restart;
  discover the correct account and champion, exclude alternate art, and resolve
  the actual lane opponent in a ranked game (420/440). Practice Tool cannot prove
  ranked lane-score prompting.
- Foreign item sets/pages unchanged after opt-in writes, repeated imports from
  both sites, user-edited runes, capacity of 1/2/3/full slots, cancellation and
  lost connection. Use a disposable account/config fixture before a real account.
- Native overlay in actual borderless/fullscreen League, focus/click-through,
  global hotkeys, alt-tab, display scaling, multiple monitors, drag/snap/resize,
  calibration, minimized/tray behavior and frame-time impact during gameplay.
- Windows security/Vanguard compatibility using documented APIs without memory
  inspection; signed installer under Smart App Control, WebView2 missing/repair,
  per-user install/update/rollback, no duplicate WPF+Tauri writer or tray process.
- Site login/profile/extractor behavior and local Draft navigation in the actual
  embedded WebView2; dark UI smoke by QA. Match WPF measurements for cold/warm
  launch, working set, idle CPU and in-game frame-time before accepting a benefit.

## References checked for this plan (24 October 2026)

Official primary sources; details should be rechecked at implementation time:

- [Tauri Next.js integration](https://v2.tauri.app/start/frontend/nextjs/): static export and frontend distribution configuration.
- [Windows installers](https://v2.tauri.app/distribute/windows-installer/): Windows tooling, packaging and WebView2 distribution choices.
- [Capabilities](https://v2.tauri.app/security/capabilities/): scope IPC access to selected windows/webviews and origins.
- [System tray](https://v2.tauri.app/learn/system-tray/): explicit tray support and event handling.
- [Updater](https://v2.tauri.app/plugin/updater/): signed artifacts, update manifest and Windows installation modes.

Top risks: (1) destructive stateful write lifecycle, mitigated by replayed host tests
and one writer; (2) native overlay/WebView2 regressions, mitigated by early gaming-PC
parity and a stop gate; (3) installer/update trust and rollback, mitigated by a
separate signed channel and a proven return path to WPF.
