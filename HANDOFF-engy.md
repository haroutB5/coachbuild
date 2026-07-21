<!-- merged into HANDOFF.md 2026-07-21 19:43:06Z; previous content preserved there. Append new rounds below. -->

# HANDOFF-engy — CoachBuild v0.40.0 (2026-07-21)

## Ship: two user-reported P0/UX items — live pickup permanently dying + fringe sub-1000-game bans

**Deployed:** v0.40.0 → https://coachbuild.vercel.app (prod). `verify-fix.sh` clean, 1192 tests (baseline 1179 + 13 net new).

### Item 1 — /draft live pickup permanently died after any manual edit

**Confirmed the briefed mechanism exactly.** `dirty` (`app/draft/page.tsx`) is latched by every manual handler including `handleClearHover`, and was previously cleared ONLY by the explicit "Reset to live" link. One Clear tap in game 1 permanently detached the page from every future champ select — `resolveDraftLiveTarget` returns `null` whenever `dirty` is true, unconditionally.

**Fix — entry-transition auto-reset (`components/live/draftLiveSync.ts`):**
- New pure state machine `resolveChampSelectEntry(prev: ChampSelectEntryState, phase: string | null): ChampSelectEntryResult`. `ChampSelectEntryState` tracks only `lastRealPhase: string | null` — the most recently observed NON-NULL phase, across ticks.
- A `null` phase (transient `/status` poll failure) is a complete no-op: `{ isEntry: false, next: prev }` — it never updates `lastRealPhase` and never itself counts as leaving/entering anything. This is what makes the blip cases correct:
  - `ChampSelect → null → ChampSelect`: NOT an entry (the null tick left `lastRealPhase` at `"ChampSelect"`, so the next real tick sees no transition).
  - `Lobby → null → ChampSelect`: IS an entry (the null tick didn't touch `lastRealPhase`, still `"Lobby"` when the real tick lands).
- `isEntry = phase === "ChampSelect" && prev.lastRealPhase !== "ChampSelect"` — fires exactly once per genuine entry, never on the steady state (repeated `"ChampSelect"` ticks).
- **Wired in `app/draft/page.tsx`:** a new `entryStateRef` (ref, not state — pure bookkeeping) feeds `resolveChampSelectEntry` on every `companion.tick` inside the existing live-sync effect, BEFORE the existing `resolveDraftLiveTarget` call. On `entryResult.isEntry && dirty`, calls `setDirty(false)` and returns early — the re-render this triggers (dirty is already an effect dependency) re-runs the effect with fresh `dirty` state and applies the live target normally on the next pass. No double-apply, no infinite loop (the ref is updated to `next` regardless of whether `isEntry` fired, so entry can't re-fire on the following tick).
- Manual edits still win for the REST of the same champ select (the fix only resets on the entry tick, never on steady-state ticks) — preserves the earlier "follow fights user" behavior the plan is built around.

**Legibility fix (design item b):** the dirty+live-champ-select state previously showed a small underlined text link ("Reset to live") easy to miss entirely — plausibly why the bug read to the user as "live pickup is just dead" rather than "I'm in manual mode, here's the button." Replaced with a bordered, filled banner (`role="status"`, teal-tinted background/border matching the existing accent) reading "Manual mode — champ select detected" plus a solid filled "Reset to live" button (was: dotted-underline text link). The quiet "Syncing from champ select" pill for the passive-syncing state is unchanged.

**Tests (`components/__tests__/draftLiveSync.test.ts`, 8 new):** fresh-mount-into-ChampSelect is an entry; real-phase→ChampSelect is an entry; repeated ChampSelect ticks never re-fire; leave-then-reenter (the literal "game 2" repro) fires again; a null tick alone changes nothing; **the exact blip case from the brief** — `ChampSelect → null → ChampSelect` does NOT count as re-entry; a null blip DURING a real transition (`Lobby → null → ChampSelect`) still resolves correctly once the real tick lands; a non-ChampSelect→non-ChampSelect phase change is never an entry.

**Not verified on a real device this round (per dispatch note) — what the user should see on their next Practice Tool session:**
1. Game 1: enter champ select → hover auto-fills your champion (unchanged from before).
2. Tap Clear (or make any manual edit) → the "Manual mode — champ select detected" banner should appear (NEW — previously just a small link, easy to miss).
3. Finish game 1, start game 2's Practice Tool champ select → hover should AUTO-FILL again without touching Reset to live — this is the actual fix. Previously it stayed blank forever after step 2.
4. If it does NOT re-attach on game 2, the thing to check first is whether the companion's `/status` phase string between games is literally `"ChampSelect"` again (not some other value this repo hasn't seen) — `resolveChampSelectEntry` only recognizes the exact string `"ChampSelect"`, matching `resolveDraftLiveTarget`'s existing check.

### Item 2 — Suggested bans included sub-1000-game fringe rows outranking well-sampled counters

**Confirmed the exact repro is the reported mechanism.** Ban candidates are drawn from `pool` (`lib/draft/recommend.ts`), which is floored by `filterPoolByTotalGames` at `POOL_MIN_TOTAL_GAMES=5000` — but that's the champion's AGGREGATE games across every opponent in that role, not the specific hover-vs-target matchup sample `rankBans` actually scores and the UI displays as `n=`. A champion can clear the 5000-aggregate floor easily while having a tiny, noisy sample against one specific hovered champion — that's exactly how Singed (n=463 vs Viktor) out-scored Xerath (n=16547 vs Viktor): a genuine shrunk-delta disadvantage on a small sample can still exceed a well-sampled one's magnitude.

**Fix (`lib/draft/score.ts`, `rankBans`):**
- New named constant `BAN_MIN_MATCHUP_GAMES = 1000` — same VALUE as `PLAY_MAIN_SAMPLE_FLOOR` but a deliberately separate constant (different axis: hover-vs-target matchup, not direct-lane-opponent matchup; doc comment cross-references both).
- Candidates with no matchup row, or `row.games < BAN_MIN_MATCHUP_GAMES`, are excluded from the ban pool ENTIRELY (`.map` → `null` → `.filter` out) — not scored at 0, not flagged "low confidence" and still shown. Ban formula (`disadvantage × presence`) is byte-identical otherwise.
- Side effect worth knowing: since `BAN_MIN_MATCHUP_GAMES (1000) > K (200)`, the `confidence: "low"` branch inside `rankBans` is now structurally unreachable for any surviving candidate — kept as a real `row.games < K` check (not hardcoded to `"normal"`) rather than deleted, so it self-corrects if either constant is ever retuned independently. Flagged in a code comment at the call site.
- `app/draft/page.tsx`: the `bans.length === 0` empty-state copy changed from the old generic "No strong bans identified" / "Nothing stands out…" to "No well-sampled counters" / "No well-sampled counters to your pick this patch — check back as more games are recorded." — this state now specifically means the floor filtered everything, not "nothing stands out," and the copy needed to say that honestly rather than fabricate a ban.

**Tests (`lib/__tests__/draft-score.test.ts`, describe "ban candidate floor", 5 new):** floor value pinned equal to `PLAY_MAIN_SAMPLE_FLOOR`; exactly-at-floor (1000 games) included; **the literal Singed(463)/Xerath(16547) repro** — sub-floor excluded even with a real signal, well-sampled candidate included and ranked; just-under-floor (999) excluded; empty-result shape (all candidates sub-floor → `[]`). Three pre-existing `rankBans` tests updated because they previously depended on missing/sub-floor rows still appearing (`new Map()` for a top-5 tiebreak test, and the confidence/minGames pair that used to exercise n=300/n=90 — both now sub-floor).

**PROD SMOKE:**
```
GET /api/draft/recommend?lane=2&hover=<Viktor champId>
→ every entry in `bans[]` has minGames >= 1000 (verify exact command/output below)
```

### Ship mechanics
- `bash scripts/verify-fix.sh coachbuild`: tsc clean, lint clean (0 warnings), 1192 tests passed (baseline 1179 + 13 net new: 8 draftLiveSync + 5 draft-score, 0 net from 3 pre-existing tests updated in place), build clean, SW/manifest OK.
- Version bump `0.39.1` → `0.40.0` (`package.json`), `CHANGELOG.md` entry added for both items.
- Commit authored as `harout_b5@live.com` / `Harout` (Vercel personal-account requirement).
- Deployed via `npx vercel --prod --archive=tgz`.

### Not done this round (explicitly out of scope, called out per dispatch)
- Real-device confirm of the full hover→auto-fill→game-2-reattach flow — needs the user's own Practice Tool session (companion 1.5.0 + LCU), can't be simulated headlessly. See "what the user should see" above.
- No change to `BanResult.confidence`'s TYPE or `PersonalPlayResult`/play-list scoring — this ship touches `rankBans` candidate INCLUSION only, not `computeScoredPool`/`splitPlaysBySampleSize`/the play-list formula.

