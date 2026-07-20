<!-- merged into HANDOFF.md 2026-07-20 21:04:00Z; previous content preserved there. Append new rounds below. -->

## 2026-07-20 (round 2) — engo: lane-flip auto-export fix + items-silently-missing investigation, v0.35.0 / companion 1.3.1

**User on-device evidence driving this round:** (a) during a live Senna champ select, flipping Bot → Support left auto-export (both runes and items) on the OLD lane's build — the client still had "CoachBuild Senna Bot" after switching to Support. (b) A second report from the SAME champ select: runes auto-exported but item sets silently did not, despite the items toggle defaulting ON.

### (a) Lane-flip dedup fix

**Root cause (verified in code, not assumed):** `components/live/champSelectFollowState.ts`'s auto-export dedup keyed ONLY on `championId` (an ever-growing `Set<string>` of `"${kind}:${championId}"`). `BuildTabContent.tsx`'s auto-export effect gates on `hasAppliedForChampion(kind, championId)` — once true for a champion (from the FIRST lane's export), it stayed true for the rest of that champ-select epoch regardless of lane, since `handleLaneChange` (`app/page.tsx`) never touches the champion, only `activeLane`.

**Fix:** replaced the championId-only Set with a single most-recently-exported `(championId, laneId)` pair PER KIND (`shouldAutoExportForLane` / `markAutoExported` in `champSelectFollowState.ts`) — "latest wins": fire whenever the current pair differs from the last one applied. This is deliberately simpler than a per-championId lane map, and correctly handles a same-champion lane bounce Bot → Support → Bot (each flip differs from whatever was most recently applied, so each re-fires) per the brief's own "simplest correct" framing.

**Additional guard on the RE-FIRE path only** (first-ever export keeps its existing, unchanged gate — `isCompanionDrivenChampion`): a lane re-fire only proceeds when `isInChampSelect()` (new, mirrors the last phase `noteCompanionPhase` was called with) AND `getCurrentChampSelectChampionId() === championId` (new — the companion's OWN live champ-select resolution, fed every poll tick by `app/page.tsx` via a new `resolveCurrentChampSelectChampionId` split out of `champSelectFollow.ts`'s `resolveChampSelectFollow`). Without this, browsing back to an old companion-driven pick after champ select ended (isCompanionDrivenChampion doesn't expire until the NEXT champ-select entry) and flipping ITS lane would also incorrectly re-export.

The multi-tab localStorage lock (`tryClaimAutoExportLock`) gained `laneId` in its key for the same reason — a lock claimed for one lane must never starve a legitimate re-fire for a different lane on the same champion within the 30s TTL window.

### (b) Items-silently-missing investigation

Traced all 4 candidate causes the coordinator listed, against the actual current code (not the brief's hypotheses):

1. **"Follow path doesn't trigger item export"** — DISPROVEN. Both `autoApplyItemSetsIfEligible` and `autoApplyRunesIfEligible` are called from the exact SAME unified effect in `BuildTabContent.tsx` (`[state, lane]` deps), fired identically regardless of whether `champ`/`activeLane` changed via the deep-link mount effect or the live-follow poll.
2. **"Multi-tab lock contention"** — DISPROVEN as a cross-kind blocker. Lock keys are `coachbuild:autoExport:${kind}:...` (kind-scoped) — an "items" claim can never be blocked by a "runes" claim.
3. **"Toggle defaults OFF"** — verified `getAutoItemSetsEnabled`/`getAutoRunesEnabled` are byte-for-byte symmetric (same default rule, same synchronous localStorage read at effect-call time, no hydration-order risk since both are read fresh inside a client-only effect). Can't rule out an actual per-device persisted `false` value, but that would be device data state, not a code bug.
4. **"Stale URL guard (`isAutoExportEligibleBuild`) blocking the follow path"** — CONFIRMED NOT the live cause, but for a more fundamental reason than expected: **this guard has had NO call site in `BuildTabContent.tsx` at all since the v1.3.0 rewrite** (grep-verified repo-wide). It's fully superseded by `isCompanionDrivenChampion` and is dead code in the runtime path today — kept exported only because its own regression tests (P1 audit, 2026-07-20) are still pinned and valid as historical documentation. Added a clarifying comment in `itemSetsApply.ts` explaining this, so a future reader doesn't assume it's load-bearing and "fix" something that isn't wired in. Wiring it against `window.location.search` (as the coordinator's candidate #4 suspected) would in fact be WRONG for the follow path exactly as flagged — the URL is only ever set once at deep-link mount, never touched by a later live-follow champion change.

**The one real, verifiable asymmetry found:** item sets have strictly more surface area that can throw BEFORE ever reaching the companion — `applyItemSetsForBuild` calls the synchronous, pure `buildItemSets` AFTER the async `resolveProConsensusForSets` resolves; runes has no equivalent extra step. Neither `BuildTabContent.tsx` promise chain had a `.catch()` — only `.then(onFulfilled)` — so ANY uncaught rejection anywhere in either attempt (a probe throwing, a pure builder throwing on a genuinely malformed field, anything) would vanish completely silently: no toast, no companion call, no console signal a user would ever see. This matches "runes worked, items silently didn't" exactly. Fixed: both promise chains in `BuildTabContent.tsx` now end in `.catch()`, surfacing the same visible error toast the graceful `ok:false` branch already shows.

I could not reproduce or pin the EXACT trigger for this specific user's Senna Bot session (no repro harness for a live LCU) — reporting this as "hardened against the class of bug that explains it," not "found and fixed the literal root cause with certainty." If it recurs with the new `.catch()` in place, the user will now SEE an error toast, which itself will be diagnostic information we didn't have before.

### Champ-scoped item-set stale cleanup (companion 1.3.1)

Verified via reading `Merge-ItemSets`: pre-1.3.1, the stale-removal prefix was ALWAYS derived from the new set's own (role-scoped) title — a lane flip's export left the OLD lane's set behind (e.g. both "CoachBuild Senna Bot" and "CoachBuild Senna Support" would coexist). Added an explicit `replacePrefix` field to the `/apply-itemsets` wire body: web now sends `CoachBuild <champ> ` (champ-scoped, trailing space load-bearing — stops "CoachBuild Vi " from also matching "CoachBuild Viktor ...") via `itemSetBody.ts`'s new `champScopedReplacePrefix`. Companion validates it starts with "CoachBuild" (same defense-in-depth as titles, rejects the WHOLE request otherwise) and prefers it over the title-derived prefix when present; falls back to the original em-dash-derived, role-scoped prefix when absent (back-compat either direction).

**Verified runes do NOT need the same fix** — read `Invoke-ApplyRunes`: it matches ANY page whose name starts with the literal `'CoachBuild'` (no champ/role scoping at all), so at most ONE CoachBuild rune page ever exists — a lane flip already replaces it, never accumulates. No change needed there.

### Files touched
- `components/live/champSelectFollowState.ts` — rewrite: `lastApplied` (per-kind single pair) replaces `appliedKeys` Set; new `isInChampSelect`, `setCurrentChampSelectChampionId`/`getCurrentChampSelectChampionId`, `shouldAutoExportForLane`, `markAutoExported`; `tryClaimAutoExportLock` gained a `laneId` param.
- `components/live/champSelectFollow.ts` — new exported `resolveCurrentChampSelectChampionId`, factored out of `resolveChampSelectFollow`.
- `app/page.tsx` — status-poll tick now calls `setCurrentChampSelectChampionId` every tick.
- `components/hextech/BuildTabContent.tsx` — effect updated to the new dedup API + `.catch()` on both promise chains.
- `components/hextech/itemSetBody.ts` — new exported `champScopedReplacePrefix`.
- `components/live/companionClient.ts` — `applyItemSets` body type gains `replacePrefix?: string`; header comments updated.
- `components/hextech/itemSetsApply.ts` — passes `replacePrefix`; clarifying comment on `isAutoExportEligibleBuild`'s dead-code status.
- `public/companion.ps1` — version `1.3.0` → `1.3.1`; `Test-ItemSetsPayload`/`Merge-ItemSets`/`Invoke-ApplyItemSets` gain `ReplacePrefix`; bridge route wires `$bodyObj.replacePrefix` through; new SelfTest cases (champ-scoped removal across old-lane + old-3-set-era titles without touching a non-CoachBuild or different-champion set; bad-prefix rejection).
- `public/companion.version` — `1.3.0` → `1.3.1`.
- Tests: `champSelectFollowState.test.ts` rewritten; `champSelectFollow.test.ts` gains `resolveCurrentChampSelectChampionId` coverage; `itemSetBody.test.ts` gains `champScopedReplacePrefix` coverage; `itemSetsApply.test.ts` pins `replacePrefix` on the wire body.
- `package.json` `0.34.1` → `0.35.0`; `CHANGELOG.md` new entry.

### Verification
- `powershell ... companion.ps1 -SelfTest` → PASSED (incl. all new replacePrefix cases).
- `powershell ... companion.ps1 -Mock -Once` → PASSED.
- `powershell ... companion.ps1 -HarnessTest` → PASSED.
- `bash scripts/verify-fix.sh` (tsc, lint, tests, build, sw, manifest) → ALL PASS, run twice (pre/post version bump). **851 tests passing** (baseline 834; +17 net new/updated across the 4 touched test files).

### Ship
- Committed as `harout_b5@live.com`.
- `npx vercel --prod --archive=tgz` — prod URL verified to serve `v0.35.0` (footer).
- **User action required this time:** the companion is a long-running background process — auto-update only shows a balloon notification, it does NOT self-replace itself. The user must: (1) right-click the CoachBuild tray icon → Quit, (2) re-run the install one-liner (`irm https://coachbuild.vercel.app/companion.ps1 | iex`, or the persistent `-Install` variant if they want it back on the Startup list) to pick up companion 1.3.1. Confirmed via `/status`'s `version` field on next Test Connection.

### Pending / out of scope
- Could not reproduce the exact "items silently missing" trigger for THIS specific user's session (no live-LCU repro harness available) — see investigation notes above. The `.catch()` hardening is defense-in-depth for the whole class of "uncaught rejection = silent no-op" bug, not a confirmed single root cause.
- `HANDOFF.md`/`HANDOFF-engy.md` again show pre-existing uncommitted changes in this worktree that are not mine — left untouched, not staged.
