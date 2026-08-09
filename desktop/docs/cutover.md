# Native desktop migration and cutover

The native app is introduced as a parity client, not as a replacement for the
hosted product.

## Stages

1. **Parity:** ship the WPF app to a small test cohort. Keep the hosted PWA,
   `public/companion.ps1`, and the existing Electron overlay release available.
   Validate bridge envelopes, LCU discovery, rune/item-set safety, Reopen
   phase mapping, WebView2 fallback, overlay click-through, and real-game
   performance.
2. **Public companion deprecation:** keep `public/companion.ps1` served and
   documented for browser users, but label it deprecated once native parity is
   demonstrated. Smartphone and browser use remains supported; this step does
   not add native-only web branches.
3. **Native default:** point desktop download guidance at the per-user WPF
   installer and the dedicated Velopack feed. The legacy source remains in the
   repository for rollback and for supported hosted-PWA users.
4. **Legacy retirement:** after a parity release has survived the clean-profile
   and real-League matrix, stop publishing/using `overlay-host` as the default.
   Do not remove its source until the rollback window and the native feed have
   been explicitly closed.

## Coexistence guard

The native app and the legacy companion use the shared
`Local\CoachBuildCompanion` mutex. A native startup that cannot acquire it
stops with an app-owned message; it must not launch a second writer or silently
continue with stale state. During rollout, support should quit the old tray
companion before starting the native app.

## Rollback

Rollback means stopping the native desktop release, restoring the prior
Velopack release, and—if necessary—re-enabling the legacy Electron artifact or
PowerShell companion for browser users. It does not mean changing the hosted
web contract or mobile routes. Keep the hosted origin, session-token shape,
bridge ports, and write-safety fixtures stable while rollback is available.

## Exit criteria

Cutover is complete only when all of the following are recorded:

- native SelfTest, solution tests, and unchanged root web checks pass;
- the bridge replay matches `companionClient.ts` for reads and writes;
- auto/manual rune and item-set fixtures prove the no-delete/consent rules;
- clean-profile WebView2 absence/repair and one-window navigation pass;
- performance targets pass in borderless and windowed League at tested DPI;
- two native Velopack releases prove busy-phase deferral, apply, and relaunch;
- the rollback artifact and owner are named for the release.
