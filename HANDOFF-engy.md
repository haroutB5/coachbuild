<!-- merged into HANDOFF.md 2026-07-22 14:00:02Z; previous content preserved there. Append new rounds below. -->

## v0.48.1 / companion 1.6.2 — rune apply "delete-failed" root-cause fix (engy, 2026-07-22)

**Bug (real device, reported twice):** "Apply pro runes" / auto-runes FAILED when a CoachBuild WPA rune page already existed in the client. Confirmed mechanism: apply was DELETE-then-CREATE, and when the existing "CoachBuild …" page was the **currently-selected** page, the LCU refuses to DELETE the selected page → `delete-failed` → nothing applied.

**Fix — PUT-in-place edit (`public/companion.ps1`, `Invoke-ApplyRunes`):** when a page we own (title starts "CoachBuild") already exists, edit it in place instead of delete+create.

- **Exact LCU endpoint used + why:** `PUT /lol-perks/v1/pages/{id}` with the full `LolPerksPerkPageResource` body (`id` + `name` + `primaryStyleId` + `subStyleId` + `selectedPerkIds` + `current:true`). **Verified against the authoritative LCU OpenAPI schema** (mingweisamuel/lcu-schema): `/lol-perks/v1/pages/{id}` exposes `get`/`put`/`delete`; the `LolPerksPerkPageResource` schema carries exactly those fields. The task's guessed path `/lol-perks/v1/perks/{id}` was **wrong** — it's `/pages/{id}`. The community delete+create tutorials (hextechdocs) are a convention, not evidence PUT is absent. Editing our own page's contents is the same compliance class as delete+create (a passive loadout write) and sidesteps the "can't delete the selected page" wall entirely.
- **Decision tree (in-place vs delete→post):**
  - CoachBuild page exists → **PUT-in-place**, then PUT /currentpage (reaffirm select) + readback-verify. **No delete of our own page, ever.**
  - PUT edit fails → `{ok:false, reason:'edit-failed', hint:(status-coded)}`. **Deliberately NO fallback to delete+create** — the page is still the selected page, so a delete would fail the same way and reintroduce the exact bug. Honest `edit-failed` envelope is strictly safer.
  - No CoachBuild page + free slot → POST directly (unchanged).
  - No CoachBuild page + full → manual mode falls back to original currentpage delete+create (real click = real consent); auto mode returns `slots-full`, touches nothing (unchanged).
- **Hard invariant preserved (SelfTest-pinned):** never DELETE or PUT-overwrite a page whose title doesn't start with "CoachBuild". In-place PUT targets only our own page (title prefix + id match). Adversarial 5-page/0-CoachBuild auto fixture still issues zero deletes + zero foreign mutations.
- **`Complete-RuneApply` refactor:** now takes `-PageId` explicitly (was digging `id` out of the POST response) so the same select+verify tail serves both create paths (id from POST body) and the edit path (id is the known target — a PUT may return 204/no body).

**Harness results (both PASS, run via Windows PowerShell):**
- `-SelfTest` → `SELFTEST PASSED`. Fixture 6 rewritten: selected "CoachBuild Test Mid" page → apply → asserts updated **in place** (same id 222, new perk ids), **zero DELETE**, still selected (currentPageId=222), readback verified, adjacent non-CoachBuild page (id 111) untouched. Fixture 6f repurposed to `edit-failed` fail-soft (PagePutShouldFail → no fallback delete/POST). Fixture 6h moved create-failed coverage to the free-slot POST path (the replace path no longer POSTs). Mock LCU gained a `PUT /lol-perks/v1/pages/*` in-place handler + `PagePutShouldFail` flag.
- `-Mock` → `MOCK RUN PASSED`.
- `companion.ps1` 100% ASCII (0 non-ASCII bytes). COMPANION_VERSION → `1.6.2`.

**Web side:** no change needed. `components/live/companionClient.ts` `applyRunes` forwards the companion's `reason`/`hint` verbatim, so the new `edit-failed` hint reaches the toast unchanged. `RunesSummonersCard.tsx` (manual "Apply runes" button, mode `manual`) shows `Applied in-client.` on `selected && verified`, else `Saved as a rune page — open the client to select it.`, else `result.hint`. `runeAutoApply.ts` (mode `auto`) returns the result generically. No component branches on specific reason strings, so no `edit-failed` special-case is required. Same POST body for create and edit — the companion picks the strategy.

**Gates:** `verify-fix.sh` → ALL PASS (tsc clean, lint 0 warnings, tests **1412** passed, build clean, sw versioned, manifest present). App version `0.48.0` → `0.48.1`; CHANGELOG entry added.

**What the user should verify on-device (the one thing the harness can't prove without a live client):** open League, enter champ select / a game where a "CoachBuild <champ> <role>" rune page already exists **and is the currently-selected page**, then click **Apply pro runes** — it should now succeed (page updated in place, stays selected) instead of the old red `delete-failed` toast. Re-install the companion first to pick up 1.6.2.
