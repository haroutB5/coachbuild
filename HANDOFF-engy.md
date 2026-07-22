<!-- merged into HANDOFF.md 2026-07-22 14:29:42Z; previous content preserved there. Append new rounds below. -->

## engy — 2026-07-22 — v0.48.2 / companion 1.6.3 (pro-page separation + -Install auto-launch)

### TASK 1 — pro runes get reverted → separate the Pro page from the WPA page
**Root cause (confirmed):** both the WPA auto-export and *Apply pro runes* built the SAME title `"CoachBuild <champ> <role>"` (`runeApplyBody.ts` `buildRuneApplyBody`), and the pre-1.6.3 companion `Invoke-ApplyRunes` matched ANY `"CoachBuild*"`-prefixed page and edited the **oldest in place** — so WPA and Pro fought over ONE physical LCU page. The AutoExporter (`components/live/autoExport.ts`, mounted app-wide in CompanionProvider) applies WPA and dedups per `(championId, laneId)` via `markExported`, so it fires WPA once per champ-select — but any WPA re-application (champ re-resolve, lane flip, remount, multi-tab) overwrote the shared page → the revert.

**Two page titles + cleanup scoping:**
- WPA page: `"CoachBuild <champ> <role>"` (unchanged; RunesSummonersCard + auto-export).
- Pro page: `"CoachBuild <champ> <role> Pro"` — web now calls `buildRuneApplyBody(champ.name, roleLabel, runes, { pageSuffix: "Pro" })` in `ProConsensusCard.tsx`. Suffix AFTER champ/role so the champ-scoped prefix `"CoachBuild <champ> "` matches BOTH pages.
- New `replacePrefix` field on the apply body (`RuneApplyBody`, both variants set `"CoachBuild <champ> "`), forwarded by `companionClient.applyRunes` and used by the companion for champ-change cleanup — mirrors the item-sets `replacePrefix` precedent (`champScopedReplacePrefix`).
- Companion `Invoke-ApplyRunes` rewrite: STEP 1 champ-scoped stale cleanup (delete OUR `"CoachBuild*"` pages whose title does NOT start with `replacePrefix` = other champs; NEVER a page starting with the prefix → protects both current-champ pages from cross-deletion; NEVER a non-CoachBuild page; fail-soft on a refused delete); STEP 2 EXACT-TITLE match (not prefix) → PUT-in-place; STEP 3 create (free slot) / manual consent fallback / auto slots-full. Bounded at the current champ's ≤2 pages.

**Secondary-tree body finding:** the user's "consensus said Sorcery secondary but the page showed Resolve" was the SAME revert symptom — the WPA page's Resolve secondary overwrote the pro page's Sorcery. The pro **body construction is correct**: `proConsensusRuneApplyInput` builds `subStyleId` from the tree-conditioned `model.secondaryTree.treeId` and picks from `model.secondaryPicks` (Phase-B conditioned on that tree in `proConsensus.ts`), verified by the existing 9-slot-order test. The companion's readback-verify (`Complete-RuneApply`) still compares `name` + `selectedPerkIds` byte-for-byte, so a genuine content mismatch is caught honestly. No body bug to fix — the separate page resolves it.

**HARD INVARIANT preserved:** never DELETE/PUT-overwrite a non-`"CoachBuild"` page. Auto 5-page/0-CoachBuild adversarial = zero deletes, now also proven WITH `replacePrefix` present (new 6k).

### TASK 2 — `-Install` launches the companion immediately
`Install-Companion` (`public/companion.ps1`): after writing the truly-hidden Startup `.vbs` (unchanged), it now also launches the watcher right away via `Start-CompanionDetachedHidden` → `WScript.Shell.Run(cmd, 0, False)` — windowStyle 0 = hidden (honored under Windows Terminal, unlike `-WindowStyle Hidden`), fire-and-forget. Launch command shared with the `.vbs` via `Get-CompanionLaunchCommand` (single source of truth; the spawned process runs `irm .../companion.ps1 | iex` → `Start-Companion`).
**Double-launch guard:** `Test-CompanionAlreadyRunning` opens the named single-instance mutex `Local\CoachBuildCompanion`; if held → surface "already running", don't spawn. The spawned instance's own `Test-SingleInstance` mutex is the hard backstop, so re-running `-Install` never stacks. Session token persisted FIRST so the immediate launch + pairing page share it.

### Harnesses / gates
- `-SelfTest` PASSED (added 6g–6k rune two-page/cleanup/fail-soft cases + 8b/8c install launch-command + guard). `-Mock` PASSED. `companion.ps1` 100% ASCII.
- `verify-fix.sh`: tsc + lint(0) + **1415 tests** + build + sw + manifest ALL PASS. Added 3 web tests (`runeApplyBody.test.ts`) + updated the pro-apply title test (`proConsensus.test.ts`).

### On-device verification needed (unreproducible without a live LCU)
1. *Apply pro runes* leaves a distinct `"CoachBuild <champ> <role> Pro"` page that COEXISTS with the WPA page and survives the WPA auto-export (no revert).
2. Switching champions cleans up the previous champion's CoachBuild pages (both WPA + Pro) while leaving your own hand-made pages untouched.
3. Re-run `& ([scriptblock]::Create((irm https://coachbuild.vercel.app/companion.ps1))) -Install` → companion starts hidden immediately (tray icon appears, no click/reboot); re-running while it's running says "already running" and does not stack a second tray instance.
