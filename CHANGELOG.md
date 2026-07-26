# Changelog

All notable changes to CoachBuild are documented here.

## [0.61.1] — 2026-07-26 — The support quest item is one of the six

### Fixed
- **Support builds could show seven real item slots.**  treated support as an
  ordinary lane at 5 full items + boots. But a support permanently carries the quest item (World
  Atlas → Zaz Zak s Realmspike / Bloodsong), which SupportItemCard renders in its own section — so
  the surfaces together added up to support item + boots + 5 full = **seven**, the same impossible
  inventory the Galio MID fixture was written to catch, arriving by a different route.

  Support now caps at **4** full items, so the loadout reads support item + boots + 4 full = six.
  Top/Jungle/Mid/Auto stay at 5 + boots. Bot keeps its deliberate exception (6 full + boots) for the
  late-game boots-sell pattern. A new test asserts the totals per role rather than the cap numbers
  alone, so the next lane rule has to state what it adds up to in the game.

## [0.61.0] — 2026-07-26 — The rest of the audit list

### Fixed — three lists that dead-ended
- **Patch Movers rows are links.** Twenty-plus champions with a win-rate swing and no way to reach
  their build, on the app whose entire purpose is champion → build. Each row now routes to
  `/?championId=&role=`; `role` only rides along when it is a real lane (0-4), because
  `parseLiveDeepLink` rejects the whole link on a malformed role rather than degrading.
- **My Stats champion-pool rows are links.** Your own most-played champions are the shortest route
  into a build.

### Fixed — /draft
- **Three inputs, three behaviours, one placeholder.** The page showed the global TopBar search plus
  two `ChampionPicker`s, all reading "Search champion…". They now read "Add an enemy champion…" and
  "Set your champion…". `ChampionPicker` gained an optional `placeholder` that defaults to the old
  wording, so every other call site is untouched.
- **The picks table clipped its Synergy column at 1440px** — a very common laptop width — because
  the table forced `min-w-[620px]` inside the right-hand column. 540px fits without a horizontal
  scroll; the container keeps `overflow-x-auto` for genuinely narrow viewports.
- **The page title used the Cinzel display face** while Pro Players, Patch Movers, My Stats and
  Companion all use the sans `PageHeader` treatment. The display face is for champion names.

### Fixed — touch targets and the empty landing
- **Sub-44px tap targets on mobile**: the TopBar search input (37px), its suggestion rows (36px) and
  the Apply-runes button (33px) now clear 44px.
- **The Builds landing was ~85% empty at 1440x900**, footer stranded mid-screen with a few hundred
  pixels of nothing beneath it. The empty state now fills the viewport.

  Deliberately still suggests no champions. `ChampionPickPrompt` carries a standing directive —
  "stop showing Viktor by default" — and its own note that recommending popular picks would be
  "Viktor with extra steps, still the app choosing for you". This is a layout fix only: no content
  added, nothing implied that the app does not know.

## [0.60.1] — 2026-07-26 — WPA gets defined; the desktop shell comes back out

### Added
- **WPA is defined on the page for the first time.** Every green and red figure on Builds is a WPA
  delta, and the string "WPA" appeared exactly once in the whole surface — as a section label, on a
  scale nothing explained. It now reads: *WPA is Win Probability Added — how much a pick shifts your
  chance of winning, measured by coachless.gg.* Defined once, where the first labelled WPA sits;
  `/compact` renders the same card and inherits it.

### Removed
- **The Electron desktop shell (`desktop/`), `lib/lcu/applySafety.ts` and the plan document.**
  Building it was the right call to investigate and the wrong call to finish: it cannot be verified
  without a machine running the League client, and this one has none. Shipping an unverified process
  that writes into a user's rune pages on the strength of a typecheck is not a trade worth taking.

  What survives is the part that stood on its own: `/compact` (v0.60.0) is a normal web route and
  keeps working as a pop-out mini view. `companion.ps1` continues as the only companion, so the
  freeze-or-sunset question the shell raised is moot — there is no second implementation to drift
  against.

  The 31 tests removed with `applySafety.ts` pinned a TypeScript re-implementation of rules that
  only `companion.ps1` actually runs. Keeping them would have meant a green suite proving something
  no user ever executes, which is worse than no suite: it reads as coverage. The rules stay pinned
  where they are enforced, by the companion's own `-SelfTest`.

## [0.60.0] — 2026-07-26 — /compact: one mini view, two hosts

### Added
- **A chrome-free `/compact` route** — champion, runes + summoners, buy order, and the Apply-runes /
  Add-item-builds buttons, at ~380px with no rail and no tab bar. Pop it out onto a second monitor
  in any browser; the desktop shell loads the SAME route in its always-on-top champ-select overlay.
  It live-follows champ select through the existing companion poll, so it tracks hovers in place.

  Deliberately one route rather than shell-native UI: an overlay is the one thing a browser cannot
  do, but its CONTENT must not be desktop-only, or the web app forks and the phone drifts behind.
  The shell contributes window behaviour and nothing else. `AppShell` gained a `CHROMELESS_ROUTES`
  set for this — the only structural change, and it is pathname-driven web code, not host detection.

  Not follow-capable on purpose: `followKindForRoute()` still maps only `/` and `/draft`, so having
  the mini view open never suppresses the companion opening Builds for a browser user. Worst case is
  one redundant tab, which is the right side of that trade.

  Caught in smoke: `/api/build` returns the TOP-3 VARIANTS as an array, not one build. Typed as a
  single object it crashed the route client-side on `build.champion.name`. It now reads variant 1.

### Groundwork — desktop shell (`desktop/`, not yet shippable)
- `lib/lcu/applySafety.ts` lifts the rune-page and item-set WRITE RULES out of `companion.ps1` into
  shared, pure TypeScript — the title gates, the never-touch-a-page-we-do-not-own decision, and the
  O(1) item-set prune whose boundary keeps the user's own sets sacred. **31 tests** in the normal
  gate now pin what only a PowerShell `-SelfTest` pinned before, including the adversarial fixture:
  five rune pages, none of them ours, auto mode, and the correct behaviour is to write nothing and
  delete nothing.
- An Electron shell that typechecks and bundles: LCU discovery with a loopback-scoped TLS agent, the
  identical companion wire contract (`follow`/`detach` accepted and ignored, additive `host` field),
  an owned window that navigates instead of opening tabs, `backgroundThrottling: false`, an LNA
  permission grant, a navigation allowlist, its own minted session token, and a startup probe that
  refuses to run silently alongside the PowerShell companion.
- **Unverified against a real League client** — there is none on the build machine. No packaging, no
  installer, no auto-update. Do not treat it as shippable.

## [0.59.1] — 2026-07-26 — Two claims the data does not keep

### Fixed — Draft told you off-role picks could not out-rank lane staples, while showing exactly that

The picks explainer read "a rare off-role pick won't out-rank a real lane staple." On an empty MID
board the top four were Singed, Tryndamere, Garen and Heimerdinger. The filter is not broken — all
four clear the 5,000-game floor honestly (Singed mid has 11.5k games this patch) — but within that
pool the ranking is by win rate, so a genuinely strong niche pick sits above a popular staple by
design. The copy promised a guarantee the model never made.

Copy now states what the list actually is: the 5,000-game floor, win-rate ranking inside it, and a
pointer at the games column. The scoring model is untouched — retuning a quant layer to make a
sentence true is the wrong direction, and any change there wants live data, not a guess.

### Fixed — "CORE ORDER — HIGHEST WPA" ending on a negative number

Jinx's core order finishes with Mortal Reminder at −0.02. The qualifier describes how each SLOT is
filled (the highest-WPA option available at that point), not the sequence — the sequence is buy
order — but read as "sorted by WPA" the label contradicts itself the moment a late slot's best
option is negative. Now labelled "buy order", with one line explaining that a negative value means
even the best option there trends slightly below average.

## [0.59.0] — 2026-07-26 — The browser was closed, so the pages never opened (COMPANION CHANGE → 1.7.0 — re-install required)

User report: "if the browser isn't open, it doesn't automatically detect and open it and have the
pages ready."

### Fixed — a closed browser looked "attached" for 150 seconds, which is most of a champ-select

The companion only opens a page it believes isn't already open, and it inferred that from how
recently the page polled `/status`. v1.6.4 widened that window from 8s to 150s for a good reason —
Chrome throttles a hidden tab behind a fullscreen game to roughly one timer tick per minute, and the
8s window made every champ-select stack up another pair of tabs. But a *closed* browser is
indistinguishable from a throttled one by poll cadence alone, so closing the browser left both kinds
looking attached for up to 150s and the companion opened **nothing at all** for the rest of that
champ-select. The debounce made it worse: opening is decided only on a champion *change*, so if the
one resolution of that game fell inside the shadow, no later tick retried it.

A cadence can't answer this, so the page now says it outright. `detachFollow` sends
`follow=<kind>&detach=1` (keepalive GET, so it survives the unload) on `pagehide` and whenever a
client-side nav leaves a follow-capable route; the bridge clears that kind's attach stamp and
records `LastBuildsDetachAt`/`LastDraftDetachAt`, which also voids an open→attach grace it
postdates. Deliberately **not** wired to `visibilitychange` — a hidden tab is the normal state for
this feature and is still following; detaching on hide would rebuild the exact tab-spam bug v1.6.4
fixed.

For the hard-kill case where no `pagehide` can fire (task-kill, crash, sign-out),
`Test-BrowserProcessRunning` gates the stamp: no browser process, no attached tab. It can only ever
*widen* opening — it never suppresses an open the old logic would have made — so it cannot regress
the tab-spam fix either.

### Added — the pages are opened on champ-select ENTRY, not at the first hover

"Ready" means loaded before the pick, not booting during it. `Invoke-ChampSelectPrewarm` runs once
on entry and opens whichever of Builds / `/draft` is missing, so a cold browser starts up during
bans. Builds gets a session-only `/?session=` — there is no champion to link to yet, and inventing
one would show a champion nobody hovered; the tab adopts the session (`app/page.tsx`'s mount effect
now takes a session-only link, previously discarded because `parseLiveDeepLink` requires a
`championId`) and live-follows the first hover in place, which is what an attached tab has always
done. Each pre-warm open stamps the grace, so the first champion resolution suppresses instead of
opening a second pair — verified by `-Mock`, along with the both-attached and one-attached cases.

Companion `-SelfTest` covers the detach wire contract against a real bridge (per-kind clearing,
cross-kind isolation, and a kind-less `detach=1` touching nothing); `-Mock` covers the state machine
(detach re-opens, detach vs grace ordering, the liveness guard both ways, and pre-warm).

## [0.58.0] — 2026-07-26 — Audit wave 3: the unauthenticated cost amplifiers, and a support who was never AD

Wave 3 of `AUDIT-2026-07-25.md`. Two independent lanes: the security cluster (Agent 3's findings)
and the last of the item-set/archetype list. No P0s — the posture was already good; these are the
"one bad day upstream and the app is down" class, plus one long-standing misclassification that
v0.57.0's honest labelling finally made visible.

### Fixed — `/api/prostage/timeline` could be made to fan out ~750 outbound requests, by anyone, repeatedly

No auth, no cooldown, no rate limit. On `timeline_status IS NULL` the route synchronously resolved
the game then walked up to `WALK_MAX_POINTS=500` detail points at `WALK_CONCURRENCY=12` with
retries, then ddragon. A `transient` outcome correctly persists nothing — which meant the next
identical request re-walked the whole thing, and a burst of concurrent requests for the same
unresolved game each launched their own independent walk.

Migration `0016` adds `timeline_next_attempt_at` + `timeline_attempt_count`. The route now claims a
game with an atomic `UPDATE ... WHERE timeline_status IS NULL AND (next_attempt IS NULL OR
next_attempt <= now()) ... RETURNING` before touching the network. A concurrent request loses the
race — 0 rows back, courtesy of Postgres re-evaluating the predicate after the winner commits — and
bounces `429` having made **zero** outbound calls. On `transient`, the same column moves out on
exponential backoff (60s → 1h cap). If the walk crashes mid-flight the lease simply expires, so
there is no unlock step to forget.

**The transient-vs-terminal taint discipline is untouched** — `timeline_status` still stays NULL on
a transient result. The new column gates *when* a NULL-status row may be retried, never *whether*
it may be. Backoff logic lives in `lib/prostage/timelineBackoff.ts` because Next's route-type
checker rejects non-whitelisted exports from a route file.

### Fixed — not one outbound fetch on any hot path had a timeout

Bare `fetch(url)` throughout `lib/pro/**` and `lib/prostage/**`. A single hung socket burned the
entire `maxDuration` — 90s on patch-movers — instead of failing fast. New `lib/fetchTimeout.ts`
(8s default, 4s for the high-fanout timeline walk), wired through every call site plus the
`lib/coachless.ts` / `lib/staticData.ts` choke points behind `heroStats` and `patchMovers`.

### Fixed — `/api/patch-movers` amplified an upstream outage and its CDN cache was trivially bypassed

~400 coachless calls at concurrency 10 per cold request, and *any* junk query param produced a fresh
cache key and therefore a fresh cold compute. Junk params now `308` to the canonical path before any
work happens, and `lib/patchMoversCache.ts` adds a 6h/2m single-flight cache. The realistic damage
this avoids is coachless rate-limiting the deployment's egress IP, which takes out the Builds page —
its only data source.

### Fixed — the companion disabled TLS validation process-wide, not just for the LCU

`Initialize-TlsShim` installed a blanket certificate-validation bypass so it could talk to the
League client's self-signed loopback endpoints. The callback now inspects the sender's host and
bypasses validation for loopback only; everything else — including the `companion.version` check
against `coachbuild.vercel.app` — gets real validation again.

### Fixed — Leona, Braum and Rell were classified as AD champions by a single support item

v0.57.0 did not cause this; it exposed it. `resolveDamageFamily` tie-broke on a bare `ap !== ad`
item tally, so **one** item — id `2524` Bandlepipes, a generic support Artifact carrying an
incidental `AttackSpeed` tag — took tank supports from `ap=0/ad=1` to a `confident: true` AD
verdict, skipping the correct `Support` → AP class-tag fallback. That's how Leona ended up shipping
`Bruiser (AD)` and `Lethality/Assassin` lines. The tally must now clear a margin of 2 before it
outranks class tags. Checked against 27 live champions: genuine AD and AP carries win their tally by
margins of 8–15, so none of them move.

### Fixed — three curated pool ids have been dead since 16.13.1

`3001` is **Evenshroud**, not Abyssal Mask (which is `8020`) and was mislabelled in two pools;
`6691` Duskblade and `3193` Gargoyle Stoneplate are both unpurchasable. The tank pool was quietly
running at 6/8. All three verified against the live 16.13.1 catalog rather than taken on trust.
`curatedArchetypePool` now warns once per process when any curated id resolves to
`purchasable: false`, so the next patch's casualties are loud — an enumeration used as a guard rots,
which this audit had already learned once.

### Fixed — a test fixture that made its own rule untestable

`itemSetBody.test.ts` fabricated `into: ["999999"]` on allowlist ids that really have `into: []`,
and its own comment conceded the gap. Proved the blind spot by disabling the Lane-starter structural
rule: the old fixture stayed green, a real pinned catalog slice correctly failed. The test was
wrong, not the code — replaced with `realStarterMeta()`, a transcribed 16.13.1 slice for all 11
allowlist ids.

### Known verification gap

The TLS change has **not** been exercised against a real self-signed LCU certificate. There is no
League client in the build environment and `-SelfTest`'s mock LCU is plain HTTP, so the one code
path this change touches is the one SelfTest cannot reach. `-SelfTest` passes; that is not the same
as proven. Needs a live client round trip.

## [0.57.0] — 2026-07-25 — Item-set honesty: a block title now describes its own contents

Wave 2 of the `AUDIT-2026-07-25.md` findings, all three in `components/hextech/itemSetBody.ts`.
One theme: **every block title was making a claim the block didn't keep** — about its ordering, about
being distinct from the block above it, or about being measured. Verified by driving the real
`buildItemSets` against live production data across 49 champions, not fixtures.

| | before | after |
|---|---|---|
| duplicate block pairs across families | 13 | **0** |
| blocks whose title claims a metric they aren't ordered by | 19 | **0** |
| blocks 100% judgment fill yet unlabelled | 6 | **0** |
| over-6 lines / duplicate ids / wrong boots count / starters in a line | 0 | 0 |
| max item-set bytes (4096 limit) | 1842 | 1710 |

### Fixed — WPA and pro pick-rate were being compared as if they were one number

`fromPicks` weighted candidates by WPA, `fromShares` by pro share, and `unionPool` kept the MAX
across both. Those are not the same scale: live WPA runs roughly **-3.94 to +1.35 and is frequently
negative**, while shares are 0..1. So a pro pick-rate could rescue an item whose own WPA said it was
actively harmful, and any item above +1 WPA outranked every pro pick regardless of adoption. The
module header asserted the two "have always been this module's one shared ranking axis" — they never
were.

Each scale (`wpa`, `share`, `gold`) is now ranked ONCE over its own full union of sources, and a
candidate's ranking score is its **reciprocal rank** `1/(1+rank)` within that pool. Reciprocal rank
rather than a linear `1 - idx/len` on purpose: linear normalisation is pool-size sensitive (last of
3 scores 0.0, tenth of 20 scores 0.5), which is the same incommensurability this change exists to
remove. Ties share a rank, so two equal weights are never ordered by an accident of input order.

`Candidate` carries `{id, score, raw: {weight, scale}}`. `score` is the only ranking axis; `raw` is
provenance. The nesting is deliberate — `c.raw.weight` is loud in review where the old bare
`c.weight` read like a neutral number. Exactly one function reads a raw weight, and it takes the
scale as a parameter.

### Fixed — "Highest WPA" was not ordered by WPA

Live, Jinx Bot's Doran's Bow ranked **3rd in a block titled "Highest WPA"** on its 0.67 pro
pick-rate alone (it has no WPA in the union at all). New general rule: **in a block whose title
claims a metric, items carrying that metric rank first and are ordered by it; items lacking it are
appended as FILL and can never interleave above a metric-bearing item.** The boots pick is likewise
the highest-WPA boots rather than the highest raw mixed weight.

The name was KEPT rather than softened to "Top picks", because the block can now honestly make the
claim — verified across all 49 champions.

### Fixed — 13 pairs of duplicate blocks, shown one above the other

The v0.48.0 de-dup only ever compared archetype against archetype, and ran after Core build / Buy
order / Pro build / Highest WPA were already emitted. So the exact complaint that fixed ("don't
duplicate, show one and name it appropriately") came back between block FAMILIES: Ornn Top's
`Highest WPA` and `Tank` were byte-identical, and Lee Sin shipped `Core == Buy order == Pro build`.

`dedupeLineBlocks` now runs across every family, on order-insensitive set equality — order-insensitive
because Garen's `Pro build` and `Highest WPA` held the same five items merely reordered. One
carve-out: the Core build / Buy order pair only counts as duplicate when the ORDER matches too, since
expressing order is Buy order's entire purpose. Keep-priority follows canonical emission order. It
runs BEFORE the archetype-count trim, so a freed slot goes to real content rather than being lost.
The fuzzy v0.48.0 pass stays — it catches near-misses an exact test cannot.

Much of this was downstream of the ranking fix: with mixed scales, "top 6 by weight" converged on
whatever the dominant archetype had already selected.

### Fixed — a 100%-fabricated line looked better evidenced than a partly-measured one

`buildArchetypeLine` hardcoded curated variants to never carry a suffix, so Ornn Top's
`Bruiser (AD)` — the curated pool array verbatim, in declaration order, **zero measured items** —
sat directly above `On-hit (low data)`, which is equally fabricated and was labelled. A reader
reasonably concludes Bruiser is the better-supported of the two. The signal was inverted, and HARD
RULE 4 ("a curated/estimated value is always labeled as such — never presented as measured") was
already being violated: a bare title beside a "(low data)" one reads as measured by implication.

Flipping the flag would have lied in the other direction — curated is a judgment build, not a thin
measurement — so there are now three states, driven by the evidence rather than by `arch.curated`,
which no longer touches the label at all:

- **zero measured non-boots items** → `"<Archetype> (suggested)"`
- **some, but below the threshold** → `"<Archetype> (low data)"`
- **fills the line from the champ's own data** → plain title

`(suggested)` is not new vocabulary: `SupportItemCard` already renders "Suggested — … not measured"
for exactly this situation. The item-set lines simply never adopted it.

### Notes

- 8 of the 14 new tests fail against the previous module — verified by swapping the old file back in.
  They are regression pins, not restatements of current behaviour.
- **Surfaced, deliberately not fixed:** Leona Support resolves to the AD damage family, so she now
  ships `Bruiser (AD) (suggested)` and `Lethality/Assassin (suggested)`. That archetype SELECTION is
  unchanged v0.47.0 behaviour — it was simply hidden behind bare titles until now. The labels are
  honest; the selection for tank-supports is a separate open question, recorded in the audit file.

## [0.56.0] — 2026-07-25 — Audit wave 1: the same pro game rendered twice, and two hard rules broken in prod

A full-system cold-start audit (six read-only agents, findings in `AUDIT-2026-07-25.md`) ran against
this codebase. Every fix below was verified against LIVE production data or the real item catalog,
not fixtures — because in all three P0 cases the existing test suite was green and structurally
incapable of catching the bug.

### Fixed — P0: the live/Leaguepedia supersede rule had never fired, once, in production

A pro game ingested from the live lolesports feed is supposed to disappear once the richer
Leaguepedia row arrives. The rule matched on `sup.lolesports_game_id = pm.lolesports_game_id` — but
`runProstageIngest`'s INSERT never writes that column. Only the on-demand timeline route and a
backfill script do, so a freshly-ingested Leaguepedia row carries NULL, and `NULL = NULL` is never
true. **A supersede rule keyed on a field the superseding writer never writes is not a rule.**

Measured live before the fix: 9040 prostage rows, 7840 Leaguepedia rows with the column NULL,
**0 live rows ever superseded, 86 duplicate rows being served.** Caps' 07-24 LEC series rendered
twice on `/history` — and because live rows stored the MATCH start while Leaguepedia stores the real
per-game start, the two cards showed different times and didn't even look like duplicates.

Not merely cosmetic: `proConsensus` computes item share as `count / games.length`, so the itemless
duplicates **under-reported every Pro Consensus item percentage by ~27% for actively-played
champions**, double-counted the "From N pro games" denominator, and pushed real games off the
`limit`-capped list.

The key is now `(normalised player, champion, ±12h)` — all of which both writers populate
unconditionally. `split_part(player_link, ' (', 1)` is the SQL spelling of `cleanLeaguepediaName`:
Leaguepedia carries real-name disambiguators ("Zeka (Kim Geon-woo)") the live feed's stripped
summoner name never has. Migration `0015` indexes the expression the query actually uses.
**Verified in prod: 0 → 100 rows correctly superseded**, including the disambiguator case
(live `FIESTA` → `FIESTA (An Hyeon-seo)`).

Folded into the same fix, since they share the key: live rows now stamp the real per-game start
(`opened.gameStartTs`, not `ev.startTime`) — which makes `game_datetime` load-bearing rather than
cosmetic — and the write-path skip requires all **10** rows rather than any single row, so a game
left partial by an unresolved champion or a mid-loop throw can be completed by a later run instead
of being skipped forever while the run reports clean.

### Fixed — P0: starter items were reaching completed build lines (HARD RULE 1)

`isFullItem`'s only structural test was `into.length === 0`, documented as excluding "every
`STARTING_ITEM_ALLOWLIST` id". Against the real catalog that was false: **7 of those 9 ids have
`into: []`** and passed as genuine recipe-tree leaves. Only Dark Seal and Tear were ever caught
there. The class was actually held out by the allowlist — an ENUMERATION, which rotted: **Doran's
Bow (1086) and Doran's Helm (1120) were missing from it**, and both shipped inside completed 6-item
build lines in production (Ashe/Jinx/Caitlyn/Lucian/Ezreal Bot; Ornn/Darius/Malphite Top), with
`ProConsensusCard` rendering "Doran's Bow 43%" in its completed-items grid — precisely the display
the 2026-07-22 Dark Seal directive banned.

`isFullItem` now applies a STRUCTURAL lane-starter rule — bought from nothing, cheap, and carrying
the catalog's own `Lane` tag — so the class is caught without anyone maintaining a list. Verified
against the real 16.13.1 catalog: **0 starter leaks, 0 support-final regressions** (3869/3870/3871/
3876/3877 are also ~400g and Lane-tagged but are BUILT from World Atlas, so the `from.length === 0`
clause protects them), and it independently catches **five more Guardian's starters the allowlist
still doesn't list** (222051/223112/223177/223184/223185). 1086 and 1120 were added to the allowlist
too, as belt-and-braces.

### Fixed — P0: "Pro build" could ship with zero boots (HARD RULE 2)

`generalFallback` omits `corePrimary`, which is the only pool carrying `items.boots`. A champion
with no `alts.boots` and no `pro.boots` therefore left `findBestBoots` with nothing to find,
`buildLine` took its never-invent branch, and the line emitted **six full items and no boots at
all** — live on Yuumi Support, whose Pro build listed six 2500-3000g items and never told the user
to buy boots. Every other line for that champion carried them. `corePrimary` is now appended last to
the Pro line's fallbacks, so it supplies the missing boots without reordering what the pro data
ranked.

### Fixed — the "(low data)" honesty threshold had silently unlabelled itself

`MIN_CATEGORY_MEASURED` was a hardcoded 3, justified by a comment reading "CATEGORY_LINE_LEN is 4".
The line length went 4 → 6 in v0.48.0 and the constant didn't, so a line needing 5 real items
cleared the bar with 3 measured + 2 curated fill and shipped WITHOUT the suffix — Yuumi Support's
"AP Burst" presented Luden's Echo and Shadowflame, pure fill on an enchanter, as measured. Now
derived as `CATEGORY_LINE_LEN - 1` so a future length change can't unlabel them again. The test that
asserted the old behaviour was corrected rather than deleted, and gained a complementary case
pinning that a genuinely full line stays unlabelled.

### Fixed — Pro Consensus item percentages diluted by itemless rows

`gamesTotal = games.length` divided item/boots/starter shares by every game including live-ingested
rows that write `final_items = '[]'`. Rune slots already avoided this with their own denominators.
Items now divide by `itemsSampleSize` (games with non-empty `finalItems`), and the "From N pro
games" footer states its item coverage honestly when the two denominators diverge.

### Fixed — Builds hero stats ignored the elo tab

`ChampionHero` rendered the elo pills and received `rankBracket`, but its effect was keyed
`[champ.id, lane]` and `getHeroStats` took no bracket, so WIN%/GAMES/CONFIDENCE always described
High-Elo. Tap "Platinum" and the build panel changed while the line above it still read the
High-Elo numbers (329,099 games vs Platinum's 194,981) beside a visibly-active Platinum pill. The
confidence chip could read HIGH CONFIDENCE off the un-bracketed count while the build shown rested
on a MEDIUM-band sample. `/api/hero-stats` now accepts `rank`; the param is deliberately OPTIONAL so
`getMostPlayedLane`'s lane inference stays un-bracketed on the widest sample.

### Fixed — APPLY RUNES overwrote the bracket-correct page it had just written

`AutoExporter` appends `&rank=` so the export matches the Builds page; `ApplyRunesButton` never did,
and both produce the IDENTICAL page title, which the companion PUTs in place on an exact-title
match. Tapping APPLY RUNES therefore replaced the correct page with a High-Elo one and reported
"Applied in-client." `LivePanel` had the same omission (display-only). Both now read the stored
bracket.

### Fixed — the scheduled Leaguepedia ingest truncated at 500 rows

`fetchScoreboardRows` paginated only when `opts.paginate` was true, and the only caller passing it
was a deletable one-off seed script — the 3-hourly production path never did. `LPL/2026 Season/
Split 3` hits 500 rows at ~50 games, and since Leaguepedia backfills OUT OF ORDER, a late-entered
week-1 row sat below the cutoff forever. `rowsSeen` was exactly 500 and nothing checked for it: the
same "cap hit looks identical to nothing-new" signature v0.55.0 had just fixed one file over.
Pagination is now the default and an exact cap hit raises a loud error.

### Fixed — security and correctness of the companion surface

- **`/apply-runes` had no `CoachBuild` title guard.** This file's header and HARD RULE 5 both state
  the bright line, but STEP 2 matched only on exact page name with a caller-supplied title, so a
  request naming "Ranked Page 1" would PUT-overwrite the user's own page. It issues no DELETE —
  which is exactly why the adversarial SelfTest suite missed it, since every assertion guarding this
  invariant is DELETE-shaped. Added `Test-RunePayload` (the twin of `Test-ItemSetsPayload`) plus the
  first PUT-shaped SelfTest case.
- **`/api/pros/refresh` is now POST.** It mutates and spends the shared Riot key, whose cap suspends
  the key for every surface; as a GET, any `<img src>` on any page on the internet triggered a real
  spend for every visitor.
- **The service worker now honours `Cache-Control: no-store`.** It was writing `/api/mystats/*`
  responses — Riot ID, per-game KDA, champion pool — verbatim into CacheStorage on disk, and pinning
  deliberately-`no-store` degraded responses to replay them offline. Checked by header rather than
  URL prefix, so a future `no-store` route is covered automatically. The icon cache's un-awaited
  `cache.put` also no longer throws an unhandled rejection on quota exhaustion.
- **`companion.version` was frozen at 1.4.1 against a shipped 1.6.4**, which inverted the update
  prompt in both directions at once: everyone current got a permanent false "1.4.1 is available" nag,
  and users genuinely stuck on 1.4.1 matched it exactly and were never prompted. It is now GENERATED
  from `companion.ps1` by a `prebuild` step, so it cannot drift again.
- `getDdragonMaps` no longer memoizes a REJECTED promise — one ddragon blip on a warm lambda used to
  poison every later invocation on that instance, and in `runLiveProstageIngest` the call sits above
  the try, so it aborted the whole run.

### Docs

HARD RULE 5 gained its manual-mode carve-out (the DELETE on a real click is deliberate, documented
in `companion.ps1`, and SelfTest-pinned — it was the doc that was wrong, not the code). Corrected the
matches-cron cadence (every 2 days, not daily), the `/api/build` contract (`champ`, not `championId`),
and removed the false claim that TheShy has no 2026 pro games — he played IG vs WBG in the LPL that
day; Leaguepedia simply hadn't been written yet, which is the entire reason the live-ingest path
exists.

## [0.55.0] — 2026-07-25 — Builds never opens on a champion you didn't pick

### Added — the first-run pick state
`ChampionPickPrompt` replaces the hero + build panels when nothing has been chosen yet (fresh
install, cleared storage). v0.54.1 only restored your LAST champion, so a brand-new install still
landed on Viktor once — this closes that.

`champ` stays non-null throughout, so no downstream component learns a nullable contract; a
separate `champChosen` flag drives the prompt.

**Deliberately does not suggest champions.** "Popular picks" here would be Viktor with extra
steps — still the app choosing. Favourite-champion shortcuts were built and then **removed**:
`lib/favorites.ts` stores only `{id, name}` while `ChampionRef` needs the ddragon `key`, and
inventing one risks a wrong build fetch. Wiring those from the champion list the app already
loads is a clean follow-up, not something to fake.

### Fixed — a bug in my own first attempt at this
`restoreMainView` marked the champion as "chosen" unconditionally. `useSheetBackNav` seeds its
initial selection from current state on mount and applies it straight back through that function —
with the Viktor seed still in `champ` — so the prompt never rendered. **Caught in the browser, not
by reading the code**: a fresh profile still showed VIKTOR while every unit check passed. Now only
a non-seed champion counts as a real selection.

### Bug sweep (data integrity, all 9,040 prostage rows)
- `runes` object / `spells` array / `final_items` array — **100% correct types**, no survivors of
  the 0.54.0 array bug.
- Live-ingested rows: **zero** null champions, negative KDA, future timestamps, empty player links
  or null roles.
- **Zero** duplicate `(lolesports_game_id, player_link)` pairs — the live/Leaguepedia supersede
  rule holds, nothing double-renders.
- Every live game has **exactly 2 teams and a 5/5 win split** — the inverted-team bug from 0.54.0
  cannot recur unnoticed.

### Fixed — two silent failure modes found by that sweep
- **`runLiveProstageIngest` truncated silently at `maxGames`.** Hitting the cap looked identical
  to "nothing new to fetch" — the exact ambiguity that let the Leaguepedia cron rot unnoticed for
  weeks. It now reports an explicit error saying games remain.
- **`/api/pros/refresh` accepted any `proId` string.** It is unauthenticated and spends Riot API
  budget, so a malformed id now costs one regex instead of a DB query and a Riot call. (Abuse is
  otherwise bounded by the per-pro cooldown and `MAX_ACCOUNTS`; a public deployment would want a
  real rate limit.)

## [0.54.1] — 2026-07-25 — fix the /history crash my own live ingest shipped

**User report:** "I also see this error when searching for TheShy" — the whole page replaced by
*"Application error: a client-side exception has occurred."*

### Root cause — my bug, introduced hours earlier in 0.54.0
`prostage_matches.runes` is an **object** (`ProGameRunes`: primaryTree/keystone/primary[]/
secondaryTree/secondary[]/shards[]). The new live ingest wrote `'[]'::jsonb` — an **array** — for
games with no rune data. `GameDetailSheet` then read `game.runes.primary.length` on a value with
no `primary` key, threw `Cannot read properties of undefined (reading 'length')`, and took the
**entire /history route** down with it.

Diagnosed by reproducing against the local dev server, where React reports a real component name
(production's minified frame was just `at ei (...)`). The prod payload shapes were byte-identical
between a live-sourced and a Leaguepedia-sourced game, so inspecting JSON alone would never have
found it.

### Fixed
- **Live ingest writes the correct empty rune OBJECT** (`EMPTY_RUNES`), carrying every key the
  renderer reads.
- **280 already-written rows repaired** in place (`jsonb_typeof(runes) = 'array'` → the empty
  object). Zero array-typed rune rows remain across all 9,040 prostage rows.
- **`GameDetailSheet` no longer trusts the shape.** It normalises `runes` defensively before use,
  so a malformed field degrades to "no runes recorded" instead of white-screening a whole route.
  The data bug is fixed at the source; this is the second line of defence that should have existed.

### Also — Builds no longer opens on Viktor
Per user directive. `app/page.tsx` seeded its champion state with
`STATIC_FALLBACK_LANE_CHAMPIONS.mid` (Viktor) purely so first paint matched the original design
mockup, so **every** session landed on a champion nobody picked. It now restores the champion and
lane **you** last viewed (`lib/lastChampion.ts`, localStorage, shape-validated and failure-safe).
That is not the app deciding — it is your own most recent choice, which between games is the best
available predictor.

## [0.54.0] — 2026-07-25 — pro play ingests from the LIVE lolesports feed

**User report:** "TheShy does have pro games played today with IG in LPL, I can see it in Matchday."
He was right, and my previous conclusion (0.53.0, "TheShy has no 2026 pro games") was **wrong** —
it described Leaguepedia's table, not reality.

### Root cause — a single lagging source
Leaguepedia's `ScoreboardPlayers` is **editor-populated and lags days-to-weeks**. `LPL/2026
Season/Split 3` started 07-22 and still had **zero** rows on 07-25. Matchday showed the games
because it reads the live **lolesports** feed; CoachBuild's pro-play ingest read only Leaguepedia.
No ingest cadence can fix that — **absence in one source is not evidence a game wasn't played.**

### Added — `lib/prostage/liveIngest.ts`
Ingests completed games straight from lolesports (schedule → `getEventDetails` → livestats
window), for the same tier-1 + targeted tier-2 league set as the Cargo path. Deliberately shallow:
champion, role, KDA, result, team, date. **No items/runes** — those need the per-10s `details`
walk, and Leaguepedia backfills them anyway.

**Reconciliation:** live rows use a `lolesports:<gameId>` game_id and always set
`lolesports_game_id`. The ingest skips any game Leaguepedia already holds, and the read path
(`/api/pros`, all three player/champion queries) hides a live row once a Leaguepedia row exists
for the same `lolesports_game_id` + player. The richer row wins automatically; neither source
double-renders.

Verified live — **TheShy, IG, 2026-07-25: Ambessa (loss), Olaf (win), Yorick (win)**, matching
IG's 2-1 series win over WBG. 28 games / 280 rows ingested across LEC, LPL and CD.

### Three real bugs found by running it, not by reading it
- **Unaligned `startingTime` → every game skipped.** `fetchLatestFrameTs` returns a
  millisecond-precision frame timestamp; the window feed requires **10-second alignment** (that is
  what `timeline.ts`'s `iso10s` is for). Passing it through verbatim returned an empty body, which
  the winner vote correctly read as undecidable — so the first run ingested *nothing* and said so.
- **Team/side mapping was INVERTED.** Deriving team from `game.teams[].side` → team id does not
  line up with the livestats blue/red arrays: every IG player was written as team `WBG` and vice
  versa. Because the code was wrong the prefix never stripped, so `IGTheShy` was never findable as
  `TheShy`. Team is now derived from the summoner-name prefix itself, which is self-consistent.
  (`win` was never affected — it comes from the blue/red arrays, not this mapping.)
- **`MonkeyKing` was unresolvable.** lolesports reports champions by Riot's **internal** key while
  the ddragon map was keyed on display name (`Wukong`). `buildDdragonMaps` now indexes both;
  display name is set first and never overwritten, so canonical mapping still wins.

The 279 rows written before the team fix were deleted and re-ingested.

### Scheduling
`CoachBuildProstageIngest` (every 3h) now runs the live feed **first**, then Leaguepedia.

## [0.53.0] — 2026-07-25 — pro data is refreshed on demand; solo-queue sweep moved off Vercel

**User reports:** "TheShy's games aren't showing" and "Bwipo's soloQ isn't up to date."
Both were the same root cause, and it was not specific to either player.

### Root cause — the background sweep could never reach most pros
Measured live against production:

| | |
|---|---|
| `pro_accounts` rows | **2801** |
| never fetched | **2440** (87%) |
| fetched in the last 2 days | **1** |

`runMatchIngest` walks `batch = 5` accounts per invocation and returns a cursor for an external
pinger to drain — but nothing pings it, and the Vercel Hobby cron fires once every 2 days.
**5 accounts / 2 days against 2801 accounts is a ~3-year full cycle.** Bwipo's accounts were last
fetched 2026-07-11 (14 days stale); most pros had never been fetched at all. Nothing was broken
in the sense of throwing an error — the throughput was simply orders of magnitude short.

### Fixed — freshness is now pulled to the moment of interest
- **New `GET /api/pros/refresh?proId=…`** ingests solo queue for ONE pro on demand. Unlike
  Leaguepedia (Cloudflare-blocked from Vercel — see 0.52.0), Riot's API is reachable from
  Vercel, so this runs serverless. Bounded and polite: active accounts only, 4 accounts max,
  10 matches each, and a 10-minute per-pro cooldown so re-opening a player doesn't re-hit Riot.
  A per-account failure (e.g. Riot 429) is caught and reported without sinking the others.
- **`ProHistoryResults` calls it when a player is opened**, without blocking the render: the list
  paints from what we already hold, and only re-fetches if the refresh actually inserted games.
  Verified live: Bwipo refreshed 2 accounts → **10 new games**, newest 2026-07-25 03:42.
- **Solo-queue sweep moved to a local Scheduled Task** — `CoachBuildMatchIngest`, every 6 hours
  (`scripts/ingest-matches-scheduled.ps1`). The Vercel path is throughput-bound by a 60s budget
  and a daily cron; locally the script drains its own cursor to completion. This builds broad
  coverage for pros nobody has opened recently.

### Honest empty states
`/api/pros/refresh` distinguishes **`no_active_accounts`** (every mapped account retired by the
roster audit — TheShy's single account is `active = false`) from **`no_accounts`** (never mapped)
and from a normal empty refresh. Separately confirmed via Leaguepedia that **TheShy has no 2026
pro games at all** — his most recent are 2025 Worlds Play-In and LPL 2025 Regional Finals, and
Invictus Gaming's 2026 top laner is Breathe. His empty state was therefore *correct*, just
unexplained.

### CORRECTION (same day, see 0.54.0 plan)
The claim below that TheShy has no 2026 games was WRONG — it described Leaguepedia's table, not
reality. He played IG vs WBG in LPL on 2026-07-25 (Ambessa). Leaguepedia is editor-populated and
lags; absence there is not evidence a player did not play.

### Also confirmed, not a bug
`LPL/2026 Season/Split 3` (started 07-22) still has **zero** ScoreboardPlayers rows upstream on
Leaguepedia. Our ingest is resolving and attempting it correctly; the wiki simply has no data
entered yet.

## [0.52.0] — 2026-07-25 — pro-play ingest: gotcha (o) diagnosed and made loud

**User report:** Caps's recent games were missing from Pro Players — his newest showed as EWC,
9 days old. Ground truth (Leaguepedia, via curl): Caps had 5 `LEC/2026 Season/Summer Season`
games, three on 07-24 and **two on 07-25 itself**.

### Root cause — the long-standing gotcha (o), finally triaged
`resolveActiveTournaments` returns `[]` on **either** a Cargo failure **or** a legitimate
zero-row result. `runProstageIngest` then found `cursor 0` out of range on an empty list and
returned `{tournament: null, rowsSeen: 0, errors: [], errorCount: 0}` — **a clean HTTP 200,
indistinguishable from a healthy no-op run.** Verified live against production on 07-25: the
endpoint returned exactly that. The cron had been "succeeding" while ingesting nothing.

Nothing was wrong with the tournament *names*: `LEC/2026 Season/Summer Season` is exactly what
the resolver produces and exactly what Leaguepedia uses. The last successful pass (07-22, a
manual script run) legitimately found 0 rows for it — **LEC Summer did not start until 07-24.**
Every pass since then was the silent-empty failure.

### Fixed
- **An empty tournament list is now an ERROR, not a clean run.** `runProstageIngest` pushes an
  explicit error and the route reports `errorCount ≥ 1`, so this failure mode can never again be
  invisible in the response or the Vercel function logs.
- **`PROSTAGE_TOURNAMENT_SEED` is now a FALLBACK, not an override.** It used to short-circuit
  ahead of live resolution, which meant setting it once to work around an outage would **pin the
  tournament list forever** — the app would silently stop following new splits (LEC Summer
  starting, Summer Playoffs in September, next season) with no failure of any kind. Live
  resolution is tried first; the seed catches only the failure case, and a seeded result is
  deliberately **not cached** so the next call retries live.

### Tests
`prostage-ingest.test.ts` gains a regression guard asserting zero-tournaments produces a
non-empty `errors` array. `prostage-tournaments.test.ts`'s seed test is inverted to the new
contract (seed ignored while live resolution works) plus three new cases: fallback on throw,
fallback on zero rows, and no-caching of a seeded fallback.

### The bigger finding — Vercel cannot reach Leaguepedia at all
With the silent failure made loud, both transports were probed against production for the first
time:

| transport | result from Vercel |
|---|---|
| `api.php` (`action=cargoquery`) | `"You've exceeded your rate limit"` on the **first call of a run** — shared datacenter IP pool |
| `Special:CargoExport` | **HTTP 403** — Cloudflare bot challenge (TLS/JA3 fingerprint block) |

The repo had *assumed* CargoExport would be blocked from Vercel but never tested it; it is. So
`/api/ingest/prostage` **physically cannot ingest pro-play data from Vercel**, by either path.
No amount of scheduling or seeding fixes that.

### Therefore: pro-play ingest now runs locally on a schedule
`scripts/ingest-prostage-scheduled.ps1` + Windows Scheduled Task **`CoachBuildProstageIngest`**,
every 3 hours — the same pattern (and for the same reason) as the existing
`CoachBuildDraftIngest`, whose u.gg ingest is Cloudflare-blocked from Vercel too. This machine is
not blocked. Verified end-to-end through Task Scheduler's own environment, which needs the real
Node.js pinned ahead of the corporate `node64` shadow in PATH or `tsx` resolves to the wrong
runtime.

The route keeps `useExport: true` — it will not succeed from Vercel today, but it now fails
*loudly*, and CargoExport is the better transport if that block ever lifts.

### Data
A manual `--via-export` ingest landed the missing games immediately: 120 rows upserted, Caps
current through 2026-07-25 15:40 (Ahri). Verified through the production API: `/api/pros` now
returns his five LEC Summer games ahead of the stale EWC one.

## [0.51.4] — 2026-07-25 (COMPANION CHANGE → 1.6.4 — re-install required)
### Fixed — companion opened a fresh pair of tabs every game (user-reported, screenshot: 4 stacked tabs)
- **Root cause (measured, not inferred):** `Test-CompanionHasAttachedTab` treated a tab as attached only if it had polled `/status?...&follow=builds|draft` within **8 seconds**. That window was justified against the web poll's 3s cadence — but that cadence only holds for a *foreground* tab, and this feature is used precisely while the tab sits behind a fullscreen game. Chrome applies **intensive throttling** to a hidden tab after 5 minutes, collapsing its timers to roughly **one tick per minute**. A 60s cadence can never satisfy an 8s window, so every champ-select concluded "no tab attached" and `Start-Process`'d both pages again — piling up across games.
- **Measurement:** instrumented probe (`.smoke-tools/cb-throttle-probe2.mjs`), real Chrome, no automation attached. Hidden+occluded tab held 20 ticks/min for the first 5 minutes, then dropped to **1 tick/min** from t+360s onward while a visible control tab held 20. Three earlier probe attempts were invalid and thrown away: puppeteer's default args disable background throttling, an attached CDP session suppresses it independently, and a background tab in a *visible* window is a weaker condition than the real in-game state.
- **Fix 1 — attach window 8s → 150s** (`$script:AttachWindowSeconds`): clears a 60s throttled cadence with room for jitter.
- **Fix 2 — open→attach race** (`$script:OpenGraceSeconds`, 25s): a freshly opened tab needs seconds to cold-start before it can send its first follow poll. Nothing recorded that it had just been opened, so a champion change inside that gap re-opened *another* pair — a single champ-select could stack 4 tabs on its own. A just-opened kind now counts as attached until it has had a fair chance to answer; if it never does, the grace lapses and the next champion change retries.
- **Deliberate behaviour change:** swapping champion seconds after the Builds tab opens no longer opens a second tab — the cold-starting tab live-follows to the new champion by itself (`app/page.tsx`'s follow effect off `companion.tick`). The mock case that asserted 2 opens here now asserts 1, with the debounce contract still covered separately after an explicit grace lapse.
- Ruled out with evidence before landing on the above: stale cached web bundle (pulled all 12 production chunks — `&follow=${kind}` and the `/draft`→`"draft"` mapping are deployed), session-token rotation (`Get-OrCreateSessionToken` is file-backed and idempotent), bridge port change (`refreshStatus` falls back to a 3-port walk), and cross-runspace state loss (`Start-BridgeServer` shares a `[hashtable]::Synchronized` by reference — the mock tests fake `$script:Bridge` in-process and so structurally could not have caught that one, which is why it was checked directly).
- Tests: 4 new companion mock cases (throttled-tab 60s stamp counts as attached; open→attach race suppresses the double-open; grace lapse retries; genuinely-stale 300s stamps resume opening). `-Mock` and `-SelfTest` both green.
- **Re-run the install one-liner on the gaming PC to pick up 1.6.4** (or just restart the companion — autostart re-fetches it):
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://coachbuild.vercel.app/companion.ps1 | iex"`

## [0.51.3] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Fixed — build lines respect the 6-slot game reality (HARD USER RULE)
- Galio MID core order rendered 6 full items + boots (7 tiles — impossible in game). Root cause: `lib/recommend.ts` sliced `fourthPlus` from ordered legendaries with no lane awareness. New single choke point `lib/buildSlotCap.ts`: **5 full items + boots for all lanes; bot lane may show 6 full + boots** (late-game boots-sell exception, user directive — see memory feedback_build_lines_six_item_cap). Drops the lowest-value surplus, never reorders, never fabricates. Wired at both assembly points (core-order `fourthPlusBests`, optimized-order chain); render components inherit untouched. LCU item-set export verified already hard-capped at 6 (a set is a real loadout — no bot exception there, by design). Frequency lists (pro consensus) and situational menus exempt (menus, not builds). 12 new tests incl. the exact Galio fixture + bot-lane exception; 1524 total.

## [0.51.2] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Removed — Pro Players "Recent competitive games" section (user directive)
- `/history` drops the recent-competitive-games table added in 0.51.0; player/champion search is the page's primary view again. Deleted `ProPlayersTable.tsx`, `app/api/pros/recent/route.ts`, `lib/pros/recentModel.ts` + both test files (zero other consumers, grep-verified). Leaguepedia attribution remains in the page footer. 1512 tests. Gotcha: `verify-fix` tsc failed on a stale `.next/types` stub for the deleted route — cleared `.next/types/app/api/pros` and re-ran green (deleting an API route needs that sweep before the tsc gate).

## [0.51.1] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Fixed — three user-reported issues from the v0.51.0 ship
- **My Stats match history invisible (P1):** `normalizeMyStatsSummary` (`components/hextech/myStats.ts`) rebuilt the summary with only the 4 legacy fields, silently dropping `recentGames`/`buildAdherencePct`/`winrateOnBuild`/`winrateOffBuild`/`priorSplitWinrate` that the API was already returning — the page's `?? []`/`?? null` fallbacks then rendered permanent empty states. Normalizer now passes all five through with per-entry validation (malformed rows dropped, never taint the list); test fixture built from the real prod payload. Cross-agent seam lesson: fronty typed the page against the extended API, engo extended the API — nobody owned the normalizer between them, and the audit verified both ends but not the seam.
- **KDA backfill (one-time script, `scripts/backfill-mystats-kda.mjs`):** pre-0.51.0 `my_matches` rows had null KDA/items/keystone (columns born in migration 0014). Backfilled 110/110 rows from Riot match-v5 via the stored `match_id` PKs — sequential on the existing pacer, resumable (`WHERE kills IS NULL`), 0 failures. `on_wpa_build` computed only where the match patch matches the live recommend pipeline (21 rows); others honestly null → no chip. (User suggested op.gg — declined: no public API, and the match ids + Riot access were already in hand.)
- **Pro Consensus icon sizes:** `BootsStackTile`/`StartersStackTile` rendered 20px icons vs `ItemTile`'s 44px. Normalized to 44×44 (verified via `getBoundingClientRect` on all partition tiles); starter-slot partition semantics unchanged (hard directive).
- **"Update ready" toast reappearing:** update DETECTION was correct (a genuine update was pending) — the bug was dismiss persistence: a per-tab `sessionStorage` boolean, so every new tab/PWA relaunch resurfaced the toast. Now `localStorage` keyed to the waiting worker's `scriptURL` (`components/swUpdateDismiss.ts` + tests): dismissal survives relaunches, a genuinely new version still toasts once. First-install and same-version reloads verified toast-free; Refresh flow intact.
- Gates: verify-fix all green, 1526 tests (+11), tsc/eslint clean.

## [0.51.0] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Changed — Full 6-surface UI redesign to the user's WPA-Intelligence mockups (2 waves, 4 agents, audited)
- **Global top bar (new, every route):** `GlobalNav/TopBar.tsx` — champion search (moves out of the Builds page body; dispatches via new `championSearchBus.ts`), live champ-select chip (`ChampSelectChip.tsx` + pure `champSelectChipModel.ts`, resolves champion name asynchronously, "CHAMP SELECT — PICKING" until resolved), and gold APPLY RUNES button (`ApplyRunesButton.tsx` — reuses `applyRunes` + `buildRuneApplyBody` verbatim; LCU apply path and follow-suppression untouched, audit-verified empty diff). `DesktopRail` gains a gold PICK badge on Builds during champ select (`navBadgeModel.ts`).
- **Builds (`/`):** unified single view — BUILD/PRO BUILDS tab strip and PROS search mode removed (pro browsing lives on `/history`); lane tabs (TOP/JG/MID/BOT/SUP) + elo tabs (High Elo/Diamond/Emerald/Platinum) moved into `ChampionHero` (elo was already in the data layer via `rankBracketStorage`, now surfaced); HIGH/MEDIUM/LOW CONFIDENCE chip (`confidence.ts`, games-count banding). Deep-link mount, `companion.tick` live-follow, `getMostPlayedLane` guard, `sheetNav` — all preserved (audit line-diffed vs e322c75: identical).
- **Draft (`/draft`):** cyan `.draft-tactical` HUD retired → shared navy/gold theme; radar replaced by ENEMY COMP PROFILE horizontal bars 0-100 (`DraftCompBars.tsx`, `scaleTo100` over the existing 173-champion curated ratings) + up to 3 tactical takeaway chips (`lib/draft/compTakeaways.ts`, editorial thresholds); 2-col layout with ban suggestions inline in `MyChampionPanel`; picks table gains GAMES column. State machine/effects byte-identical (audit-verified). Honest fallback: "High ban priority" instead of the mockup's unbacked "denies your sustain".
- **Companion (`/live-setup`):** status hero card with 4-step Client→Lobby→Champ Select→In Game progress rail (`companion/StatusHeroCard.tsx`), restyled one-line install commands, real `role="switch"` automation toggles + privacy footnote (`AutomationToggles.tsx`); connection-test/LNA/error-log machinery kept below the fold.
- **My Stats (`/mystats`):** 4 stat tiles (GAMES / WIN RATE + vs-last-split delta / MAIN / BUILD ADHERENCE), recent-games list with per-game KDA + WPA-build/off-build chips, champion-pool card + on-build insight line. **Migration 0014** (`kills/deaths/assists/item_ids/primary_keystone/on_wpa_build/split` on `my_matches`; split backfilled from timestamps, other fields honestly null until re-ingest). Adherence computed at ingest via `lib/mystats/adherence.ts` (keystone match + ≥2 core items; display-only, never feeds scores). **Behavior change:** records/pool now scoped to the CURRENT split (split boundaries web-verified vs Riot's 2026 schedule) — pre-April-29 games drop out of the visible counts, prior split retained for the delta.
- **Patch Movers (`/movers`):** semantic rewrite — per-keystone/item WPA swings → per-champion WIN-RATE shifts (`lib/patchMovers.ts`: union pool across lanes, |Δpp| sort, min-games floor), single table, no lane pills, curated patch-note one-liners (`lib/patchNotes/` — web-verified 16.13 entries only, absent → "—", never fabricated).
- **Pro Players (`/history`):** new default recent-competitive-games table (`ProPlayersTable.tsx` ← new `GET /api/pros/recent`, keyboard-operable rows → `GameDetailSheet`), Leaguepedia CC BY-SA attribution; existing player/champion search kept below.
- **Caching discipline:** new/rewritten routes `no-store` on empty, `s-maxage` only non-empty (audit-verified); mystats stays unconditionally `no-store`.
- **Deleted (D1 + orphan sweep):** `BuildsSearchBar`, `ProsSearchPrompt`, `DraftCompRadar` + `draftRadarGeom`, `DraftBansTable`, `ProBuildsTab`, `PlayerHero`, `PlayerGamesSection`, `ProBuildRow`, `SidebarChampionSearch`, `LaneFilterPills`, `patchMoversFormat` (+ dead player-mode branch pruned from `homeSearch.ts`).
- **Fixed en route:** `vitest.config.ts` include-glob missed nested `__tests__` dirs — 3 GlobalNav test files (52 tests) were silently excluded from every prior run.
- Gates: `verify-fix.sh` all green (tsc/lint/1515 tests/build/SW/manifest); cold-start adversarial audit FIX-THEN-SHIP → both P3s fixed, P1 (migration-before-deploy) executed; puppeteer smoke: `/mystats` post-migration, `/movers` value formats, `/history` keyboard row→sheet, Swain deep-link (numeric role contract), mobile 390px no-overflow.

## [0.50.0] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Added — Global navigation redesign: branded left rail (desktop) + bottom tab bar (mobile)
- Replaces the fragmented nav (per-page `TabNav` top strip + the Builds-only hextech `Sidebar` + `MobileNavMenu`'s "More" disclosure) with ONE global shell, per the user's mockup.
- **Desktop (`≥lg`):** new `DesktopRail` (`components/hextech/GlobalNav/DesktopRail.tsx`) — CB logo tile + "Coachbuild / WPA Intelligence" wordmark, **PLAY** group (Builds, Draft, Companion) and **DATA** group (Pro Players, Patch Movers, My Stats), a live companion status card, and a `PATCH n · vX.Y.Z` footer.
- **Mobile (`<lg`):** new `MobileTabBar` (fixed bottom, `grid grid-cols-4`) — **exactly 4** destinations (Builds, Pro Players, Patch Movers, My Stats), per the user's explicit directive: no Companion, no Draft, no companion card on mobile ("desktop-play-only").
- Both driven by one shared pure data source, `components/hextech/GlobalNav/navItems.ts` (`NAV_ITEMS`, 6 items; `MOBILE_NAV_ITEMS` derived via a `mobile: boolean` flag, not hand-duplicated) and `activeNav.ts` (`isActiveNav` — exact match for `/`, prefix match otherwise).
- **Companion status card is honest, not decorative** (`companionStatusModel`, `components/hextech/GlobalNav/companionStatusModel.ts`) — reads real `useCompanion()` fields only, 5 states (unpaired/grey → paired-no-client/gold → client-detected/green → champ-select/green → in-game/green), unpaired card links to `/live-setup`. IMPROVEMENT over the mockup (which shows the card always-green) — never fabricates a live state.
- New `AppShell.tsx` wraps every route inside `CompanionProvider` (`app/layout.tsx`) so the rail's companion card shares the same app-wide poll every other live-aware surface already uses. Best-effort `GET /api/patch` (new route, `app/api/patch/route.ts`, `s-maxage=3600`) feeds the rail's patch footer — a fetch failure degrades to "PATCH —", never a crash.
- **Builds page (`/`):** the old dual `<Sidebar>` render (collapsed mobile top-bar + full desktop column) is replaced by one `BuildsSearchBar` (`components/hextech/BuildsSearchBar.tsx`) at the top of the page content, above the champion/player view — same CHAMPIONS/PROS search + lane row, wired to the exact same handlers (`handleChampionSelect`/`handleLaneChange`/`handlePlayerSelect`/`setSearchMode`) the two Sidebar renders used. Every other effect/handler in `app/page.tsx` (deep-link mount, companion.tick live-follow, `getMostPlayedLane` + its request-id guard, `sheetNav`/`useSheetBackNav`, `tabRef`/`gamesSourceRef`, `restoreMainView`) is untouched — only the returned JSX changed (the two `<Sidebar>` renders + their `lg:flex` wrapper + `<main>` are gone, since `AppShell` now owns that shell).
- `/draft`, `/history`, `/movers`, `/mystats` each drop their `<TabNav />` import + render — global nav now covers them.
- **`.dt-circuit-bg` (`/draft`'s cyan HUD backdrop) switched `position: fixed` → `absolute`.** The old `fixed` value painted relative to the *viewport*, bleeding the cyan circuit background under the new gold `DesktopRail` (a fixed element's paint position ignores DOM ancestry). `absolute` resolves against `.draft-tactical`'s own box (already `position: relative`), confining the cyan bg to the draft content column only — verified no bleed onto the rail at 1280/1440, and the bg still fills the full draft content height (not 0-height).
- **Deleted:** `components/TabNav.tsx`, `components/hextech/Sidebar.tsx`, `components/hextech/MobileNavMenu.tsx`, `components/hextech/navLinks.ts`, `components/__tests__/navLinks.test.ts` (replaced by `navItems.ts` + its own test file).
- **Also landed:** wired `MyStatsRefresher` (added standalone in 0.49.3, deliberately unmounted pending this nav ship — see HANDOFF-engy.md's 2026-07-24 entry) into `app/mystats/page.tsx`, next to the riotId/season line. `onRefreshed` bumps a new `refetchKey` state var that the page's existing summary-fetch effect now depends on, re-running it (same stale-response `cancelled`-guard as before) when the on-demand incremental ingest finds new games.
- **Plan deviation (Windows-only, flagged loud):** the plan named the pure companion-status module `companionStatusCard.ts`, but Windows' case-insensitive filesystem collides that with the sibling `CompanionStatusCard.tsx` component (`tsc` TS1149, caught by `verify-fix.sh`). Renamed to `companionStatusModel.ts` (matches the exported function name) — see that file's own header comment.
- New tests: `navItems.test.ts` (10), `activeNav.test.ts` (4), `companionStatusModel.test.ts` (8) — 22 added, 5 removed with `navLinks.test.ts`, net +17. All pure `.ts`, no JSX rendering harness (repo convention). `npx vitest run`: **1454 passed**. `verify-fix.sh`: `tsc -b` clean, lint clean, build clean, SW cache-name/version tie intact (icon-cache exclusion preserved), manifest present.

## [0.49.3] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Added — My Stats on-demand incremental refresh (backend + standalone component; page-wiring lands post-nav)
- Follow-up to 0.49.2's flagged item: "current on demand" instead of waiting for the daily cron. New `POST /api/mystats/refresh` (`app/api/mystats/refresh/route.ts`) runs `runMyStatsIngest({mode:"incremental"})` on demand, gated by a server-side cooldown (`REFRESH_COOLDOWN_MS` = 3 min, `lib/mystats/refresh.ts`) so it's safe to call on every My Stats page view without risking the shared Riot key budget (CLAUDE.md gotcha (d)) — worst case is one incremental run per cooldown window regardless of call volume. No auth (unlike the cron's `CRON_SECRET` gate) — that's the point, it's meant to be hit by every page view.
- New column `coachbuild.my_ingest_cursor.last_incremental_at` (migration `0013_mystats_refresh_cooldown.sql`, applied to prod) tracks the cooldown clock server-side (not trustable to the client).
- Response shapes: `{accountUnresolved:true}` (guard, does nothing — no Riot call); `{refreshed:false, skipped:true, reason:"cooldown"}`; `{refreshed:true, skipped:false, newGames, latest}`; `{refreshed:false, skipped:false, error:true}` (fail-soft — never a 500, page keeps showing cached data).
- New standalone client component `components/hextech/MyStatsRefresher.tsx` (`"use client"`, POST-on-mount with a StrictMode-safe fire-once guard, small "Updating…" pill, calls `onRefreshed()` only when `newGames>0`) — NOT wired into `app/mystats/page.tsx` yet (a concurrent global-nav redesign owns that file this session); see HANDOFF-engy.md for the exact one-line mount instruction once nav lands.
- 14 new tests (`lib/__tests__/mystats-refresh.test.ts`, `lib/__tests__/mystats-routes.test.ts`) — cooldown decision logic + all 4 route response branches. 1459 tests total.

## [0.49.2] — 2026-07-24 (companion unchanged at 1.6.3)
### Changed — My Stats ingest cron back to daily (was every-other-day)
- My Stats was showing stale data (missing games played that day). Cause: the v0.48-era Vercel Active-CPU trim spaced the `/api/ingest/mystats` cron to every-other-day — too infrequent for personal stats the user actively checks (and one personal-account incremental fetch is a trivial CPU cost anyway). Restored to daily (`0 20 * * *`) — the Vercel free plan caps cron frequency at once/day, so daily is the max. (Today's games were also manually ingested via the incremental path — the manual `ingest-mystats.mjs` script only runs the backfill/history walk, not the newest-first incremental fetch, so a stale-mystats refresh needs the incremental run.) Proper "current on demand" fix = a My Stats page refresh that triggers the incremental ingest — flagged as a follow-up.

## [0.49.1] — 2026-07-22 (WEB-ONLY — no companion change, no re-install)
### Fixed — Pro game Teams box: duplicate "Jg" + wrong lane order
- **User report** (viewing Swain's pro games): "jg is twice and lane order is wrong" in a pro game's Teams section.
- **Root cause, live-confirmed against the prod DB:** a DATA/query-precedence bug, not a display bug. `buildProstageCompsMap` (`lib/prostage/teamComps.ts`) and `prostageRowToProGame` (`app/api/pros/route.ts`) resolved a roster row's role as `pro_role ?? role` — preferring `coachbuild.pros.role` (a tracked pro's generic, roster-level position, sourced from lolpros.gg and overwritten wholesale on every daily roster ingest) OVER `role` (that specific game's own Cargo Role column), even when the per-game role had already resolved correctly. Confirmed live: Viper (ADC) is tagged `role=1`/jungle in `coachbuild.pros` (stale/wrong upstream roster attribute) while his per-game Cargo role correctly reads `role=3`/bot for e.g. `2026 Mid-Season Invitational_Finals_1_4`. Under the old precedence this collided with his own team's real jungler (also role 1 for that game) — the side no longer resolved to 5 distinct roles, so `orderByRole`'s documented safety degrade kicked in and the whole side fell back to source order: exactly "jungle shown twice, lane order wrong." 170 prostage rows in prod currently have a `pm.role` that disagrees with their tracked pro's `pros.role`.
- **Fix:** flipped the precedence to `role ?? pro_role` in both places — THIS game's own Cargo role now wins; the roster-level `pro_role` only fills in when the per-game role is unresolved (Leaguepedia's free-text Role column didn't parse). Single fix point for `lib/prostage/teamComps.ts` covers both consumers (the champion-id-only strip on the list route and the full per-player sheet on `/api/pros/team-players`) by design (both already share `buildProstageCompsMap`/`orderedSidesForGame`).
- Not fixed (out of scope, no bug report there): `rowToProGame`'s SOLOQ `player.role` field (`app/api/pros/route.ts`) has the same `pro_role ?? role`-shaped precedence for a cosmetic role badge — soloq's own per-game role always comes from real Riot API data (`teamPosition`), not a lolpros-sourced roster attribute, and doesn't feed any ordering, so left as-is.
- No backfill needed — this was a read-time query fix, not stored data; the underlying `coachbuild.pros.role` staleness (an upstream lolpros.gg tagging/roster-transfer-lag issue) is a separate, lower-priority data-quality item, now harmless for the Teams display since the per-game role wins regardless.
- 4 new unit tests (`lib/__tests__/prostage-teamComps.test.ts`) including a direct reproduction of the Bilibili Gaming roster from the confirmed prod game. 1445 tests total.
- Web-only — no companion change, no user re-install.

## [0.49.0] — 2026-07-22 (WEB-ONLY — no companion change, no re-install)
### Added — Support Item Upgrade card (Build page, support role only)
- **User request:** "for supp also show which supp item to upgrade to." Support role (Bot page role 4) now shows a dedicated "Support Item Upgrade" card indicating which of the 5 quest-final support items (Bloodsong / Celestial Opposition / Dream Maker / Solstice Sleigh / Zaz'Zak's Realmspike) to build off the World Atlas → Runic Compass → Bounty of Worlds chain.
- **Investigated first (live probe, not assumption):** confirmed the support-item final is NEVER present in `/api/build`'s response, across Senna/Nami/Yuumi/Leona/Braum/Thresh support builds — `items.starter` is always World Atlas, but none of first/second/third/fourthPlus/alts ever carries a support-item id; champs are recommended a completely separate pool of standalone enchanter/tank legendaries instead. This is an upstream coachless data gap, not a filter this app applies (no isFullItem/isBuildItem-style filtering runs on the Build page at all).
- **Upgrade tree re-verified live** against the coachless CDN mirror's item.json (16.13.1), not the brief's own description — the real chain has an extra tier the brief missed: World Atlas (3865) → Runic Compass (3866) → Bounty of Worlds (3867) → choice of Bloodsong/Celestial Opposition/Dream Maker/Solstice Sleigh/Zaz'Zak's Realmspike (`3867.into`).
- **New `components/hextech/supportItem.ts`:** `findSupportFinalInBuildData` (a real scan for the always-null-today measured case, self-activating if upstream ever starts returning one) + `classifySupportArchetype`/`resolveSupportItemSuggestion` — a data-informed fallback that reads the champ's OWN recommended core items against curated enchanter/tank item pools (real itemization beats ddragon's coarse tags, since ddragon has no "Enchanter" tag — Nami/Yuumi and a poke mage like Xerath share the same Mage+Support tags but build completely different items), falling back to class tags, then a curated cc/engage rating (`lib/draft/compRatings.ts`) to split the Tank/Engage bucket between Celestial Opposition (reactive) and Solstice Sleigh (CC-reward). A non-measured suggestion is always labelled "Suggested — not measured" in the UI, never presented as data.
- **New `components/hextech/SupportItemCard.tsx`**, wired into `BuildTabContent.tsx`'s grid (new `support` area, support-role-only, gated on `lane === "support"` — no reflow for other roles). Deliberately additive/separate from `CoreBuildOrderCard` — that card renders `build.items` verbatim from the API contract; nothing is filtered or duplicated into it.
- **Verified live** (local puppeteer smoke, `npx next start`): Nami support → Dream Maker (Enchanter); Senna support → Bloodsong (AD/Aggressive); Leona support → Solstice Sleigh (Tank/Engage); Senna Bot (non-support) → no Support Item card. Notably, Nami's real Pro Consensus data (a separate pipeline, `/api/pros`-sourced) independently shows Dream Maker as the top real pro pick (53%, N=78) for her — external validation of the fallback heuristic, not something this feature currently reads.
- 15 new unit tests (`components/__tests__/supportItem.test.ts`) — measured-branch scanning, archetype classification (enchanter/tank/AD/AP), the Solstice Sleigh vs Celestial Opposition rating split, and an uncurated-champion no-crash path. 1441 tests total.
- Web-only — no companion change, no user re-install.

## [0.48.6] — 2026-07-22 (companion unchanged at 1.6.3)
### Added — "Beats You" win-rate % column on Suggested Bans
- User request: show a percentage on each ban row. Added a "Beats You" column = the ban target's winrate AGAINST your hovered pick (how often they beat you) = 1 − (your winrate vs them), since a LoL matchup has no draws. Direction pinned with a test (a real counter reads >50% — the v0.37.2 inversion lesson). New `winVsYou` field threaded score.ts `BanResult` → recommend → draftRecommend normalizer (defaults null on older cached responses) → draftBansModel → DraftBansTable. Display-only, never enters the ban score. Web-only. 1426 tests.

## [0.48.5] — 2026-07-22 (companion unchanged at 1.6.3)
### Added — dismiss ("×") on the "Update ready" service-worker toast
- User-reported: the "Update ready / Refresh" PWA update prompt felt stuck (it re-appears after each refresh — expected, since every new deploy is a legit new version, and ~20 shipped today — but there was no way to close it without a disruptive refresh mid-champ-select). Added a "×" dismiss button (`components/ServiceWorkerRegister.tsx`) that hides the toast for the rest of the tab session via `sessionStorage` (`coachbuild:swUpdateDismissed`). A fresh tab still surfaces genuinely new versions; the app is network-first so a dismissed SW update only means slightly stale cached assets until the next natural load. The Refresh/skip-waiting/controllerchange-reload flow is unchanged.

## [0.48.4] — 2026-07-24 (WEB-ONLY — no companion change, no re-install)
### Fixed — "Apply pro runes" used the WPA build's shards instead of the actual pro shards
- **User-reported (Senna Pro page):** the pro consensus for Senna's offense shard slot IS Attack Speed, but applying the pro rune page wrote the WPA-recommended build's shard (Adaptive Force) instead.
- **Root cause:** `proConsensusRuneApplyInput` always sourced `shards` wholesale from the caller's `fallbackShards` (the on-screen WPA build). That's because `ProConsensusModel.shards` (the card-display shard breakdown) is a FLAT top-3-by-frequency count with no offense/flex/defense label — real ids overlap between slots (Adaptive Force is valid in both offense and flex), so it could never be safely assigned to a specific slot. The raw per-game field `game.runes.shards`, however, IS positional (`[offense, flex, defense]`, preserved 1:1 from Riot by `lib/pro/extract.ts`) — that positional structure was sitting unused.
- **Fix:** new `ProConsensusModel.shardPage` resolves the per-row MODAL id at each of the 3 positions independently, over every game with 3-element shard data (soloq-only, since Leaguepedia carries no shard data at all), restricted to ids known-valid for that slot (`OFFENSE_SHARD_IDS`/`FLEX_SHARD_IDS`/`DEFENSE_SHARD_IDS` in `components/hextech/proConsensus.ts`) so a misaligned/legacy id can never be crowned the pro pick for a slot it doesn't belong to. `proConsensusRuneApplyInput` now fills each shard slot from `shardPage.<slot>` when resolved, falling back to `fallbackShards.<slot>` only for the specific slot(s) with no valid pro data — a per-slot fallback, not all-or-nothing. `shardsFromFallback` is now `true` only in the genuine no-pro-shard-data-at-all case (e.g. an all-prostage sample); a partial mix (some slots pro, some fallback) is `false`, since most of the page is real pro data.
- **Verified:** unit tests pin the Senna-class case (positional soloq shards `[Attack Speed, Move Speed, Health]` → apply input offense = Attack Speed, not the WPA fallback's Adaptive Force), per-slot majority resolution, the genuine all-fallback path (no soloq shard data anywhere → `shardsFromFallback: true`), and the per-slot-invalid-id guard (an id valid for a different slot never wins that slot, falls back for that slot only while other slots stay pro). 1425 tests green.
- Web-only — no companion update needed, no user re-install.

## [0.48.3] — 2026-07-22 (WEB-ONLY — no companion change, no re-install)
### Fixed — *Apply pro runes* wrote an INVALID page with empty primary-tree slots
- **User-reported (screenshot):** applying the in-client *"CoachBuild Ashe Bot Pro"* page left some primary-tree minor slots EMPTY — only the keystone (Lethal Tempo) showed selected. The `…Pro` page itself is correct (1.6.3); this was about the page CONTENTS.
- **Root cause (traced + reproduced against the live 100-game Ashe-bot feed):** `proConsensusRuneApplyInput` assembled the primary minors from `model.primaryMinors.entries` — a FLAT top-3-by-FREQUENCY list with NO per-row structure. A valid LCU page needs exactly one rune per perkstyles row (rows 0/1/2). On a thin or split sample the flat top-3 can rank two runes from the SAME row above a third row's rune (or include a rune that isn't a valid minor of the declared tree) — so the client has no valid perk for the missing row and renders that minor slot EMPTY. `missingRunePageReason`'s old `entries.length < 3` count check passed this (3 total runes, but 2-from-one-row + an empty row). The WPA *Apply runes* button never had this bug because `lib/recommend.ts`'s `rowPicks` already selects one rune PER ROW.
- **Fix — slot-coherent by construction:**
  - New `components/hextech/perkSlots.ts` — the rune-tree SLOT MAP (which id lives in which keystone/minor row of which tree), pinned from a live CommunityDragon `perkstyles.json` pull, matching the fixture in `runeApplyBody.test.ts`.
  - `aggregateProConsensus` now also emits `runePage` (`SlotCoherentRunePage`) — each primary minor row and secondary row resolved to its PER-ROW modal over the conditioned page sample (soloq pages read positionally so a single real game fills all 3 rows; prostage ids resolved through the slot map since Leaguepedia rows aren't positional). No two ids can share a slot by construction.
  - `proConsensusRuneApplyInput` builds the apply body from `runePage` — primary minors in ROW order (0→1→2), the 2 most-adopted secondary rows in ascending row order. `missingRunePageReason` now checks the resolved per-ROW structure (a slot GAP), not a raw count, so it disables the button honestly when a slot is genuinely uncoverable rather than writing an empty slot. The flat `primaryMinors`/`secondaryPicks` remain the card DISPLAY's source (unchanged).
- **Verified:** the real Ashe-bot apply body is now `[8008, 8009(row0), 9103(row1), 8017(row2), 8313, 8410, shards…]` — keystone valid, one minor per row in row order, 2 secondary picks from 2 rows. New unit tests cover: complete/thin-1-game/cross-game-fill (usable) vs. genuinely-uncoverable-slot and same-row-collision (honestly disabled), all perkstyles-validated. 1422 tests green.
- **Thin-data decision:** per-row modal already realizes "fill from real games" (cross-game at the row level; a single complete soloq game fills all 3 rows), so the button stays usable on any sample with ≥1 complete real page; a row absent from EVERY sampled game disables the button (no "modal game" could supply it either) rather than fabricating a slot.

## [0.48.2] — 2026-07-22 (COMPANION CHANGE → 1.6.3 — re-install required)
### Fixed — pro runes get reverted (WPA and Pro now write SEPARATE rune pages)
- **User-reported (screenshot, companion 1.6.2):** *"pro runes still not getting applied"* — clicking *Apply pro runes* appeared to apply, then the runes reverted; also asked to *"change the name of the rune page and add 'pro' to distinguish."*
- **Root cause (traced):** the WPA auto-export and the *Apply pro runes* button BOTH built the SAME page title `"CoachBuild <champ> <role>"` (`buildRuneApplyBody`), and the pre-1.6.3 companion matched ANY `"CoachBuild*"`-prefixed page and edited the oldest **in place** — so the two writes fought over ONE physical LCU page. The app-wide WPA auto-export re-applying that shared page reverted the pro runes the user had just applied. (The user's secondary-tree mismatch — "consensus said Sorcery, page showed Resolve" — was this same revert: the WPA page's Resolve overwrote the pro page's Sorcery. The pro body construction itself is correct — `proConsensusRuneApplyInput` sends the conditioned secondary tree + picks, and the companion's byte-for-byte readback-verify still catches a genuine content mismatch.)
- **Fix — two coexisting pages:**
  - WPA keeps `"CoachBuild <champ> <role>"`; *Apply pro runes* now writes `"CoachBuild <champ> <role> Pro"` (web: `buildRuneApplyBody(..., { pageSuffix: "Pro" })`). The `"Pro"` suffix is AFTER champ/role so the champ-scoped cleanup prefix `"CoachBuild <champ> "` still matches BOTH pages.
  - Companion 1.6.3 `Invoke-ApplyRunes`: each apply targets its OWN **exact-title** page — PUT-in-place if that exact title exists, else create. New champ-scoped stale cleanup (driven by a new `replacePrefix` field on the apply body) deletes OUR pages for OTHER champions on a champ change while protecting BOTH of the current champ's pages from cross-deletion; a page whose title starts with the current champ prefix is never deleted, and a non-`"CoachBuild"` page is never touched. Cleanup is fail-soft (a delete the LCU refuses — e.g. a selected stale page — is skipped, self-heals next cycle). Bounded at the current champ's ≤2 pages.
- **HARD INVARIANT (unchanged, SelfTest-pinned):** never DELETE or PUT-overwrite a non-`"CoachBuild"` page; the auto 5-page/0-CoachBuild adversarial fixture still issues zero deletes — now also proven with `replacePrefix` present.
- **Harness:** `-SelfTest` extended (6g–6k) — PRO creates a separate page leaving WPA untouched (zero deletes); WPA-with-both edits only the WPA page and never clobbers the Pro page; a champ change cleans up BOTH old-champ pages while a foreign hand-made page survives byte-for-byte; cleanup fail-soft; and AUTO+`replacePrefix`+foreign-pages still zero-delete. Both PS harnesses PASS; `companion.ps1` stays 100% ASCII.
- **Caveat:** the LCU multi-page behavior is unreproducible without a live client — **please confirm on-device** that applying pro runes now leaves a distinct `"… Pro"` page that survives the WPA auto-export, and that switching champions cleans up the previous champion's pages.

### Changed — `-Install` now launches the companion immediately (no click / reboot needed)
- **User-reported:** running the install one-liner with `-Install` set up autostart but the user still had to click the Startup entry (or reboot) to actually START the companion.
- **Fix (`public/companion.ps1` `Install-Companion`):** after writing the truly-hidden Startup `.vbs` (unchanged), `-Install` now ALSO launches the companion right away via the SAME truly-hidden path the `.vbs` uses at startup — `WScript.Shell.Run(cmd, 0, False)` (windowStyle 0 = hidden, honored even when Windows Terminal is the default terminal, unlike `-WindowStyle Hidden`). The launch command is shared (`Get-CompanionLaunchCommand`) so immediate-launch and autostart can never diverge.
- **Double-launch guard:** a new `Test-CompanionAlreadyRunning` opens the companion's named single-instance mutex; if an instance is already live, `-Install` surfaces "already running" and does NOT spawn a second (the spawned instance's own single-instance mutex is the hard backstop regardless, so re-running `-Install` is idempotent — it never stacks instances).
- **Harness:** `-SelfTest` extended (8b/8c) — the launch command is well-formed + 100% ASCII + byte-identical to the `.vbs` command; the guard reports false with no instance live and true while the mutex is held.
- **Re-run the install one-liner** to pick up 1.6.3 — and note it now **auto-starts** the companion:
  `& ([scriptblock]::Create((irm https://coachbuild.vercel.app/companion.ps1))) -Install`

## [0.48.1] — 2026-07-22 (COMPANION CHANGE → 1.6.2 — re-install required)
### Fixed — "Apply pro runes" failed when a CoachBuild rune page already existed (delete-failed)
- **User-reported (twice, real device):** clicking *Apply pro runes* (or auto-runes) FAILED with a red error whenever a CoachBuild WPA rune page was already present in the client — nothing got applied.
- **Root cause:** the apply flow was DELETE-then-CREATE — GET pages → DELETE the existing "CoachBuild …" page → POST a new one → PUT /currentpage to select it. When that existing CoachBuild page was the **currently-selected** page, the LCU **refuses to DELETE the selected page** → `delete-failed` → the whole apply aborted (the v1.5.1-hinted `delete-failed` path).
- **Fix (companion 1.6.2, `public/companion.ps1` `Invoke-ApplyRunes`):** when a page we own (title starts "CoachBuild") already exists, **edit it IN PLACE** via `PUT /lol-perks/v1/pages/{id}` (full `LolPerksPerkPageResource` body — id + name + primaryStyleId + subStyleId + selectedPerkIds + current), then reaffirm selection via PUT /currentpage and run the existing readback-verify. **No delete of our own page, ever.** Endpoint confirmed present in the authoritative LCU OpenAPI schema (the community delete+create tutorials are a convention, not a sign PUT is absent).
  - **Decision tree:** CoachBuild page exists → PUT-in-place (no delete). PUT edit fails → new `edit-failed` envelope with a status-coded hint; we deliberately do **not** fall back to delete+create (the page is still selected, so a delete would fail the same way — reintroducing the bug). No CoachBuild page + free slot → POST directly. No CoachBuild page + full → manual mode falls back to the original currentpage delete+create (real click = real consent); auto mode returns `slots-full` and touches nothing.
- **HARD INVARIANT (SelfTest-pinned, unchanged):** never DELETE or PUT-overwrite a page whose title does not start with "CoachBuild". The in-place PUT targets only our own page (title prefix + id). The adversarial 5-page/0-CoachBuild auto fixture still issues **zero** deletes and zero foreign mutations.
- **Harness:** `-SelfTest`/`-Mock` extended — a fixture where a **selected** "CoachBuild Test Mid" page exists asserts the page is **updated in place** (same id, new perk ids), **zero DELETE** calls, still selected, and the adjacent non-CoachBuild page is untouched; plus an `edit-failed` fail-soft fixture (no fallback delete/POST). Both harnesses PASS. `companion.ps1` stays 100% ASCII.
- **Web side:** no change — `applyRunes` already forwards the companion's `reason`/`hint` verbatim, so the new `edit-failed` hint reaches the toast unchanged; the manual button and auto-export path handle the result generically.
- **Caveat:** the LCU edit-in-place behavior is unreproducible without a live client — pinned in the harness against the LCU schema; **please confirm on-device** that *Apply pro runes* now succeeds when a CoachBuild page already exists and is selected.
- **Re-install the companion** to pick up 1.6.2 (the served `public/companion.ps1` now reports Version `1.6.2`).

## [0.48.0] — 2026-07-22 (WEB-ONLY — no companion change; no re-install needed)
### Fixed — duplicate archetypes + a thin "tank mage"; item-set category lines are now full 6-item builds
- **User-reported** (screenshot of Viktor's in-client sets): (1) *"AP/Mage" and "AP Burst" show the IDENTICAL 4 items — don't duplicate, just show one and name it appropriately, and make sure it doesn't happen for other champs*; (2) *the tank-mage build isn't a good build and it's not 6 items — think about it and change it.*
- **Root cause (verified against real output, not assumed):** AP/Mage and AP Burst are both DATA-FIRST, and Viktor's real items are pure burst, so both resolved to the same picks (confirmed: `AP/Mage: 6655,4645,3089,3020` == `AP Burst: 6655,4645,3089,3020`). Tank Mage was thin (`3157,3020` — his one real durable item + boots) and capped at 4 — NOT because it "pulled burst items" (its `match` already excluded them), but because it was starved and the category cap was 4.
- **Fix (`components/hextech/itemSetBody.ts`), three changes:**
  1. **Category lines are FULL 6-item builds now** (`CATEGORY_LINE_LEN` 4 → 6). The v0.46.0 4-item cap was a payload measure the 413 stale-set prune made unnecessary; item count no longer bounds the byte size (`CATEGORY_MAX_EMIT` caps the number of category blocks instead). Every data-first line pads to a full build.
  2. **A GENERAL de-dup** (`dedupeArchetypeLines`) runs for EVERY champ: after all archetype lines are built, near-duplicate lines collapse to one, keeping the higher-priority name (`ARCHETYPE_PRIORITY`). Viktor's AP/Mage == AP Burst collapses to just **AP/Mage**; a champ whose builds genuinely differ keeps both. Pure + unit-tested. Near-dup = similar length (±1) AND differ by ≤1 item within the smaller set AND actually share items; de-dup never compares across curated-ness, so a deliberate variant is never dropped by a standard line.
  3. **The "variant" archetypes (Tank Mage, Bruiser (AD)) are now CURATED-POOL-DRIVEN, not data-first** (`Archetype.curated`). They exist to show an off-meta durable build the champ's data does NOT reflect, so they're built from a hand-ranked durable pool — Tank Mage: Rod of Ages / Riftmaker / Rylai's / Cosmic Drive / Liandry's / Zhonya's / Abyssal / Rabadon's; Bruiser: Stridebreaker / Black Cleaver / Sundered Sky / Death's Dance / Sterak's / Titanic / Trinity / Hullbreaker — NOT the champ's burst-leaning real items. That makes them coherent AND distinct so they survive de-dup. The champ's OWN on-archetype items still rank first. A curated variant is labelled plainly (never "(low data)") — it's a deliberate judgment build. Standard builds (AP/Mage, Crit/Marksman, Lethality, On-hit) stay data-first.
- **Also fixed:** a latent 2-boots bug — a boots-tagged catalog item (e.g. Mercury's Treads, which carries a durability tag and matched the pure-Tank archetype) could pad into a non-boots slot; fill pools now exclude all boots-tagged items.
- **Net effect for Viktor (unit-verified):** exactly ONE standard **AP/Mage** (6 items) + a distinct, coherent 6-item **Tank Mage** (Zhonya's + Rod of Ages + Riftmaker + Rylai's + Cosmic Drive + Sorc Shoes), never his burst list; never a cross-family AD line.
- **Byte budget (unit-verified):** a maximally-full set (4 six-item category blocks + Core/Buy order/Pro/Highest WPA/Starting/Situational = 10 blocks) = **1852 bytes** — far under the 4096 B LCU per-object ceiling. **No companion change** — entirely web-side; no re-install needed.

## [0.47.1] — 2026-07-22 (companion unchanged at 1.6.1)
### Fixed — /draft champion search dropdown was invisible (clipped by the tactical panels)
- **User-reported:** typing in the /draft ENEMY TEAM (and MY CHAMPION) search showed no results. Root cause: the tactical `.dt-panel` draws its chamfered corners with `clip-path`, and a clip-path on an ancestor clips the ENTIRE descendant subtree — so `ChampionPicker`'s absolutely-positioned results dropdown rendered but was clipped away by the panel bounds (worst at the enemy add-picker, which sits at the panel's chamfered bottom edge).
- **Fix:** `ChampionPicker`'s dropdown now renders in a portal to `document.body` (`position: fixed`, positioned off the input's `getBoundingClientRect()`), escaping any ancestor clip/overflow — fixes it globally, not just on /draft. New pure `components/dropdownPosition.ts` (`computeDropdownPosition`: flip-above when low on screen, edge clamping, width match) with 7 tests. SSR-safe mount gate; outside-click/Escape/keyboard-nav/aria/favorite-star rows/IconWithFallback all preserved; repositions on resize, closes on outside scroll.

## [0.47.0] — 2026-07-22 (WEB-ONLY — no companion change; no re-install needed)
### Changed — item-set archetypes are now DAMAGE-TYPE-SCOPED (durable-AP "tank mage" Viktor now shows)
- **User feedback** (screenshot of a durable-AP Viktor — Rylai's/Blackfire + Sorc + Riftmaker + Abyssal + Rabadon's): *"even if it categorically doesn't work for Viktor, still I want to see potential builds for 'tank mage' Viktor. something like this would defo be a build that works."* The v0.43.0 "sensible-for-champ" gate HID Tank from mages, suppressing exactly these off-meta-but-coherent builds.
- **Redesign (`components/hextech/itemSetBody.ts`):** the five sensible-gated categories (Tank / AP/Mage / AD/Lethality / Attack Speed / Support-Utility) are replaced by a **damage-family** model. Each champion's family (AP vs AD) is inferred from their OWN recommended items' damage tags (classifies AP assassins/fighters like Fizz/Mordekaiser correctly, where their ddragon class tag would not); then **every** archetype INSIDE that family is emitted regardless of meta popularity, and a **cross-family** one is never emitted (no AD/Lethality or On-hit line for an AP mage — those items don't scale with AP).
  - **AP family:** **AP/Mage** (balanced default), **AP Burst** (glass cannon — Luden's/Shadowflame/Rabadon's/Void Staff/Stormsurge), **Tank Mage** (durable AP — Rylai's/Riftmaker/Rod of Ages/Cosmic Drive/Zhonya's/Abyssal — the user's exact screenshot archetype).
  - **AD family** (by sub-lean): **Bruiser (AD)** (Sterak's/Death's Dance/Black Cleaver), **Lethality/Assassin**, **Crit/Marksman**, **On-hit**.
  - **Tank (pure):** universal, but now gated to ACTUAL tanks (Tank tag or high tankiness). Support/Utility is dropped — enchanters resolve to the AP family.
  - Each line: real per-champ WPA/share data first, then a **curated per-archetype item pool** (hand-ranked from real LoL itemization), then a catalog-wide tag fallback — honestly titled "… (low data)" when data-thin. A damage archetype with no real per-champ item only fills when the family is item/tag-confirmed, so a pure tank never gets a hollow "AP/Mage (low data)" line.
- **Invariants preserved:** 1-boots + full-item (`isFullItem`) rules, the v0.46.0 **4-item cap** per category line, `CATEGORY_MAX_EMIT = 4`, and the byte budget. **Highest WPA is byte-identical (unchanged).**
- **Viktor acceptance (unit-verified):** emits **AP/Mage, AP Burst, AND Tank Mage** (durable-AP items), and never AD/On-hit/Attack-Speed. A bruiser emits the AD set; an actual tank emits pure Tank.
- **Byte budget (unit-verified):** a Viktor set = **~1.05 KB / 7 blocks**; a maximally-full set (4 archetype blocks + all others) = **~1.65 KB / 10 blocks** — both far under the 4 KB per-set ceiling. **No companion change** — the family axis is entirely web-side, so users need no re-install for this feature.
- `verify-fix.sh`: tests 1408 green (53 in `itemSetBody.test.ts`), lint/build/sw/manifest clean.

## [0.46.0] — 2026-07-22 (companion → 1.6.1 — re-run the install one-liner from /live-setup to update)
### Fixed — pushing item builds failed with "HTTP 413" AND the Tank/Mage category builds never showed in-game — ONE root cause, one fix
- **User report:** "Add item builds" failed with `League client rejected the item-set write (HTTP 413)`, and separately "the Tank/Mage category builds aren't in the game — I don't see a Tank/Mage build for Viktor." **These are the same bug.** 413 = Payload Too Large; the LCU item-sets PUT **replaces the entire item-sets object atomically**, so a 413 rejects the *whole* write — none of the CoachBuild sets land, which is exactly why the category blocks never appeared in-client. Fixing the 413 fixes both symptoms.
- **Root cause:** the companion's merge kept every existing CoachBuild set for *every other champion+role* across sessions and re-sent them all in each PUT (the endpoint replaces the whole object). Since a set is auto-written on each champ-select deep-link, an active user accumulated one ~10-block CoachBuild set **per champion they'd been in champ-select for**; v0.43.0's fuller archetype-category sets pushed the combined payload past the LCU's item-sets size limit → 413.
- **Fix — two complementary levers:**
  1. **Companion (`public/companion.ps1`, → 1.6.1), primary lever:** `Merge-ItemSets` now keeps **only the set(s) being written this call** (the current champion+role) and prunes **every** pre-existing CoachBuild-titled set — this champion's stale roles and every other champion's accumulated sets. This bounds our contribution to the PUT at O(1) instead of O(champions ever viewed). **Hard invariant preserved (SelfTest-pinned):** the prune boundary is the literal generic prefix `"CoachBuild"` — a set whose title does NOT start with `"CoachBuild"` is *never* dropped, so the user's own hand-made sets always survive byte-for-byte. All existing merge safety is intact (GET-then-PUT, never PUT on a failed GET, every other top-level field byte-identical). New SelfTest fixture: 15 accumulated CoachBuild sets + 3 user sets → after one write, exactly the current CoachBuild set + all 3 user sets remain (4 total), plus the existing zero-non-CoachBuild-removal assertion.
  2. **Web (`components/hextech/itemSetBody.ts`):** the archetype **category** lines (Tank / AP/Mage / AD/Lethality / Attack Speed / Support-Utility) are trimmed from 6 items to `CATEGORY_LINE_LEN = 4` (3 core items + 1 boots), keeping the 1-boots and full-item invariants. The real Core / Buy order / Pro / Highest WPA lines are **unchanged at 6**. Category count and `CATEGORY_MAX_EMIT` are untouched (a follow-up round expands the category vocabulary). This shrinks each set and works even against a not-yet-updated companion.
- **Payload accounting (unit-verified):** a single maximally-full set (4 category blocks + Starting/Core/Buy/Pro/Highest WPA/Situational) = **~1.47 KB / 9 blocks**; a projected 6-category set ≈ **~1.74 KB** — both far under a conservative 4 KB per-set ceiling. Before the fix, an active user's payload grew unbounded (~1.5 KB × every champion viewed → tens of KB); after, it's bounded to the current set (~1.5 KB) plus the user's own sets.
- **Viktor sanity (unit-verified):** a realistic pure-mage Viktor set now correctly contains the **AP/Mage** category and correctly does *not* force AD/Lethality, Attack Speed, or Support-Utility (his curated sensible-gates are closed). A Viktor **Tank** line still appears via the intended v0.43.0 live-data escape hatch when Zhonya's (Armor) is in his pool — that's by design, not a bug. A pure mage having fewer category blocks than a bruiser is expected.
- **Runes sub-check (separate, not the 413):** "Apply pro runes" uses `/apply-runes` (a tiny `/lol-perks` body, ~150 B) — not a payload issue. The likely mechanism when a CoachBuild rune page already exists AND is the currently-selected page is the LCU refusing to DELETE the active page (delete-then-create flow), which surfaces as a `delete-failed` error toast the user reads as "doesn't work." This is LCU-behavior-dependent and can't be reproduced without a live client, so it is **flagged for a follow-up** (recommended safe fix: PUT-update the existing CoachBuild page in place rather than delete+recreate an active page). The compliance-sensitive rune path was deliberately left unmodified this round.
- `verify-fix.sh`: tsc/lint/tests(1404)/build/sw/manifest all green. Companion `-SelfTest`: PASSED.

## [0.45.3] — 2026-07-22 (companion unchanged at 1.6.0)
### Fixed — the 5 lane-role toggle icons on the MY CHAMPION panel now read as real League position icons
- **User report:** `/draft`'s "MY CHAMPION" panel (`components/hextech/MyChampionPanel.tsx`) rendered 5 hand-drawn placeholder glyphs (a chess-piece-ish top, plain shields, an arrow for bot) for the Top/Jungle/Mid/Bot/Support lane toggle — didn't read as League's actual position icons.
- Replaced `LaneGlyph`'s inline placeholder `<path>`s with path/polygon data traced directly from Riot's OWN champ-select position glyphs (CommunityDragon `raw.communitydragon.org/latest/plugins/rcp-fe-lol-champ-select/global/default/svg/position-{top,jungle,middle,bottom,utility}.svg`) — inlined as static path data, no hotlink (this app runs a strict SW + self-contained-asset convention, and prostage/coachless icons already establish "Riot/ddragon assets under the personal-use footer" as an existing, not new, compliance posture). Riot's own source splits top/mid/bot into a faint always-on frame (opacity .5) plus a bright corner-bracket accent; both paths are kept as one `fill="currentColor"` icon so the panel's existing active/inactive theming (cyan-filled tile when selected, muted stroke-turned-fill otherwise) still drives the whole glyph exactly as before — sizing (16×16 in a 9×9 button), `aria-label`/`title`/`aria-pressed`, and the `onLaneChange` wiring are all unchanged.
- Checked for other consumers of these glyphs before touching anything: `components/hextech/Sidebar.tsx` (collapsed lane nav) and `components/hextech/LaneFilterPills.tsx` (`/movers`) both render `LANE_LABEL` text pills, not icons — `MyChampionPanel.tsx` is the ONLY consumer, so the fix stayed local (no `RoleIcon.ts` extraction).
- `verify-fix.sh`: tsc/lint/tests(1400)/build/sw/manifest all green — no test surface changed (no new pure module extracted).

## [0.45.2] — 2026-07-22 (companion unchanged at 1.6.0)
### Added — favorite star on the home-shell player view + pinned Favorites before searching
- The player header (`PlayerHero`) gains the favorite star for TRACKED pros — same `FavoriteStarButton` + `coachbuild:favPlayers:v1` storage the /history view uses (link-only players opened from team boxes stay star-less, preserving the v0.26.0 policy).
- The empty PROS search state (`ProsSearchPrompt`, v0.44.3) now pins your starred players under a "Favorites" label; a `FAVORITES_CHANGED_EVENT` subscription keeps the star and the pinned chips in sync instantly (star Faker → clear the selection → he's pinned, no reload).
- Implementation by the favorite-star round (agent transcript lost post-hold — ship steps executed by the orchestrator); `verify-fix.sh` green at 1400 tests.

## [0.45.1] — 2026-07-22 (companion unchanged at 1.6.0)
### Added — Pro Consensus card can push its OWN page/build to the client (manual, never auto)
- **User ask:** the Pro Consensus card (`components/hextech/ProConsensusCard.tsx`) already shows what pros actually build/run, but only the WPA-recommended page (RunesSummonersCard) could be pushed to the League client. Two new header buttons, visually parallel to RunesSummonersCard's own Apply-runes/Add-item-builds pair, same `hasSession()` visibility gate and disabled/applying/success/error states:
  - **"Apply pro runes"** — pushes the pro-consensus rune page through the SAME `companionClient.applyRunes` pipeline (`buildRuneApplyBody`) the WPA button uses, strictly user-clicked (unchanged compliance posture — `mode: "manual"` only, never a poll/effect). Disabled with a reason tooltip whenever the pro sample can't fill a complete page (no keystone, <3 primary minors, no secondary tree, <2 secondary picks) — new `missingRunePageReason` (`components/hextech/proConsensus.ts`) is the single source of truth both the button and the pure builder read, so they can never disagree about why it's greyed out. **Never fabricates a slot.**
  - **"Add pro item build"** — a manual re-trigger of the SAME `itemSetsApply.ts` pipeline (`applyItemSetsForBuild`) RunesSummonersCard's own button already calls; honestly labeled — it adds the full CoachBuild champ+role set with the Pro line already folded in, not a pro-only set.
- **New pure builder — `proConsensusRuneApplyInput(model, fallbackShards)`** (`components/hextech/proConsensus.ts`): translates a `ProConsensusModel` into the exact `RunesBlock` shape `runeApplyBody.ts`'s `buildRuneApplyBody()` already consumes, so pushing the pro page is byte-for-byte the same wire path as the WPA page. **Shards are NEVER derived from `model.shards`** — that breakdown is a flat top-3-by-frequency count with no offense/flex/defense slot label (and real ids like Adaptive Force overlap slots), so assigning a bare id to a slot would fabricate structure the model doesn't have. Always uses the caller's `fallbackShards` (the current WPA build's `ShardSet`, already on screen) instead, flagged via `shardsFromFallback` so the button's tooltip says so honestly. Tree ids are validated against the closed 5-value `TreeId` set (`asTreeId`) before being used to build a `TreeRef` — never assumed.
- `ProConsensusCard`/`BuildTabContent` wiring: `ProConsensusCard` gains an optional `build?: BuildResponse` prop (same degrade-quietly convention as RunesSummonersCard's own optional props — omitting it just hides both new buttons); `BuildTabContent.tsx` passes the already-fetched `build` straight through, no new fetch.
- New tests: `missingRunePageReason` (5 cases) + `proConsensusRuneApplyInput` (5 cases, including a deterministic-tie-order regression against the model's own count-desc/id-asc sort) in `components/__tests__/proConsensus.test.ts`. `npx vitest run`: 1400 passed (was 1391). `npx tsc -b` clean.

## [0.45.0] — 2026-07-22 (companion 1.5.1 → 1.6.0)
### Added — champ select now opens Builds AND /draft as two simultaneous pages (user directive)
- **User ask (verbatim intent):** "create a new browser page for it, if the page open isnt already a champ select... open two pages simultaneously, one for champ runes and items and another for the draft as the main focus page." Previously a champion resolution in champ select only ever opened the Builds deep-link (`/?championId=&role=&session=`); `/draft` had no companion-driven open path at all.
- **Web (`follow` goes from a boolean to a page IDENTITY):** `components/live/companionClient.ts`'s `isFollowCapableRoute(pathname): boolean` is superseded by `followKindForRoute(pathname): "builds" | "draft" | null` (`"/"` → `"builds"`, `"/draft"` → `"draft"`, exact match only, same as before). `isFollowCapableRoute` is kept as a pure boolean wrapper over it for back-compat. The `/status` poll's 4th param on `getStatus`/`probeCompanion`/`refreshStatus` is now `FollowKind` (`"builds" | "draft" | null`) instead of a bare boolean, and `bridgeUrl` sends `&follow=builds` or `&follow=draft` (never bare `follow=1` from a new build). `CompanionProvider.tsx`'s `followRef` threads the kind through the SAME poll effect, unchanged deps/cadence (Round-B P1 markCompanionDriven ordering untouched).
- **`/draft` now adopts a companion session.** New mount-only effect (mirrors app/page.tsx's own deep-link mount effect, but session-only — `/draft` has no championId/role param, it live-syncs entirely off `CompanionProvider`'s poll): reads `?session=` off `window.location.search` once and calls `companion.setSession`. Does not touch `dirty`/`lane`/`enemyIds`/`entryStateRef` — the reskin's byte-for-byte-preserved live-sync state machine is untouched.
- **Companion (`public/companion.ps1`, 1.5.1 → 1.6.0):** `Test-CompanionHasAttachedTab` gained a `-Kind builds|draft` param, backed by two independent 8s-window fields, `$Sync.LastBuildsFollowAt` / `$Sync.LastDraftFollowAt` (replacing the single v1.5.0 `LastFollowPollAt`). The bridge's `/status` handler stamps the matching field from `follow=builds`/`follow=draft`; a legacy `follow=1` (stale cached pre-1.6.0 web build) stamps `LastBuildsFollowAt` only — see back-compat matrix below. `Update-ChampSelectState`'s open decision (fires only when the existing champion-change debounce admits a NEW resolution — unchanged semantics, no new per-tick open loop) now opens whichever page(s) are MISSING: **neither attached → open Builds first, then `/draft` last** (new `Get-DraftDeepLinkUrl`, `<AppOrigin>/draft?session=<token>`, no championId/role) so Start-Process's best-effort OS focus order lands the user on /draft, per the directive; **only draft attached → open Builds only**; **only Builds attached → open /draft only** (this necessarily focuses the new Builds tab instead — an unavoidable Start-Process consequence, not a violation of the directive, which is specifically about the both-missing case); **both attached → no opens** (unchanged from pre-1.6.0 single-page behavior).
- **Back-compat matrix** (verified in `-Mock`/`-SelfTest`, see below):
  | Web build | Companion | Result |
  |---|---|---|
  | old (`follow=1`) | new (1.6.0) | `follow=1` stamps builds-kind only, draft-kind never stamped → Builds stays suppressed when its tab is open; `/draft` opens on EVERY champ-select entry (a NEW tab each time — acceptable, that's the feature for a web build that can't yet declare a `/draft` tab attached) |
  | new (0.45.0) | old (pre-1.6.0, checks `follow=1` exactly) | `follow=builds`/`follow=draft` never match the old exact-string check → the old companion never sees an attached tab → opens the single Builds page always, same pre-1.3.0-era degrade (safe, no `/draft` open — the old companion doesn't know the URL exists) |
  | new | new | full two-page behavior as designed |
- **Companion harnesses (`-Mock`/`-SelfTest`):** `-Mock`'s pre-existing champion-resolution/debounce scenarios (predate this ship) now run against a simulated draft-attached bridge so they keep testing exactly what they always tested (Builds-only debounce/URL format), undisturbed by the new two-page decision. New dedicated "Attached-tab gate" scenarios cover all four kind-combinations (neither/draft-only/builds-only/both attached) plus both-stale resume, asserting exact URLs and Builds-then-draft order. `-SelfTest` gained a real-HTTP round trip through the bridge's own query-string parsing (`follow=builds`/`follow=draft`/no-follow/legacy `follow=1`), verifying each stamps only its own field.
- **Users must re-run the install one-liner to pick this up** — companion.ps1 is served over `irm|iex`, a stale locally-cached copy won't self-update; until they do, they get the old-companion row of the back-compat matrix above (Builds-only opens, unchanged from before this ship).
- New tests: `followKindForRoute` (7 cases) + `follow=<kind>` plumbing (6 cases) in `components/__tests__/companionClient.test.ts`. `npx vitest run`: 1391 passed (was 1382). `npx tsc -b` clean.

## [0.44.3] — 2026-07-22 (companion unchanged at 1.5.1)
### Fixed — PROS mode with no player selected no longer shows the champion page underneath
- **User-reported (mobile screenshot):** switching the sidebar search to PROS mode left the ENTIRE champion page (hero, BUILD/PRO BUILDS tabs, rank bracket, runes, every card) rendering in the main area until a player was picked. `deriveMainView` (`components/hextech/homeSearch.ts`) has always intentionally kept carrying the champion view's real STATE while PROS mode has nothing picked yet (that's what makes the CHAMPIONS<->PROS toggle round-trip losslessly — champ/lane are never reset), but nothing at the RENDER layer used that as anything other than "paint the champion page."
- **Fix:** new pure gate `isProsSearchEmpty(mode, selectedPlayer)` (`homeSearch.ts`), checked ahead of `mainView.kind` at the composition site in `app/page.tsx`. When true, the main area renders a new `ProsSearchPrompt` component instead — a quiet centered "Search for a pro player" panel (same empty-state card shape `PlayerGamesSection.tsx` already uses) plus `FavoritePlayerChips` (the v0.10.0 one-tap row, reused as-is) when the user has any favorited players. Tapping a favorite calls the exact same `handlePlayerSelect` the sidebar's PROS dropdown pick calls — identical PROS-mode landing and history push.
- **Render gate only** — `mainView`/`champ`/`activeLane` are never touched by this change. Toggling PROS→CHAMPIONS still restores the exact prior champion/lane/tab; picking a player still shows the player view. Mode-toggle-alone still pushes no history entry (unchanged v0.23.0 policy) — the gate reads live `searchMode`/`selectedPlayer` state directly, not a history entry.
- Lives in the single `<main>` composition shared by both the collapsed-mobile and desktop `Sidebar` renders, so the fix is breakpoint-agnostic by construction — verified at 390×844 and 1280×800.
- **Traced, not modified:** the deep-link mount effect and the companion champ-select live-follow effect (both above the `return` in `app/page.tsx`) are untouched. The mount effect's own `setSearchMode("champions")` calls (both its role-bearing and role-less branches) already force an exit from PROS mode on every deep-link fire, so this gate is never even evaluated in that path. The live-follow tick effect, unlike the mount effect, does NOT set `searchMode` — if a user manually flips to PROS (nothing searched yet) while a paired live game's champ-select hover/lock changes, `champ`/`activeLane` update correctly in the background (untouched, confirmed via the existing `mostPlayedLaneRequestRef`/`replaceSelection` machinery) but the new prompt now stays visible rather than the champion page silently reappearing — a deliberate consequence of the user's own directive being unconditional ("when searching for pro players, don't show the champion page UI"). The followed champion is not lost: it reappears immediately, correctly, the moment the user flips back to CHAMPIONS or picks a player. This is a narrow, pre-existing-toggle-mismatch edge case (PROS toggle showing "Pros" while a live game silently updates the champion underneath) that is now visible instead of silently papered over.
- New tests: `isProsSearchEmpty` (4 cases) in `components/__tests__/homeSearch.test.ts`. `npx vitest run`: 1382 passed (was 1378). `npx tsc --noEmit` clean.

## [0.44.2] — 2026-07-22 (companion unchanged at 1.5.1)
### Fixed — Dark Seal (and every starter-class item) can no longer render as a full/completed item, anywhere
- **Root cause (screenshot-verified live bug):** Pro Consensus's ITEMS grid on Viktor mid showed "Dark Seal 24% (23/95)" mixed in with Blackfire Torch/Rabadon's/etc. `proConsensus.ts`'s `aggregateProConsensus` correctly counted Dark Seal/Tear of the Goddess (`STARTING_ITEM_ALLOWLIST`, added v0.27.1) as a real build entry, but aggregated it into the SAME `items` list as genuine completed items instead of its own slot — the v0.28.0 boots partition never got the same treatment.
- **Fix:** `ProConsensusModel` gains a new `starters: ItemFrequency[]` field — `STARTING_ITEM_ALLOWLIST` ids are now carved OUT of `items` into `starters`, the exact same mechanical pattern v0.28.0 used to carve `boots` out of `items`. `ProConsensusCard.tsx` renders it in its own "Starting" labeled slot (matching the card's existing label vocabulary — same word `itemSetBody.ts`'s "Starting" block and `StartingCard.tsx` already use), positioned before the Items block, absent entirely when empty (no empty block).
- **App-wide sweep** (every RECOMMENDATION/AGGREGATE surface that could show a completed-item list): item-set build lines (Core/Buy order/Pro/Highest WPA/archetype categories) were already covered-by-construction since v0.36.0's `isFullItem` has no allowlist escape hatch — verified generically (not just for Dark Seal) with a new regression test iterating the real `STARTING_ITEM_ALLOWLIST` constant against every build line. Core/optimized build order and the sequential item optimizer are covered-by-construction structurally — the backend WPA engine (`lib/recommend.ts`) sources starters from a dedicated `starterData` query, never the legendary-slot pools that feed the main build. Item-set "Situational swaps" and "Starting" blocks are intentional/unchanged homes for starter-class items (swap suggestions and the dedicated starting slot, respectively — never presented as a completed build). Full per-surface table in `HANDOFF.md`.
- Two pre-existing `itemSetsApply.test.ts` tests were quietly relying on the OLD behavior (using Doran's Shield, itself an allowlist entry, as their "real build item" fixture) — updated to use a genuine non-starter item, plus a new dedicated regression for the now-null-when-only-a-starter-was-seen case.
- `npx vitest run`: 1378 passed (was 1372). `npx tsc --noEmit` clean.

## [0.44.1] — 2026-07-22 (companion 1.5.0 → 1.5.1)
### Fixed — companion.ps1 apply-runes/apply-itemsets: every `ok:false` now carries a human-actionable hint
- **Root cause of the generic "Couldn't add item builds" toast:** the v0.43.0 web-side classifier (`companionClient.ts`) only shows its own generic fallback text when the companion's response has NO `hint` field. An audit of every `ok:false` response in `public/companion.ps1` found four hint-less paths: `/apply-itemsets` and `/apply-runes` both return `{ok:false, reason:'no-client'}` with no hint when the League client hasn't been detected yet; `/apply-itemsets` returns `{ok:false, reason:'write-failed'}` with no hint when the final LCU PUT is rejected; and `/apply-runes` returns `{ok:false, reason:'create-failed'}` with no hint (both the CoachBuild-page-replace path and the manual-mode fallback path) when the LCU rejects the new rune-page POST.
- **Every path now carries a hint:** `no-client` → "League client not detected -- open the client and try again"; a rejected LCU write (item-set PUT or new rune-page POST) → a new shared `Get-LcuFailureHint` classifies by HTTP status — 401 or a connection-level failure (status 0) means the LCU we resolved credentials for is gone (same signal `Invoke-GameflowTick`'s own reconnect logic already uses) → "companion lost the client connection -- it re-detects automatically, try again in a few seconds"; any other status → "League client rejected the &lt;write&gt; (HTTP &lt;code&gt;) -- make sure you're logged in and not mid-game". The item-sets merge-safety GET (read before any write, the #1 correctness risk per that function's own header) got its own clarified hint: "couldn't read your existing item sets -- nothing was changed".
- `Invoke-LcuRaw`'s catch block now also captures the LCU's own error-response body (first ~200 chars, via `ErrorDetails.Message` — how Windows PowerShell 5.1 surfaces a non-2xx body on a terminating `Invoke-WebRequest` error) into the throttled companion log alongside the status code. Never surfaced verbatim to the user — a hint only ever gets the numeric status code.
- New SelfTest cases (mock-LCU fixtures extended with `PagePostShouldFail`-with-existing-CoachBuild-page and a new `ItemSetsPutShouldFail` toggle) assert the exact hint text for all four newly-hinted paths; negative-tested (a deliberately reverted no-client hint was confirmed to fail the new assertions before being restored).
- **Users must re-run the install one-liner to pick this up** — companion.ps1 is served over `irm|iex`, a stale locally-cached copy won't self-update.

## [0.44.0] — 2026-07-22 (companion unchanged at 1.5.0)
### Changed — Builds page responsive overhaul (user-reported mobile squeeze + dedicated desktop composition)
- **Root cause of the mobile "gap right of the header" + clipped rank brackets (ONE bug):** the 7-pill rank `SegmentedControl` had no wrap and no scroll, overflowing 390px and widening the document past the viewport. `SegmentedControl` gains an additive `layout="scroll"` mode (snap-x track + static right-edge fade affordance; default `"inline"` so /history, PRO BUILDS, and mode-toggle call sites render unchanged); the rank selector stacks label-above-control on mobile.
- **Mobile-first header:** the collapsed top bar is full-bleed — wordmark + full-width champion search + a real "More" overflow menu (`MobileNavMenu`, local disclosure state, ZERO history entries per gotcha (p)) replacing the cramped dotted utility-links row. LANES 5-col grid unchanged.
- **Runes & Summoners regrid:** the fr-stretch grid is replaced with content-packed columns — primary + secondary trees side by side on mobile (roughly halving the card's height), one uniform 2-line label clamp on every rune tile, summoners as a tidy bottom row. Apply/companion wiring untouched.
- **Desktop composition (≥lg):** the 900px content cap is lifted (xl re-caps at 1440) and the Build tab becomes a genuine 2-column grid via `grid-template-areas` — Runes & Summoners + Core/Optimized order in the wide column; Starting, Pro Consensus, Situational in the narrow one — from the SAME DOM order (mobile stacking literally unchanged, no duplicate mounts/fetches). Persistent 220px sidebar retained; its footer utility links now render from the shared `navLinks.ts` registry and got real spacing (they previously ran together as "Pro playersPatch moversCompanion" — caught in the acceptance screenshot).
- Defensive `overflow-x-clip` on the main content wrapper only. Loading skeleton mirrors the 2-col grid (no reflow on resolve); empty/error states stay full-width; the rank selector survives every fetch state.
- **Acceptance-verified via puppeteer** at 390x844 (no horizontal scroll, "High Elo" on one line, scrollable track + fade, More menu with all 5 links at 44px targets, side-by-side rune trees, zero console errors) and 1440x900 (2-col grid confirmed side-by-side, width actually used, zero console errors). 1371 tests. Plan of record: `_research/builds-responsive-plan.md`.

## [0.43.0] — 2026-07-22 (companion unchanged at 1.5.0)
### Added — item-set archetype categories (user ask: "add the item categories even if not with big sample size")
- **Five archetype build lines replace the old binary Tanky/Burst pair:** Tank, AP/Mage, AD/Lethality, Attack Speed/On-hit, Support/Utility (`components/hextech/itemSetBody.ts`). Same confirmed ddragon tag vocabulary as before (no new fetch) — Tank keeps the old Health/Armor/SpellBlock tags verbatim; AP/Mage + AD/Lethality split what used to be one combined "Burst" set (SpellDamage/MagicPenetration vs. Damage/ArmorPenetration/CriticalStrike); Attack Speed/On-hit and Support/Utility are new but drawn from the same vocabulary (AttackSpeed/OnHit; Aura/GoldPer/CooldownReduction/ManaRegen/HealthRegen).
- **A category only appears when it's SENSIBLE for the champion:** a `lib/draft/compRatings.ts` curated-rating signal (e.g. tankiness>=1 for Tank) OR a ddragon archetype tag (`ChampionRef.tags`, e.g. Marksman→AD/Lethality) OR the champion's own real item data already shows ≥1 tag-matched full item — the live-data escape hatch that keeps a Yuumi from getting an AD/Lethality line just because the whole roster is being swept. Capped at 4 category lines per champ (prefers the ones with the most real data) to keep the in-client set's block count reasonable (~10 max).
- **Thin data is no longer an omission reason.** Once a category is sensible, it's never dropped for lack of samples — fewer than 4 real qualifying items now triggers a fill instead: real per-item WPA data ranks first, then a catalog-wide "default quality" pool (every full, purchasable item of that tag, ranked by total gold as an honest — not measured — quality proxy) pads the rest, still enforcing the existing exactly-6-items/exactly-1-boots invariant via the same `buildLine` machinery every other line uses. Filled lines are titled `"<Category> (low data)"` so the UI never presents a judgment call as something measured.
- Highest WPA is **unchanged** — still built by the original `buildThemedLine` (byte-identical regression pin), still omitted below the old ≥4-item pool-size threshold.
- 27 new tests (`components/__tests__/itemSetBody.test.ts`): archetype-gating exemplars (Yuumi/Malphite/Zed/Ashe), the low-data fill path (exactly-6+1, honest title, real-data-ranks-first), and an invariant sweep (no category line ever exceeds 6 items, carries >1 boots, or includes a non-full item) across both measured and low-data modes.

### Fixed — companion apply failures are now self-describing (diagnosability hardening, no companion.ps1 change)
- **Real user report:** "Couldn't add item builds — try again, or add them manually in-client" repeatedly on-device, with no way to retrieve the companion's own log. `components/live/companionClient.ts`'s `applyItemSets`/`applyRunes` previously collapsed several distinct failure modes — a non-2xx HTTP status, a malformed-but-2xx response body, and a companion `{ok:false}` response with no `hint` field — into the SAME generic caller-side fallback message, making them indistinguishable from the toast alone.
- **Every failure mode now gets its own classified `hint`:** a thrown fetch (`network-error`) → "Companion not reachable — is the tray app running?"; a non-2xx HTTP status → "League client refused the [item-set/rune-page] write (code N) — is the client open?"; a malformed 2xx body → "Companion sent an unexpected response — try again or restart the tray app."; a well-formed `{ok:false}` with no companion-supplied hint → the raw `reason` surfaced instead of silently dropped. A companion-supplied `hint` still passes through verbatim, unchanged.
- **New rolling error log** (`coachbuild:companion:lastErrors:v1`, localStorage, cap 20, `{ts, kind, detail}`) — every classified failure above is appended via `recordCompanionError`; `/live-setup` now shows the last 5 (most recent first, with a Clear button) in a new "Recent errors" section, so a future on-device report can be diagnosed from a screenshot of that page alone, without PowerShell/log access.
- **Web-side only** — `public/companion.ps1` is untouched this round (the user can't update the tray app right now); this is blind hardening against exactly the class of report they hit, not a confirmed root-cause fix.
- 12 new tests (`components/__tests__/companionClient.test.ts`): ring-buffer round-trip/cap/clear/malformed-value degrade, each classified failure path recorded with the right kind/detail, a companion-supplied hint passed through verbatim, and a successful call recording nothing.
- 1371 tests (1344 baseline + 27 category + 12 diagnosability, net of 12 rewritten). `verify-fix.sh` clean (tsc/lint/tests/build/sw/manifest).

## [0.42.0] — 2026-07-21 (companion unchanged at 1.5.0)
### Changed — /draft redesigned as the "Tactical Draft Analyzer" (user-supplied prototype)
- **Cyan tactical-HUD reskin, scoped to /draft only** (`.draft-tactical` token block in `app/globals.css` — zero `:root` edits, no leakage into the app-wide Hextech gold): circuit-trace background, chamfered glowing panels, neon display header. All new animation keyframes sit under the existing `prefers-reduced-motion` guard; glow is `text-shadow`/`box-shadow`, never `filter: blur`.
- **New layout:** ENEMY TEAM panel (portrait stack, lane-opp glow + inline MATCHUP ANALYSIS popover — no history entries) + MY CHAMPION panel (framed portrait, search, role toggles, "Set your champion to unlock ban suggestions" hint); TEAM COMPOSITION STRENGTHS 6-axis pure-SVG radar; sortable SUGGESTED PICKS table (Rank/Champion/Win Rate bar/Difficulty/Synergy — default order stays the server's honest rank, any other sort shows "Sorted by X — ranking is CoachBuild's own."); SUGGESTED BANS table (honest priority bar + Difficulty, replacing the prototype's cryptic glyph columns); UPDATE READY ⟳ = the restyled live-sync Reset-to-live control (quiet LIVE pulse when passively synced).
- **New data (all additive, no migration):** Difficulty column from ddragon `info.difficulty` (1-10 → Low/Med/High, `lib/draft/difficulty.ts`); team-comp radar from a hand-curated 173-champion kit-ratings map (`lib/draft/compRatings.ts`, 0-3 rubric documented in-file, ddragon-tag fallback flagged `estimated` for future champs); Matchup Synergy band from `synergyDelta = score − baselineWr` (existing scoring terms re-banded — formula untouched, byte-identical regression pin in `draft-score-synergy.test.ts`); per-enemy `enemyAnalysis` (real Win Rate vs You from `draft_matchup`; honest DERIVED replacements for the prototype's fabricated stats: "Lane threat" band from the shrunk matchup delta, "Suggested defense" from the enemy's ddragon damage profile — both labeled derived, never fake percentages).
- **Every honesty feature survived the reskin** (audited): n= samples, LOW SAMPLE dominant-term contract (v0.39.1), main vs POTENTIAL COUNTERS split, ban 1,000-game floor + empty state, explainer lines, manual-mode banner semantics, champ-select entry re-attach (v0.40.0 — live-sync effect region confirmed hunk-for-hunk untouched), display-only "you:" personal badges + My pool filter.
- **Pre-ship audit (SHIP-AFTER-PATCH, all three folded in):** muted honesty text raised to WCAG AA (dropped the /60-/80 opacity modifiers — 2.9-4.2:1 → 5.94:1); radar aria-label now carries the per-axis VALUES (0-3), not just axis names; ban-suggestions discoverability hint restored on the MY CHAMPION panel.
- 1344 tests (133 net new across 9 new test files). Plan of record: `_research/draft-redesign-plan.md`.

## [0.41.0] — 2026-07-21 (companion unchanged at 1.5.0)
### Fixed — champ-select auto-export never fired when drafting from /draft (P0, real Practice Tool game)
- **Real user-reported bug:** picked Viktor in a Practice Tool, but the in-client rune page stayed "CoachBuild Nasus Jungle" from a previous game — no auto-import fired. Root cause: `autoApplyRunesIfEligible` + `autoApplyItemSetsIfEligible` were mounted ONLY in `components/hextech/BuildTabContent.tsx`, which fires when the **Builds page** loads a build. Since companion 1.5.0, follow-capable tabs (`/` and `/draft`) suppress opening the Builds page and the user now drafts from `/draft` — so no page ever fetched the picked champion's build and nothing exported. The whole champ-select side-effect chain was implicitly anchored to the Builds page being open.
- **Fix (lift to the app-wide companion layer):** new `components/live/AutoExporter.tsx` (mounted once inside `CompanionProvider`, `app/layout.tsx`) reacts to the SAME app-wide `/status` poll on EVERY route. When phase is `ChampSelect` and the local player's champion resolves (`champSelectFollow.ts`'s 3-way resolution), it fetches that champion's build itself (`/api/build`, same endpoint/params/rank-bracket as `BuildTabContent`) and pushes item sets + runes through the SAME apply pipelines and the SAME `champSelectFollowState` dedup. Practice Tool carries no assigned position, so a role-less target falls back to the champion's most-played lane (`getMostPlayedLane` — Viktor → mid), the same policy the deep-link flow uses.
- **Decision/effect logic extracted to `components/live/autoExport.ts`** (pure `resolveAutoExportTarget` / `resolveTargetLane` + the injectable async `executeAutoExport` body) for unit-testability. Identity guard (the v0.36 stale-closure lesson): the fetched build is validated against the CURRENTLY resolved `(championId, laneId)` at CONSUME time — a champion change mid-fetch discards the stale build WITHOUT consuming any dedup slot.
- **Exactly one owner:** `BuildTabContent`'s auto-export effect + toasts are REMOVED (an open Builds page can no longer double-push). The MANUAL "Apply runes"/"Add item builds" buttons (`RunesSummonersCard`) are untouched. Toasts moved to an app-wide fixed overlay so they're visible on `/draft` too. Every promise chain still `.catch()`es into the toast path (v0.35 silent-swallow lesson).
- **Tests:** `components/__tests__/autoExport.test.ts` — 17 new: role-bearing vs Practice-Tool null-role → most-played fallback, export fires independent of route, champion change mid-FETCH → stale build discarded + slot not consumed, latest-wins re-export on champion change, second invocation for the same `(champ,lane)` dedups to a single export, auto/manual toggles + session/port plumbed to the gate, thrown-apply → error toast + marked done, ok:false hint surfaced, null build → no-data. 1209 tests passing (baseline 1192 + 17); `verify-fix.sh` clean (tsc/lint/tests/build/sw/manifest).
- **Pre-ship audit P1 (patched before deploy):** the in-flight run guard was keyed on `championId` alone, so a SAME-champion lane flip mid-fetch (ranked position trade) suppressed the flipped lane's run — the stale run's gen was never bumped, `isStillCurrent` stayed true, and the OLD lane's runes/items were pushed (could persist into the game on a late trade). Fix: new pure `inFlightKey(championId, lane)` — the in-flight set is keyed per `(champion, lane)`, so the flip starts a superseding run whose gen bump discards the wrong-lane build before any push. 2 new regression tests (key identity + the exact held-fetch lane-flip sequence). 1211 tests.

## [0.40.0] — 2026-07-21 (companion unchanged at 1.5.0)
### Fixed — /draft live pickup permanently died after any manual edit (P0, hit twice on real Practice Tool games)
- **Real user-reported bug:** hover-your-champ live auto-fill worked on game 1 (fresh page → hover filled with the user's champion), but after the user tapped "Clear" once, it never worked again — not even on a brand new champ select in a later game. Root cause: `dirty` (`app/draft/page.tsx`) is latched by every manual handler, including `handleClearHover`, and was previously cleared ONLY by an explicit "Reset to live" tap. One Clear tap in game 1 permanently detached the page from every future champ select.
- **Fix:** `components/live/draftLiveSync.ts`'s new pure `resolveChampSelectEntry` detects the champ-select ENTRY transition (previous real phase != `"ChampSelect"`, new phase == `"ChampSelect"`) — tracked via a small state machine that ignores transient `null` poll blips entirely (a `null` tick never counts as "leaving" or "entering" anything, and never overwrites the last real phase). `app/draft/page.tsx`'s live-sync effect calls this on every `companion.tick` and auto-clears `dirty` on a genuine entry, so live pickup re-attaches automatically on every new game. Manual edits still win for the REST of the same champ select (only the entry tick resets the latch) — preserves the earlier "follow fights user" fix.
- **Legibility fix (same report):** when dirty during a live champ select, the old affordance was a small underlined text link easy to miss entirely — part of why the bug read as "live pickup is dead" rather than "I'm in manual mode." Replaced with a visible bordered banner ("Manual mode — champ select detected") and a solid, prominent "Reset to live" button.
- **Tests:** `components/__tests__/draftLiveSync.test.ts` — new `resolveChampSelectEntry` suite: fresh mount into ChampSelect, real-phase→ChampSelect entry, steady-state (repeated ChampSelect ticks) never re-fires, leave-then-reenter (the exact "game 2" repro) fires again, a null blip alone changes nothing, a single-tick null blip MID champ-select does NOT count as re-entry (`ChampSelect → null → ChampSelect`), a null blip DURING a real transition still lets the transition resolve once a real tick lands (`Lobby → null → ChampSelect`), and a non-ChampSelect phase change is never an entry. 8 new tests.

### Fixed — Suggested bans surfaced sub-1000-game fringe rows outranking well-sampled counters (user directive: "dont put champs with less than 1000 games in Suggested bans")
- **Live repro:** hovering Viktor (mid) surfaced Singed (`n=463`), Zilean (`n=534`), Nunu (`n=897`), Kayle (`n=612`) in Suggested bans, all ranked ABOVE Xerath (`n=16547`) — the ban pool's `POOL_MIN_TOTAL_GAMES=5000` floor only gates a champion's AGGREGATE games across every opponent, not the specific hover-vs-target matchup sample the ban score and displayed `n=` are actually computed from, so a genuine-but-tiny-sample disadvantage could out-score a well-sampled one on raw shrunk-delta magnitude.
- **Fix:** `lib/draft/score.ts`'s `rankBans` now excludes any ban candidate whose matchup vs the hovered champion has fewer than a new `BAN_MIN_MATCHUP_GAMES = 1000` games — entirely, not merely flagged "low confidence" (same threshold value as `PLAY_MAIN_SAMPLE_FLOOR`, but a separate named constant since it gates a different axis: the hover-vs-target matchup, not the direct-lane-opponent matchup). Ban formula (`disadvantage × presence`) is otherwise untouched. `app/draft/page.tsx`'s bans-empty copy updated to "No well-sampled counters" / "No well-sampled counters to your pick this patch" — `bans.length === 0` now specifically means nothing cleared the floor, never a fabricated/low-sample ban.
- **Tests:** `lib/__tests__/draft-score.test.ts` — new "ban candidate floor" suite: floor value pinned against `PLAY_MAIN_SAMPLE_FLOOR`, exactly-at-floor included, the live Singed/Xerath repro (sub-floor excluded even with a real signal, well-sampled included), just-under-floor (999) excluded, and the empty-result shape (zero candidates clear the floor → `[]`). Three pre-existing tests updated for the new floor (two previously relied on missing/sub-floor rows still appearing).

13 net new tests (1179 → 1192 passing); `verify-fix.sh` clean (tsc/lint/tests/build/sw/manifest).

## [0.39.1] — 2026-07-21 (companion unchanged at 1.5.0)
### Fixed — every /draft main-list row badged "LOW SAMPLE" even with huge direct-opponent samples
- **Prod-observed fast-follow to v0.39.0's lane-opponent fix:** with a direct lane opponent now resolving, every main-list row (e.g. Sylas `n=24030 vs lane opp`) still showed a "Low sample" badge — a headline-number/badge contradiction. Root cause: `score.ts`'s `confidence` flipped to `"low"` when **ANY** contributing matchup term was below `K=200`, including 0.2-weight (`W_OFFLANE`) off-lane terms whose contribution to `score` is already shrunk to near-nothing. Since `POOL_MIN_TOTAL_GAMES=5000 >> K`, a pooled candidate's own baseline could never trip "low" — in practice the flag was ALWAYS driven by a thin off-lane matchup (e.g. Udyr-mid, barely played in that lane), i.e. the badge was flagging exactly the noise the shrink math already neutralizes.
- **Fix (display/labeling contract, scoring formula untouched — weights/K/floor unchanged):** `confidence` now tracks only the row's DOMINANT evidence term — the direct-lane-opponent term (1.0 weight, when resolved) or the candidate's own baseline pool (when no direct opp is resolved). Off-lane terms no longer flip the flag. Main-tier rows (direct-opp `n >= PLAY_MAIN_SAMPLE_FLOOR=1000`, always `>= K`) now correctly read `normal`. Potential-tier rows (direct-opp `n` in `[N_FLOOR, PLAY_MAIN_SAMPLE_FLOOR)`) still show `low` whenever that thin direct-opp sample is itself below `K` — the badge's honest job, since the direct-opp term IS the dominant evidence there.
- **Tests:** `lib/__tests__/draft-score.test.ts` — the audit-P1-1 pinned test at the old "confidence is low iff ANY contributing term has n<K" contract is superseded (kept, retitled, re-asserted to `"normal"`, with a comment explaining why); two new tests pin the new contract directly: a main-tier row (fat direct-opp + thin off-lane term) → `normal`, and a potential-tier row (thin direct-opp term) → `low`. 1179 tests passing (baseline 1177 + 2 net new); `verify-fix.sh` clean.
- **Docs:** `CLAUDE.md`'s stale note that `resolveLaneOpponent` "only infers a lane opponent when pickrate is non-null, currently always null" corrected to describe the v0.39.0 `total_games` proxy + `LANE_OPP_DOMINANCE_RATIO` mechanism.

## [0.39.0] — 2026-07-21 (companion unchanged at 1.5.0)
### Fixed — /draft "Suggested picks" never changed with the enemy team (lane-opponent inference was dead)
- **Real user-reported bug** (live `/draft`, Mid, enemies Aatrox/Ahri/Udyr/Jinx): suggestions barely moved when enemies were added, because the 1.0-weight direct-lane-opponent term (`W_DIRECT`) never engaged. Only the 0.2-weight off-lane terms fired, nudging scores fractions of a percent.
- **Root cause:** `lib/draft/recommend.ts`'s `resolveLaneOpponent` inferred the direct lane opponent purely from `pickrate`, but `pickrate` is universally `null` in `draft_champ_stats` — `lib/draft/ugg.ts`'s `decodeRankingsJson` is a deliberate stub (the u.gg rankings JSON column layout was never live-verified). So the inference loop skipped every enemy (`pickrate === null → continue`) and `meta.laneOppInferred` always came back `null`. Nothing surfaced this because the UI already reflected a `null` inference as "no lane opp highlighted."
- **Fix:** inference now measures **lane presence** on one axis — known `pickrate` when it exists (contract-preserving: real pickrate takes over transparently the moment the decoder is filled in), otherwise `total_games`, the enemy's own aggregate game count in that role. `total_games` is always populated at ingest (`lib/draft/ingest.ts`) and is the **same playrate proxy the pool floor already trusts** (`POOL_MIN_TOTAL_GAMES`). A single enemy with any lane games is inferred directly; with 2+ real lane candidates a dominance guard (`LANE_OPP_DOMINANCE_RATIO = 2.0`) keeps a genuinely ambiguous two-mid lane `null` so the user taps rather than the engine force-picking a wrong 1.0-weight opponent. The `score.ts` formula (K/weights/floors) is untouched — this was only opponent *resolution*, upstream of scoring.
- **Chip affordance (`app/draft/page.tsx`):** the per-enemy "Lane opp" control now reads as a control, not a label — inactive is an outlined `+ Lane opp` pill (muted, hover-accented, `aria-label` "Mark … as your lane opponent"); an explicit tap fills it solid teal; a server-inferred opponent shows a dashed-border filled `Lane opp (inferred)` so the user sees *why* the list re-ranked and can confirm or override. `aria-pressed` reflects the on/off state.
- **Explainer copy (user's explicit request):** one muted line under "Suggested picks" explaining what the ranking means, adapting to mode — no enemies: "each champion's own win rate in this lane on the current patch"; enemies + resolved opponent: "adjusted by matchup records against the enemy team — weighted heaviest against your lane opponent (X)". "Suggested bans" line reworded to "champions most likely to beat your pick in this lane — ranked by how hard they counter you and how often they're played."
- **Tests:** `lib/__tests__/draft-recommend.test.ts` — new `total_games` proxy-inference suite pins the user's exact 4-enemy Mid case → infers Ahri (103), a single-candidate lane, the ambiguous two-comparable-mids case → stays `null`, the 2× dominance boundary, and presence ties → `null`; the two pre-existing inference tests updated to the `pickrate, total_games` query shape. 1177 tests passing (baseline 1172 + 5 net new); `verify-fix.sh` clean.
- **Found-not-fixed:** when NO direct lane opponent is resolved (empty or genuinely ambiguous enemies), a row's displayed `n=` falls back to `play.minGames`, which tracks the *smallest contributing sample* — so a thin 0.2-weighted off-lane matchup term (e.g. 32 games) can surface as an `n=32` "Low sample" headline even though the champion's own pool is 5,000+ games. It's display-honest but misleading, and it is NOT the v0.37.4 main/potential split degrading — that split's 1,000-game floor is defined relative to the direct opponent and correctly doesn't apply when there is none. The primary fix moots this for the user's actual scenario (a lane opponent now resolves, so `winVsLaneOppGames` becomes the headline `n`). Proposal (not done, display-semantics judgment call): when no direct opponent is resolved, show the champion's own pool `total_games` as the headline `n` and reserve the "Low sample" flag for the pool sample, surfacing any thin off-lane adjustment as separate subtle subtext.

## [0.38.2] — 2026-07-21 (companion unchanged at 1.5.0)
### Fixed — Stormraider's Surge keystone icon showed a fallback glyph on the BUILD tab
- User-reported: the keystone rendered as a letter glyph ("S") in the Runes & Summoners card. Root cause: `lib/staticData.ts`'s `runeIconUrl` still trusted the coachless rune bundle's Icon path for id 8230, which is the stale pre-rework `…/PhaseRush/PhaseRush.png` path — it 403s on the CDN. The v0.13.0 special case (`StormraidersSurgeRuneIcon2.webp`) was only ever added to `components/proAssets.ts` (pro-play surfaces), so the BUILD tab's resolver was missed.
- Fix: mirrored the same special case in `runeIconUrl` (alongside the existing Deathfire Touch 8992 one). New pure test suite `lib/__tests__/staticData.runeIconUrl.test.ts` (4 tests) pins both special cases, the .png→.webp rewrite, and the empty-path degrade. 1172 tests passing.

## [0.38.1] — 2026-07-21 (companion 1.4.1 -> **1.5.0 — re-run the install one-liner**)
### Fixed — champ select silently failed to open the Builds page when ANY other CoachBuild tab was open
- **Real user-reported bug (Practice Tool, queue-agnostic):** entering champ select didn't open `/`'s live setup if the user had, say, `/live-setup` open in another tab. Root cause: `CompanionProvider.tsx` (mounted app-wide since the v0.37 lift) polls `/status` from EVERY route once a session token exists, but `companion.ps1`'s `Test-CompanionHasAttachedTab` treated ANY recent poll (`LastStatusPollAt` fresh within 8s) as proof a tab would live-follow the champion change, so it skipped `Start-Process` — even though only `/` and `/draft` actually react to a live champ-select update. The debounce state (`LastOpenedChampId`) still advanced, so the same champion never re-triggered even after the non-following tab closed.
- **Fix:** `components/live/companionClient.ts`'s `getStatus`/`probeCompanion`/`refreshStatus` gain an optional `follow` flag that appends `&follow=1` to the `/status` request; new pure `isFollowCapableRoute(pathname)` exact-matches `/` and `/draft` only (no prefix matching). `CompanionProvider.tsx` reads the current route via `usePathname()` into a ref (updated on navigation, but deliberately NOT added to the poll effect's own `[session]` dependency array — a route change must not restart the poll interval or perturb the tick cadence the Round-B P1 fix depends on) and passes it to `refreshStatus` on every tick.
- `public/companion.ps1` (**companion 1.5.0**): the bridge now stamps a NEW field, `$Sync.LastFollowPollAt`, only when the request carries `follow=1` (`$Sync.LastStatusPollAt` keeps stamping on every `/status` poll unconditionally, for other diagnostics). `Test-CompanionHasAttachedTab` now gates on `LastFollowPollAt` instead. Back-compat is a deliberate degrade: a new companion talking to a STALE cached web build that never sends `follow=1` sees `LastFollowPollAt` stay `$null` forever, so it always opens a fresh tab (pre-v1.3.0 behavior) rather than silently suppressing — correctness over the live-follow optimization when the two sides disagree on the contract.
- **Users must re-run the companion install one-liner** to pick up 1.5.0 — the web side alone degrades safely (always-open) against an old companion, but the fix (no more false-suppression) only lands once both sides are updated.
- Champion-resolution fallback (3-way championId -> pickIntent -> actions) is unchanged — this ship only touches which query string the poll sends and which field the bridge reads back.
- **Tests:** `components/__tests__/companionClient.test.ts` — new `isFollowCapableRoute` suite (`/` and `/draft` true, every other route incl. the reported `/live-setup` false, no prefix-match, null/undefined-safe) and a `follow=1` query-param plumbing suite covering `getStatus`/`refreshStatus`/`probeCompanion`. Companion side: extended the existing `-Mock` attached-tab-gate block (companion.ps1) with a case simulating a non-follow-capable poll (`LastStatusPollAt` fresh, `LastFollowPollAt` untouched) asserting the open is NOT suppressed — this is the exact regression the ship fixes. Both `-SelfTest` and `-Mock` harnesses pass locally (`powershell -File public/companion.ps1 -SelfTest` / `-Mock`).
- 1168 tests passing (baseline 1123 stated at dispatch was stale; actual pre-ship baseline was 1158 + 10 net new companionClient tests), `tsc -b`/`next lint`/`next build`/`verify-fix.sh` clean.

## [0.38.0] — 2026-07-21 (companion unchanged at 1.4.1)
### Added — "My Stats" personal match tracker (backend + UI, combined ship)
- New `/mystats` page: your own recorded League history, backfilled from Riot match-v5 for one linked account (`MunsterHunter#EUW`, overridable via `MY_RIOT_ID`/`MY_RIOT_REGION`). Header shows the linked riot id + a **"Season 2026"** label + overall games/winrate; a per-champion table (icon, lane, games, W-L, winrate, sorted by games played — server order, never re-sorted client-side) mutes rows under 10 games as "Low sample" rather than hiding them. Tapping a row expands an inline, accessible disclosure (`aria-expanded`/`aria-controls`, always-mounted `hidden` region) showing your matchups on that champion, grouped by lane opponent (`GET /api/mystats/matchups`). Graceful states throughout: account-not-linked-yet, zero games this season, and a fetch-error panel — no bare spinners or silent blank screens.
- **HARD USER DIRECTIVE (ratified 2026-07-21, "Don't mix my data with the sample size"):** this is DISPLAY-ONLY data, scoped to the CURRENT SEASON only. Nothing on `/mystats` or the Draft integration below computes a score or reorders anything by outcome — see `lib/draft/recommend.ts`'s `PersonalPlayResult` doc comment, `components/hextech/myStats.ts`'s header, and `components/live/personalBadge.ts`'s header, all of which encode this directive directly in code, not just here.
- **Backend** (engy, `lib/mystats/**`, migration `0012_mystats.sql`, `app/api/mystats/{summary,matchups}`, `app/api/ingest/mystats`, new 20:00 UTC cron): Riot match-v5 backfill (unfiltered by queue) into `coachbuild.my_matches`, aggregated server-side (`summarizeByChampion`/`summarizeMatchupsByOpponent`/`summarizeMatchup`) with a season boundary (`SEASON_START_MS` = patch 26.1/16.1's 2026-01-08 release, `lib/mystats/season.ts`) enforced at both the Riot list-fetch (`startTime`) and row-insert layer, plus a one-time purge (`lib/mystats/purge.ts`) of any pre-season rows ingested before the boundary existed. Both routes are `no-store` unconditionally — private per-user data, never CDN-cached (CLAUDE.md gotcha (b)). `riotId` added to `/api/mystats/summary`'s response (additive, fronty's UI round) so the page header can show which account the data belongs to without a second endpoint.
- **Draft integration** (`app/draft/page.tsx`, `components/hextech/DraftResultRow.tsx`): `/api/draft/recommend` candidates now additively carry `personal` (my record vs the resolved lane opponent specifically, null when no lane opponent or never played that exact matchup) and `personalOverall` (my record on that champion in this lane vs anyone, always populated). Rows with real personal data get a small muted badge — "you: 8-3" (vs lane opponent) and/or "you: 25W-14L overall" — visually distinct from the aggregate WPA score (muted chip, not the green/red winrate color), with a tooltip reiterating the no-blending directive. Rows without personal data get nothing (no clutter). New **"My pool"** toggle filters both the main and potential-counter lists to champions with `personalOverall.games >= 1` — a pure FILTER (`components/live/personalBadge.ts`'s `filterToMyPool`), never a re-scorer: surviving rows keep the server's exact ranking order.
- Nav: "My Stats" added to `TabNav` and both Sidebar render sites (expanded footer + collapsed mobile strip).
- **Tests:** new `components/__tests__/myStats.test.ts` (normalizers, role labels, low-sample threshold boundary, no-re-sort pin, overall totals incl. zero-games/no-NaN), `components/__tests__/personalBadge.test.ts` (badge render-model incl. vs-only/overall-only/both/neither, my-pool filter incl. order-preservation), extended `components/__tests__/draftRecommend.test.ts` (personal/personalOverall parsing, graceful degradation on an older cached response, a record missing its `wins` half is treated as fully absent rather than coerced). `lib/__tests__/mystats-routes.test.ts` extended for the new `riotId` field.
- Full suite passing (baseline 1123 + this round's additions), `tsc --noEmit`/`next build`/`next lint` clean via `verify-fix.sh`. Companion untouched (1.4.1).

## [0.37.4] — 2026-07-21 (companion unchanged at 1.4.1)
### Added — Sample-size split for PLAY recommendations (main "Top counters" vs "Potential counters")
- When a direct lane opponent is resolved (explicit `laneOpp` param or server-inferred), `/api/draft/recommend` now partitions candidates by matchup sample size specifically against that opponent, rather than one flat top-10: `plays` (back-compat field name) becomes the "main" list — top 10 among candidates with **>= 1,000 games** vs the lane opponent; a new `potentialPlays` (top 5) holds candidates with **30-999 games** (still subject to the existing N_FLOOR=30 scoring floor, same scoring formula as `plays`). Candidates with **no matchup row** vs the opponent (or under 30 games) are excluded from BOTH lists when a lane opponent is resolved — no evidence means no listing, not a listing built on off-lane evidence alone. When no lane opponent is resolved (no enemies, or no enemy has a known pickrate), behavior is byte-identical to before: single `plays` list, `potentialPlays: []`, existing 5,000-total-games pool floor unchanged.
- `lib/draft/score.ts`: new `splitPlaysBySampleSize` (pure, exported) reuses the EXACT same scoring core as `rankPlays` (extracted into a private `computeScoredPool` helper) — this is a post-scoring partition, never a second scoring pass, and `rankPlays` itself is untouched (still used as-is for the no-lane-opponent case, and by its own exhaustive test suite). New `winVsLaneOppGames` field on `PlayResult` — the direct-opponent matchup row's own game count, deliberately kept separate from `minGames` (which can be pulled down by a smaller off-lane term or the candidate's own baseline sample and is therefore NOT a reliable stand-in for "games behind this specific matchup").
- `lib/draft/recommend.ts`: `computeDraftRecommend` calls the new splitter instead of `rankPlays`; `attachPersonalRecords` (My Stats decoration) extended to decorate both lists from one combined query, never two round-trips. `RecommendResult` gains `potentialPlays` (always present, empty on every pre-v0.37.4 code path).
- `components/live/draftRecommend.ts`: client type/normalizer gain `potentialPlays` and `winVsLaneOppGames` — both default to `[]`/`null` when absent (an older cached response, or a response from before this ship, can't crash the client over a field it doesn't know about).
- `app/draft/page.tsx`: new "Potential counters" section below the existing "Suggested picks" list, with an explicit low-sample framing line ("promising but under 1,000 games — treat as leads, not conclusions"). The "no data for this lane" empty state now correctly checks BOTH lists (a laneOpp-resolved response can legitimately have an empty main list while still having real potential-counter leads).
- **Two real bugs would have shipped without live-validating against the corrected DB first** (same discipline as v0.37.3's lolalytics tripwire): the acceptance query was cross-checked against `computeDraftRecommend` called directly, not a hand-derived reimplementation — verifying the ACTUAL code path, catching anything a parallel-but-slightly-different calculation could have silently missed.
- **Live-validated `lane=2&enemies=112&laneOpp=112` (Viktor mid), exact match to the precomputed acceptance table:** main leads Xerath (52.6%, n=16547) / Vel'Koz (51.9%, n=2268) / Syndra (51.5%, n=20235) / Kassadin (51.5%, n=5014) / Fizz (51.4%, n=9299); potential = Singed (60.3%, n=463) / Zilean (55.2%, n=534) / Nunu & Willump (54.3%, n=897) / Kayle (53.3%, n=612) / Gwen (52.4%, n=496). Zero material differences from what was precomputed.
- 1123 tests passing (baseline 1084 + 39 net: split-boundary partition tests, no-laneOpp-unchanged pin, empty-potential, no-evidence exclusion, personal-record decoration on both lists, client normalizer defaults), `tsc --noEmit`/`verify-fix.sh` clean.

## [0.37.3] — 2026-07-21 (companion unchanged at 1.4.1)
### Added — EXTERNAL matchup-direction tripwire (`lib/draft/lolalyticsCheck.ts`)
- `lib/draft/ingestGuard.ts`'s two checks (cross-source baseline panel vs coachless, internal symmetry) verify baselines and decode/keying integrity, but neither verifies matchup **direction** against a third source that itself publishes per-matchup winrates — a future opp-id keying bug could pass both. New check fetches lolalytics's SSR counters pages for a fixed 3-champion panel (Viktor/mid, Garen/top, Jinx/bot — one per lane, politeness: 3 requests total), parses the page-owner's own `"{champ} wins against {opp} {pct}%"` text (tolerant regex over the Qwik-SSR markup), and compares against our `draft_matchup` rows with n≥1000 games. FAIL (direction/keying signature) blocks retention exactly like the existing guard; **indeterminate** (lolalytics markup changed, or too few high-sample matchups were comparable) logs loudly but never blocks — this guards a third party's page shape, not a hard dependency.
- Wired into `lib/draft/ingest.ts`'s final-cursor path (after the existing guard + symmetry check) and `scripts/ingest-draft.mjs`'s bootstrap summary/exit-code.
- **Two real bugs caught by live-validating against the corrected DB before shipping (never assume a spec is right until probed against the actual feed):**
  1. **Patch drift produced false positives.** lolalytics defaults to ITS current patch (16.14) with no pin; our ingest sat one patch behind (16.13) — a perfectly ordinary, expected state for a bounded per-invocation batch walk. Comparing across that one-patch gap alone produced 18 same-direction (not complement-shaped — proof it wasn't a real keying bug) disagreements from ordinary patch-to-patch balance drift. Fixed by pinning `&patch=<ours>` on every fetched URL (lolalytics supports this param, verified live) — the real invariant is "compare the same patch on both sides", not "always compare against lolalytics' newest".
  2. **A flat "≥2 disagreements" count doesn't scale.** Real counters pages return 100+ opponents each — a single run produced 157 real high-sample comparisons even after the patch fix, and ordinary cross-source noise (different tier/rank-cut composition) put 3 matchups a hair over the 4pt tolerance at the sample-size floor's edge. 3 ≥ 2 would have FAILED every real run. Fixed by requiring BOTH the ≥2 floor AND a >10% disagreement RATE — a genuine perspective inversion clears both by a wide margin regardless of panel size (near-universal disagreement, not 3 edge cases); ordinary noise clears neither.
- Fixture-driven tests (`lib/__tests__/draft-lolalyticsCheck.test.ts`, 21 tests): parse extraction from a real trimmed HTML sample, HTML-entity decoding, a synthetically-inverted fixture that FAILS, a mangled/broken-markup fixture that degrades to indeterminate without throwing, the patch-pin regression, and the fail-rate scaling regression.
- **Live-validated against the corrected DB, post-fix: PASS** — 157/157 comparisons, 3 disagreements (1.9%, below the 10% fail-rate threshold). See HANDOFF-engo.md for the full comparison table.
- 1084 tests passing (baseline 1022 + Draft mystats-branch additions), `tsc --noEmit` clean.

## [0.37.2] — 2026-07-21 (companion unchanged at 1.4.1)
### Fixed — P0: u.gg matchup perspective was inverted (user-caught, external + internal evidence)
- **Every draft matchup/baseline stored since launch (0.37.0's bootstrap + the scheduled full refresh) was mirror-flipped.** `wins` in champion X's OWN u.gg matchups file is the OPPONENT's wins in that row, not X's — the decoder took it at face value. Caught by a user comparing our output against a lolalytics screenshot: Viktor mid's real worst matchups lose at ~48-50%, while we showed "counters" beating him at 58-64%, and the list was off-meta marksmen — exactly what a control mage actually farms, read backwards. Confirmed internally: Mel mid's derived baseline was 54.6% against a real ~44.8%; Ashe support 55.2% against a real ~43.7% — near-exact complements. The bootstrap's own `wins<=games` invariant and the original research anchor (Aatrox vs Mordekaiser "52.02%") both hold true under either perspective and never could have caught this — that figure was actually Mordekaiser's winrate, not Aatrox's (real: 47.98%).
- **Fix (no re-fetch needed):** `coachbuild.draft_matchup.wins` corrected in place (`wins = games - wins`), `draft_champ_stats.winrate` re-derived from the corrected rows (games-weighted, same derivation as ingest — not a blind `1 - old_value`). `lib/draft/ugg.ts`'s decoder now flips `rawWins` at decode time for all future ingests, with the u.gg row semantics documented loudly in code. `_research/counterpick-research.md` corrected with an honest addendum (original claim + why it looked verified).
- **Permanent guard (the actual fix for "how did this happen"):** `lib/draft/ingestGuard.ts` adds two independent checks that now gate retention on every ingest's final cursor — (1) a 20-champion, all-5-role cross-source panel comparing draft baselines against `lib/heroStats.ts`'s coachless data (a genuinely separate upstream), failing loudly on >4-point drift; (2) an internal symmetry check (wr(A,B)+wr(B,A)≈100%) that catches decode/keying corruption — explicitly documented as NOT a substitute for (1), since a uniform inversion passes symmetry trivially (both numbers wrong, sum still ~100%). A guard failure skips retention (never prunes the last known-good patch) and surfaces the specific failing comparisons.
- **Post-fix verification:** all 20 cross-source panel entries pass (max delta 0.7 points, all far inside the 4-point tolerance); 100/100 symmetry pairs pass; per-role correlation between draft baselines and coachless ground truth is r=0.88-0.997 across all 5 roles; per-role mean matchup winrate lands at ~50.0% for every role (25186/15558/23046/15660/21602 rows); exactly one `wr>62%, n>1000` outlier survives (Nasus vs Naafiri in the jungle bucket, 63.1% @ n=5029 — a niche off-role pairing, flagged for visibility, not a systemic pattern).
- **Prod acceptance — corrected Viktor mid (`lane=2&enemies=112&laneOpp=112`):** top-10 is now Singed/Zilean/Nunu/Kayle/Xerath/Gwen/Vel'Koz/Master Yi/Garen/Syndra — real mid-relevant control-mage matchups, zero marksmen, scores 51.5-58.5%. Bans (`hover=112`) show real Viktor threats with genuine per-target sample sizes.
- 1022 tests passing (baseline 1003), `tsc --noEmit` clean.

## [0.37.1] — 2026-07-21 (companion 1.4.1)
### Fixed — Round B fix wave (re-verified against current code post-Draft/CompanionProvider lift)
- **P2 follow-fights-user:** during champ select, manually browsing to a different champion got snapped back to the champ-select champion on the NEXT poll tick, every tick, for as long as the user kept browsing away — the live-follow effect re-asserted whenever the resolved champ-select champion differed from whatever the page was CURRENTLY SHOWING, which a manual browse permanently diverges. Fixed by tracking the last champ-select championId the follow effect actually acted on (`champSelectFollowState.ts`'s new `shouldFollowChampSelectChange`/`markFollowedChampSelectChampion`) and re-asserting ONLY when that changes — a genuine new hover/lock, never a manual browse away from an unchanged pick. `components/live/champSelectFollow.ts` gained `resolveChampSelectRoleId` (split out for this); `app/page.tsx`'s follow effect rewired to the new gate.
- **P2 LivePanel churn:** the in-game live-client-data poll re-rendered the whole panel subtree every tick for a roster that's fixed all game. Slowed `LIVE_POLL_MS` 1000ms → 3000ms and added a shallow-compare skip (`livePanelModel.ts`'s new `sameLivePanelModel`) so `setModel` is a no-op whenever the derived enemy set is unchanged — belt and braces, no timers/cooldowns in this data by design.
- **P3 companion CIM cost:** `Get-LcuCredentials` (Get-CimInstance) ran on every 1.5s gameflow poll tick, all game. Now cached after first discovery (`Get-LcuCredentialsCached`/`Clear-LcuCredentialsCache`) and only re-discovered when the cache is empty or an LCU call fails with connection-refused/401 (client restarted or rotated its token). Companion → **1.4.1**.
- **Dead code:** deleted `isAutoExportEligibleBuild` (`autoExportShared.ts`) — the P1 wrong-champion-race guard superseded by `isCompanionDrivenChampion` since the v1.3.0 rewrite, re-confirmed zero call sites post-Draft via repo-wide grep — plus its re-export in `itemSetsApply.ts` and its orphaned regression tests.
- **P3 transient-probe-failure marks-as-done:** the auto-export dedup used to mark a (champion, lane) as exported BEFORE the attempt even started — a transient "companion not connected yet" permanently burned that dedup slot with nothing actually exported. `markAutoExported` now fires after the attempt resolves, gated on `outcome.attempted`, for both item sets and runes in `BuildTabContent.tsx`; the existing `tryClaimAutoExportLock` localStorage TTL already prevents a double-fire in the async window, so no separate in-flight flag was needed.
- **P3 stale toast champion name:** an item/rune export toast could keep showing for its full 6s window after the user had already moved to a different champion/lane. Both toasts now clear immediately on champion/lane change.
- **P3 LivePanel bundle size:** code-split via `next/dynamic` (`ssr: false`) — most page loads never mount it at all.
- **Draft stale-patch honesty:** `/draft` now shows a one-line notice when the served draft data (`meta.patch`) is behind the patch the rest of the app considers current (`meta.currentPatch`, new field from `lib/draft/recommend.ts`'s live `getLatestPatch()` resolution) — the daily ingest cron is Cloudflare-blocked from reaching u.gg on Vercel's egress IP (see the "Vercel-egress probe of stats2" finding), so the two can diverge for days with only a manual `npm run ingest:draft` to close the gap. Surfaces honestly instead of silently serving old numbers with no signal.
- 1003 tests passing (baseline 973), `tsc --noEmit`/`tsc -b` clean, companion SelfTest/Mock/HarnessTest all PASSED.

## [0.37.0] — 2026-07-21
### Added — "Draft" champ-select recommender (`/draft`, companion 1.4.0)
- New page suggesting statistically-favored PLAY and BAN champions for a lane, conditioned on the enemies you've entered (manual picker, or auto-filled live from champ select via the companion). Sourced from u.gg's stats2 CDN (matchup + rankings data, one tier — Emerald+ — for v1), ingested into `coachbuild.draft_matchup`/`draft_champ_stats` and scored with a shrinkage-toward-baseline model (`n/(n+K)`, K=200, floor 30 games) that isolates a matchup's real effect from a champion's own baseline strength. Direct-lane-opponent weighting (1.0x) vs off-lane enemies (0.2x); bans rank by disadvantage-magnitude × pick/ban presence.
- Companion bumped to **1.4.0**: champ-select snapshot gains `theirTeam` (enemy championIds, IDs only — never names) and `timerPhase`, feeding `/draft`'s live auto-fill.
- Compliance: IDs/champion-names only, zero summoner names; copy framed as suggestions, never "pick this"; `/draft` never POSTs to the companion (no auto-pick).
- Full patch bootstrap completed pre-ship: 173/173 champions, ~101K matchup rows, zero `wins>games` violations.

### Fixed — pre-ship audit patch round (ship-after-patch verdict)
- **P1-1 (default-screen garbage):** the pool had NO working filter — pickrate is null until the rankings decoder is filled in (see below), so `filterPoolByPickrate` alone was a complete no-op, letting a handful-of-games off-role artifact (e.g. a 128-game sample) out-rank real lane staples on baseline winrate alone. Added a `total_games` column (`coachbuild.draft_champ_stats`, backfilled from already-ingested matchup data) and a 5,000-total-games playrate-PROXY floor (`filterPoolByTotalGames`) that trims the pool to genuinely well-sampled champions per lane — live-verified: no low-sample artifacts across any of the 5 lanes post-fix, all remaining candidates carry 5,000+ games. Also fixed the empty-enemies (pure baseline) ranking path, which previously reported a blanket "normal" confidence with no sample size at all — a play's `minGames`/`confidence` now always reflect at least the candidate's own baseline sample.
- **P1-2 (ingest cron never progressed):** the daily cron called `/api/ingest/draft` with no cursor, so every invocation restarted the ~40-champion bounded walk from scratch and discarded `nextCursor` — a mid-ingest patch would strand on a small partial pool forever. Added a one-row persisted cursor (`coachbuild.draft_ingest_cursor`, migration `0010_draft_audit_patches.sql`): a cursorless (real cron) request now reads/advances/wraps it; an explicit `?cursor=` (manual/debug driving) still overrides without touching the persisted state.
- **P2-1 (lane-opponent auto-detect systematically wrong):** live mode inferred the direct lane opponent as `theirTeam[roleId]` — but the companion's `theirTeam` array is COMPACTED (unresolved enemy slots omitted, not left as holes — provable from the companion's own SelfTest fixture), so index stopped matching role the moment any earlier enemy went unresolved, which is the common case mid-draft. Removed the index-based inference entirely; live mode now sends enemies with no explicit lane-opponent tag and relies on the server's own statistical inference (`meta.laneOppInferred`) plus the user's manual chip tap — both already worked correctly. The enemy-chip "lane opp" highlight now reflects whichever of (explicit tag, server inference) applies, never a client-side guess.
- **P2-2 (every ban showed "Low sample n=0"):** `rankBans` never computed `confidence`/`minGames` at all — the client's defensive normalizer silently fabricated "low"/`0` for every single ban regardless of real data. Both are now derived from the actual hover-vs-target matchup row (`row.games`), with a genuinely absent row reporting `null`, never a fake zero.
- **P2-3 (ban score rendered as a green win-percentage):** a ban's score is a priority MAGNITUDE (~0.02-0.07 observed), not a winrate — showing it as `pct()` in the same green style as a play's winrate read as a fabricated "2-7% winrate." Bans now render as a relative priority bar (scaled against a documented ceiling) plus the raw score as small subtext, never a percentage.
- **P3-1 (serving-patch completeness):** `resolveServingPatch` now prefers the most-recently-ingested patch that has already reached ≥120 distinct champions in `draft_champ_stats`, falling back to the newest patch present only when none clear that bar yet — a brand-new patch mid-ingest can no longer take over serving from a genuinely complete older one. Bans section also gained a scope-note caption ("bans that counter your pick in your lane").
- 986 tests passing (baseline 973), `tsc --noEmit` clean.

## [0.36.1] — 2026-07-21
### Fixed
- **First-champ-select-of-a-session auto-export race (Round-B audit P1).** On a companion-opened fresh tab, if the page's champion resolution won the network race against the first companion status poll, the poll's champ-select entry-clear wiped the "companion-driven" mark and nothing re-established it — both item-set and rune auto-exports then silently skipped for that entire champ select (no error, manual buttons unaffected). The mark is now re-established unconditionally on every status tick that resolves a champ-select champion, making the auto-export gate deterministic regardless of fetch ordering. Attached-tab (page already open) sessions were never affected.

## [0.36.0] — 2026-07-20 (web-only — companion unchanged at 1.3.1)
### Fixed — lane flip never re-exported RUNES (root cause: a React stale-closure race, not the dedup logic)
- **User on-device evidence: flipping Ashe Bot → Support left the client's selected rune page on "CoachBuild Ashe Bot."** Root cause was NOT in v0.35.0's lane-aware dedup itself — it was a real race between `BuildTabContent.tsx`'s two effects sharing `state`/`lane`: `lane` updates the INSTANT the user flips (`Sidebar`'s `onLaneChange`, synchronous), but `state.build` only catches up once the new lane's `/api/build` fetch resolves. React runs every changed-deps effect for a commit using THAT render's own closure, without waiting for a state update an earlier effect in the same commit just scheduled — so on the very first re-render after a flip, the auto-export effect could see the PREVIOUS lane's resolved build (`state`) paired with the ALREADY-updated `lane` prop. Exporting against that mismatched pair silently "used up" the new lane's dedup slot with the OLD lane's data, permanently blocking the real export once the correct build resolved a moment later.
- Fixed with a new pure guard, `heroContracts.ts`'s `isBuildForLane(build.role, lane)`: the auto-export effect now returns early whenever the fetched build's own resolved role doesn't match the CURRENT `lane` prop, so it can only ever act once they're genuinely in sync. Pinned with a unit test replaying the exact failure sequence (stale-build/fresh-lane render is a no-op for BOTH kinds; the real build's render still fires for both once it resolves).
- Investigated and ruled out (with evidence, not assumption): `runeAutoApply.ts` carries no dedup of its own (thin wrapper only); the auto-runes gate/toggle logic is byte-for-byte symmetric with items'; the companion's `Invoke-ApplyRunes` already replaces ANY existing CoachBuild page in either mode (verified via its own SelfTest), so this was never a companion-side gap.

### Fixed — a non-full item (Dark Seal) could reach a 6-item build LINE
- **User report: Dark Seal (a stackable component that upgrades into Mejai's Soulstealer) showed up via pro-consensus data in a build line.** Root cause: `proConsensus.ts`'s `aggregateProConsensus` deliberately allowlists Dark Seal (and Cull, Tear of the Goddess, Doran's items, the support starters) as "counts as a build choice" for the Pro Consensus CARD's own "what do pros keep all game" display — correct there, but that same allowlist-inclusive data also fed `itemSetBody.ts`'s Pro build line, where a stacking/starting item has no business sitting in a "buy this next" shop-panel slot.
- Added a narrower, build-line-specific `isFullItem` check (real ddragon tag/`into`/`from`/`purchasable` metadata, confirmed against a live `item.json` pull rather than invented) that does NOT consult that allowlist: an item counts as "full" only when it's a genuine recipe-tree leaf (`into` empty) or a legitimate finished boots (mirrors `proConsensus.ts`'s own tier-2-boots special case). No metadata at all for an id degrades to EXCLUDE (never assume it's finished) — a deliberate tradeoff, documented in `isFullItem`'s own comment: correctness over completeness for a line the player will actually shop-click against. Applies to every 6-item build line (Core/Buy order/Pro/the new themed lines below); Starting and Situational swaps are UNCHANGED — a stacking/starting item is exactly where it belongs in either.
- `itemSetsApply.ts` now resolves item metadata (`resolveItemMetaForSets`, reusing `itemDetail.ts`'s already-memoized `getItemDetailMap` — no extra network cost) in parallel with pro-consensus data and threads it into `buildItemSets`.
- Found and closed a related edge case while wiring this up: a "Buy order"/"Pro build" block could previously ship with ZERO items if every one of its candidates happened to fail the new full-item filter (e.g. a totally degraded metadata fetch) — the data-availability gate (`resolveOptimizedPathView`/`hasPro`) was independent of content. Both blocks are now only pushed when their resulting line is non-empty.

### Changed — "Optimized order" renamed to "Buy order"
- User: "that doesn't make sense." It's the conditioned buy SEQUENCE, not a competing alternative build. Block-`type` string only — `optimizedPath.ts`'s underlying data/logic (shared with `CoreBuildOrderCard`'s own UI) is untouched.

### Added — three themed build lines: Highest WPA, Tanky, Burst
- Derived entirely from existing data already in hand (core/buy-order/situational/pro-consensus pools) — no new upstream fetch. Tag vocabulary confirmed against a live `item.json` pull (16.13.1), not invented: **Tanky** = Health/Armor/SpellBlock-tagged; **Burst** = SpellDamage/Damage/ArmorPenetration/MagicPenetration-tagged (ddragon has no "Lethality" tag — real Lethality-class items are tagged ArmorPenetration, the closest real substitute); **Highest WPA** = no tag filter, top-6 by weight across the whole pool.
- Each line: top-6 by weight (wpa/share, this module's existing shared ranking axis) within the theme, full-items-only (same rule as above), exactly one boots (preferred from WITHIN the theme when one exists, else the overall best boots — never zero boots when any exist in the wider pool). A themed line is OMITTED ENTIRELY (never padded with off-theme items) when fewer than 4 qualifying candidates exist.
- Block order: Starting, Core build, Buy order (if it differs), Pro build, Highest WPA, Tanky, Burst, Situational swaps.
- Tests: `itemSetBody.test.ts` rewritten with real `ItemDetail` fixtures throughout (the full-items rule needs them), Dark Seal regressions pinned in Core/Pro/Situational/themed-line contexts, themed-line construction + the ≥4-item omission boundary + boots-preference rules; `itemSetsApply.test.ts` updated for the item-metadata wiring (incl. a total-fetch-failure degradation case); new `heroContracts.test.ts`/`champSelectFollowState.test.ts` coverage for `isBuildForLane` and the full lane-flip effect sequence. 867 tests passing (baseline 851).

## [0.35.0] — 2026-07-20
### Fixed — lane flip mid-champ-select left auto-export on the OLD lane's build (companion v1.3.1)
- **User on-device evidence: during a live Senna champ select, switching from Bot to Support left BOTH auto-export writes on the Bot build** — the auto-export dedup keyed only on `championId`, so a lane change on the SAME companion-driven champion never re-fired (`hasAppliedForChampion` was already true from the first lane). Fixed: `components/live/champSelectFollowState.ts` generalizes the dedup key to `(championId, laneId)` per kind, tracking the single most-recently-exported pair and re-firing whenever the current pair differs ("latest wins" — correctly handles a same-champion lane bounce Bot → Support → Bot, re-firing on every genuine change). The re-fire is additionally gated on the companion's OWN live champ-select resolution (`isInChampSelect()` + a new `currentChampSelectChampionId`, fed every poll tick by `app/page.tsx` via `champSelectFollow.ts`'s new `resolveCurrentChampSelectChampionId`) so browsing back to an old companion-driven pick after champ select has ended doesn't also re-export. The multi-tab localStorage lock gained `laneId` in its key for the same reason (a lock claimed for one lane must never starve a legitimate re-fire for a different one).
- **Champ-scoped stale-set cleanup (companion 1.3.1 required):** even before this fix, a lane flip's item-set write left the OLD lane's LCU set behind too (e.g. both "CoachBuild Senna Bot" and "CoachBuild Senna Support" would exist) — the companion's stale-removal prefix was derived from the NEW set's own (role-scoped) title. Web now sends an explicit, CHAMP-SCOPED `replacePrefix` (`CoachBuild <champ> ` — trailing space load-bearing, so "CoachBuild Vi " never matches "CoachBuild Viktor ...") on every `/apply-itemsets` call (`itemSetBody.ts`'s `champScopedReplacePrefix`); the companion validates it starts with "CoachBuild" (same defense-in-depth as titles) and uses it for stale-removal instead of deriving one, removing both the old-lane title AND any lingering old-3-set-era title for the same champion. Back-compat both ways: an older web build omitting the field, or an older companion that doesn't read it, both fall back to the original title-derived (role-scoped) behavior.
- **Investigated a second on-device report (same Senna champ select): runes auto-exported but item sets silently did not**, despite the auto-items toggle defaulting ON. Traced the actual live/follow/dedup/lock code paths end to end — confirmed items and runes already fire through byte-identical gate/probe logic (no live asymmetry there), and confirmed `isAutoExportEligibleBuild` (the original P1 wrong-champion-race guard) has had **no call site in `BuildTabContent.tsx` since the v1.3.0 rewrite** — it's fully superseded by `isCompanionDrivenChampion`, so a stale-URL comparison couldn't have been the cause (kept exported, with a clarifying comment, only for its own pinned regression tests). The one real, verifiable asymmetry found: item sets have strictly more surface area that could throw before ever reaching the companion (an extra synchronous `buildItemSets` call after the async pro-consensus resolution) than runes, and neither promise chain in `BuildTabContent.tsx` had a `.catch()` — an uncaught rejection anywhere in the attempt would vanish completely silently (no toast, no companion call, no visible signal), which matches the report exactly. Both auto-export promise chains now end in a `.catch()` that surfaces the same visible error toast a graceful `ok:false` already would, so a future unexpected exception is never invisible again.
- Wire contract (`companionClient.ts`, `companion.ps1`) updated on both sides for `replacePrefix`; `Merge-ItemSets`/`Test-ItemSetsPayload`/`Invoke-ApplyItemSets` all updated with new SelfTest coverage (champ-scoped removal across old-lane + old-3-set-era titles, never touching a non-CoachBuild or different-champion set; a malformed `replacePrefix` rejects the whole request). Companion bumped to **1.3.1** — the user needs to quit the tray icon and re-run the install one-liner to pick this up (auto-update only shows a balloon notification; it doesn't self-replace the running process).
- Tests: `champSelectFollowState.test.ts` rewritten around the new `shouldAutoExportForLane`/`markAutoExported` model (lane-flip, A→B→A, post-champ-select-browsing, and companion-live-session-mismatch cases); `champSelectFollow.test.ts` gains `resolveCurrentChampSelectChampionId` coverage; `itemSetBody.test.ts` gains `champScopedReplacePrefix` coverage (champ-scoping, trailing-space disambiguation, old-3-set-era + old-lane title matches); `itemSetsApply.test.ts` pins `replacePrefix` on the wire body. 851 tests passing (baseline 834).

## [0.34.1] — 2026-07-20
### Changed — item sets: 1 set per champ+role, Core/Optimized/Pro as blocks (web-only, companion unchanged at v1.3.0)
- **User feedback after confirming item sets work in-game:** merge the 3 separate LCU sets (Core/Optimized/Pro) into ONE set per champion+role, with those variants as shop-panel BLOCKS ("lines") inside it instead of 3 competing sets. Title/uid drop the variant suffix: `CoachBuild <champ> <role>` / `coachbuild-<champ>-<role>`.
- **Fixed two real in-game bugs, both root-caused in `components/hextech/itemSetBody.ts`'s old per-variant builders:**
  - **A line with 2 boots.** The old Pro-set builder combined `[...pro.boots, ...pro.items]` (pro.boots can carry up to 2 entries — `proConsensus.ts`'s `TOP_BOOTS_LIMIT`) and sorted by share with no boots cap — both boots candidates could land in the same line.
  - **An Optimized line with only 3 items.** The old Optimized-set builder shipped `optimizedPath` (2-3 items by contract) completely unpadded.
  - Fix: every build line (Core, Optimized, Pro) now runs through one shared `buildLine` algorithm enforcing **exactly 6 items, exactly 1 boots, no duplicates** — dedupe → resolve boots (drop to the single highest-weight pick when >1; pull the best available boots from a fallback pool when 0) → pad from priority-ordered fallback pools (Core/Pro: optimized → situational → consensus; Optimized: the core remainder specifically, so it reads as "this build, refined order" rather than pulling in situational/pro noise) → trim to 6 if the source over-supplies. Never invents items — a genuinely sparse fixture ships what exists.
  - Boots identification is **structural, not tag-based**: `Pick` (the shape this pure builder sees) carries no `tags` field, so it can't reuse `proConsensus.ts`'s `isBootsTag`/ItemDetail-metadata check directly. Instead it builds one id set from `items.boots` (the dedicated boots slot), `items.alts?.boots` (the dedicated alternate-boots pool — same structural convention `ItemPath.tsx`'s own `isBoots` badge already uses), and `pro.boots` (already tag-partitioned upstream by `proConsensus.ts` before this module ever sees it).
- **Situational swaps** stays its own block, cap 6, deliberately EXEMPT from the one-boots rule — it's a swap-suggestion row, not a worn loadout, so multiple boots alternatives side by side is the intended shape.
- **Migration is automatic, no companion change needed:** `companion.ps1`'s `Merge-ItemSets` computes its stale-set-replacement prefix from the new set's own title, stripping only from an em dash onward — the new no-suffix title has no em dash, so the prefix IS the full title (`CoachBuild <champ> <role>`), which old suffixed titles (`... — Core`, `... — Optimized`, `... — Pro`) all still start with. They get cleaned up automatically on the player's next export. Pinned in a web-side test mirroring the PS regex.
- Toast copy updated for the 1-set reality: "Item build added" (was "N item builds added").
- `components/hextech/itemSetBody.ts` rewritten; `components/__tests__/itemSetBody.test.ts` rewritten for the new shape (regression fixtures for both live bugs); `components/__tests__/itemSetsApply.test.ts` updated for the 1-set wire shape. Companion stays at v1.3.0 (`public/companion.version` unchanged) — this is a web-only restructure, no bridge protocol change.

## [0.34.0] — 2026-07-20
### Fixed — rune-apply blocker: creation worked, SELECTION didn't (companion v1.3.0)
- **Root cause (2nd user screenshot): the created "CoachBuild &lt;champ&gt; &lt;role&gt;" page saved correctly — the client just stayed on a fresh "ADD NEW PAGE" editor instead of switching to it.** `current:true` in the POST body is evidently not sufficient to select a page in the live client. Fixed: after every successful create, the companion now `PUT`s the raw page id to `/lol-perks/v1/currentpage` (the standard post-create selection call), then reads `/lol-perks/v1/currentpage` back and compares id/name/`selectedPerkIds` to what was sent. `/apply-runes` responses gain `selected`/`verified`/`mismatch` — a failed selection or content mismatch still reports `ok:true` (the page WAS created) but honestly, so the UI says "saved — pick it in the client" instead of implying full success. (Slot-validity — the earlier prime suspect — was checked against a live CommunityDragon perkstyles.json pull and pinned in a new web-side fixture test; no misplacement found, downgraded to defense-in-depth per that investigation.)
- Two real PowerShell bugs found via SelfTest while validating the fix, both fixed: (1) piping an empty array into `ConvertTo-Json` (`$Obj | ConvertTo-Json`) produces NO output at all rather than the JSON literal `"[]"` — crashed `Write-JsonResponse`/`Invoke-LcuRaw` whenever a route needed to serialize a genuinely empty collection (e.g. a fresh account with zero custom rune pages); fixed with `-InputObject` instead of piping. (2) A single-match `Where-Object` result silently unwraps to a bare (non-array) object in PS 5.1, and `.Count` on a bare object returns `$null` — `$null -gt 0` is false, so a real match could still 404. Both are general PowerShell landmines, not specific to this feature, and worth remembering.

### Added — safer rune auto-export + attached-tab live-follow
- **Runes now auto-export on champ select, like item sets** (opt-out toggle on `/live-setup`, default ON once paired) — with a redesigned, safety-first write path: `mode:'auto'|'manual'` on `/apply-runes`. Both modes prefer replacing a page CoachBuild previously created (title starts with "CoachBuild") or using a genuinely free slot; **auto mode NEVER deletes a page it doesn't own** — if the inventory is full and there's no CoachBuild page to replace, it returns `{reason:'slots-full'}` untouched (SelfTest-pinned with an adversarial 5-page/0-CoachBuild fixture: zero DELETE calls, ever). Manual mode (the click-through button) keeps the original consented behavior. Compliance update, documented in `companion.ps1`'s header: rune writes are now the same class as item-set writes — an inert loadout suggestion, not a game action.
- **Attached-tab live-follow**: the companion no longer opens a NEW browser tab on every champ-select hover once one is already open — it tracks whether the web side has polled `/status` recently (`lastStatusPollAt`, an 8s window) and, if so, lets the existing tab live-follow the hover in place instead (`app/page.tsx`'s existing companion-status poll now also resolves+applies champion changes). Auto-export dedup generalizes from "once per page load" to "once per (champ-select session, championId)" so re-hovering the same champion doesn't re-export, but hovering a new one does. A cheap localStorage lock avoids double-firing across two open tabs.
- COMPANION_VERSION bumped to 1.3.0. `-SelfTest`, `-Mock -Once`, and `-HarnessTest` all green with the new merge-safety, selection/readback, and attached-tab-gate assertions.

## [0.33.2] — 2026-07-20
### Fixed — TLS handshake dies on a scriptblock cert callback (companion v1.2.2)
- **Root cause found: `[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }` is a PowerShell scriptblock, and scriptblocks are runspace-affine.** .NET invokes the certificate-validation callback during the TLS handshake on a threadpool thread that has NO PowerShell runspace attached — the scriptblock throws there, failing the handshake. On a machine with a real League client, this means **every single HTTPS call to the self-signed LCU dies at the handshake** (`Invoke-LcuRaw` returns `Ok=$false`), so `phase` can never leave `'None'` — while `clientConnected` stays `true` regardless, since that flag only reflects the CIM/lockfile credential lookup, never an actual successful LCU call. On this dev box (no League client, no LCU HTTPS ever attempted) this was completely invisible through v1.2.1 — every gate passed clean.
- Fixed by replacing the scriptblock callback with a **compiled .NET delegate** (`Add-Type` defining `CoachBuildCertPolicy.AlwaysTrue`) — compiled code has no runspace affinity and runs correctly on any thread, including the handshake's threadpool thread. TLS1.2 forcing kept as-is.
- **Addendum root-cause confirmation:** the user's `companion.log` tail (3 launches) showed only the startup `phase: -> None` line and nothing else while sitting in a real champ select with the client connected — proving the failing call's own exception was being swallowed one layer BELOW where v1.2.1's logging lived (inside `Invoke-LcuRaw`'s, `Get-LiveClientData`'s, and `Get-LcuCredentials`' own try/catch blocks, which returned failure silently). All three now log via a new throttled logger (`Write-ThrottledErrorLog` — at most 1 log line per ~60s per distinct failure, so a persistent failure can't flood the 200KB rolling log) and feed `/status`'s new `lastError` field.
- `/status` gains `lastError` (most recent unexpected-failure message, e.g. `WebException: Could not establish trust relationship` — would directly confirm this diagnosis on the next screenshot) alongside `lastPollAt` (added server-side in 1.2.1, but never actually wired into `companionClient.ts`'s `CompanionStatus` type or rendered on `/live-setup` until now — the panel genuinely couldn't have shown the heartbeat before this release). `/live-setup`'s connection details now show last poll time, last opened, champ-select snapshot, and last error (muted styling, only when present) — one screenshot should tell the whole story next time.
- **Honest validation note:** the TLS-callback fix itself is untestable without a real self-signed HTTPS peer (no League client on the dev machine building this) — confirmed the compiled delegate builds and applies without error, and that a real HTTPS call with the callback active still succeeds (sanity-checked against `coachbuild.vercel.app`, a valid cert). The genuine confirmation requires the user's own `companion.log`/`/status` on their next real champ select.
- COMPANION_VERSION bumped to 1.2.2. `-SelfTest`/`-Mock -Once`/`-HarnessTest` all still green, plus a new SelfTest assertion pinning that a real `Invoke-LcuRaw` failure (unreachable port) populates `lastError`.

## [0.33.1] — 2026-07-20
### Fixed — real-mode gameflow loop, plus 2 audit findings (companion v1.2.1)
- **Honest root-cause note: the real-mode gameflow/champ-select loop's actual failure was never conclusively isolated on this machine** (no League client here to exercise the credentials-present code path where the live report's symptoms point). What WAS conclusively established: local heartbeat instrumentation (a new `/status` `lastPollAt` field) proved the previous WinForms.Timer + `Application.Run()` harness DOES tick correctly in the no-LCU branch — the dead-loop theory is not reproduced in that branch on this box. The real blind spot, confirmed structurally: **`-Mock` drives `Update-ChampSelectState` directly and `-SelfTest` only ever exercises the bridge server — neither test has EVER run `Start-Companion`'s actual gameflow-poll loop.** That gap is closed for good.
- Replaced the WinForms.Timer/event-delegate harness with a plain sequential loop (`while` + `Application.DoEvents()` pumped every 50ms for tray responsiveness) — strictly easier to reason about than a .NET event dispatched through a message pump, and every exception path (a hung HTTPS call, CIM flakiness, an unhandled error mid-tick) now logs via `Write-CompanionLog` and retries next iteration instead of silently vanishing. `Get-LcuCredentials`' CIM-query failure path, previously a bare silent `catch {}`, now logs too.
- **New `-DebugRunSeconds N` / `-HarnessTest` test seam** closes the blind spot structurally: `-HarnessTest` spawns a real `-DebugRunSeconds` child process (tray suppressed, no League client needed) and asserts `/status`'s new `lastPollAt` heartbeat genuinely advances between two polls — if the real loop ever dies again, this fails loudly instead of shipping blind. Verified locally: `-SelfTest`, `-Mock -Once`, and the new `-HarnessTest` all pass on this machine.
- `/status` gains `lastPollAt` (ISO timestamp of the most recent tick, regardless of LCU presence) alongside the existing `lastOpen`/`champSelect` diagnostics.
### Fixed — v1.2.0 audit findings (P1 web, P2 companion)
- **P1 (`components/hextech/BuildTabContent.tsx`, wrong-champion race):** a deep-link tab could render its first successful build for the page's FALLBACK champion before the champion lookup resolved and swapped in the real deep-linked champion — the one-shot auto-export ref got consumed against the wrong build, permanently blocking the real champion's export for that tab's lifetime (no remount ever corrects it). Fixed with a pure, unit-tested guard (`itemSetsApply.ts`'s `isAutoExportEligibleBuild`): wait for a build whose champion matches the URL before ever consuming the ref.
- **P2 (`public/companion.ps1`):** the last 2 non-ASCII bytes (`§` in two comments) removed — the file's stated invariant is zero non-ASCII bytes (served over `irm | iex` with no encoding guarantee), and comments shouldn't be the exception that breaks it later.
- Everything else in the v1.2.0 audit came back CONFIRMED-SAFE (merge safety, 3-way champion fallback, the encoding fixes, gate logic, no compliance regressions) — no other action needed.
- COMPANION_VERSION bumped to 1.2.1 (`public/companion.version`).

## [0.33.0] — 2026-07-20
### Added — Item Sets (companion v1.2.0)
- **"Add item builds"** button (Runes & Summoners card, next to Apply runes): writes up to 3 LCU item sets for the current champion+role — **Core** (starting item + core build order + situational, capped 6), **Optimized** (only when `items.optimizedPath` genuinely differs from Core — reuses the exact rule CoreBuildOrderCard's UI already applies), **Pro** (only when pro-consensus item data resolves — same aggregation ProConsensusCard already performs independently, ordered by pick-rate desc, capped 8, boots included). "Top 3 if available" — never pads, never invents a variant without real data behind it. Pure builder: `components/hextech/itemSetBody.ts`; async resolution + POST shared by button and auto-export: `components/hextech/itemSetsApply.ts`.
- **Auto-export on champ select** (opt-out, default ON once paired): entering champ select via a companion deep-link auto-writes the same item sets — no click needed. Toggle on `/live-setup` ("Automation" section, `coachbuild:companion:autoItemSets`). Compliance distinction from rune apply (which stays strictly manual, unchanged): an item set is an inert shop-panel suggestion (same class as Blitz/u.gg's auto-import), not a gameplay action — see companion.ps1's compliance header for the full reasoning.
- Companion: new `POST /apply-itemsets` bridge route. **Merge safety (the #1 correctness risk):** `PUT /lol-item-sets/v1/item-sets/{id}/sets` replaces the ENTIRE object — the bridge always GETs the existing sets first (never blind-PUTs; a failed GET → `{ok:false, reason:'read-failed'}`, nothing written), keeps every existing set whose title doesn't start with THIS champ+role's `CoachBuild <champ> <role>` prefix (so a CoachBuild set for a different champion accumulates across sessions instead of being wiped), and replaces — never duplicates — stale sets for the same champ+role. Every incoming set's title must start with "CoachBuild" or the whole request is rejected (`invalid-sets`) — defense against a compromised/buggy client ever writing an arbitrary-titled set.

### Fixed (companion v1.2.0 — three live-device findings during rollout)
- **Champ-select never opened in custom lobbies, blind pick, or ARAM.** `assignedPosition` is blank there, and the companion silently skipped opening entirely whenever no role resolved. Now still opens — just without a `role=` param — and the web side falls back to its own most-played-lane resolution for these (same correction a manual champion search already uses), instead of trusting a role that was never known.
- **Hovering a champion (pre-lock) sometimes opened nothing even in a normal draft lobby with real roles.** `myTeam[].championId`/`championPickIntent` aren't always populated for a pre-lock hover on some client versions — the hovered champion instead lives in `session.actions` (the player's own in-progress 'pick' action). Champion resolution is now a 3-way fallback: locked cell id → cell pick-intent → the local player's own in-progress pick action (flattening `session.actions`, an array of arrays).
- **A non-ASCII em dash in an item-set title corrupted silently on the wire.** Two real bugs, both fixed: (1) `Invoke-WebRequest -Body <string>` downgrades non-ASCII characters to the console's best-fit OEM codepage unless given pre-encoded bytes — `Invoke-LcuRaw` now always sends UTF-8 byte bodies; (2) `HttpListenerRequest.ContentEncoding` defaults away from UTF-8 when the client doesn't specify a charset — the bridge's request-body readers now always decode as UTF-8 explicitly. (A related, unrelated-to-network bug: a literal em-dash character embedded directly in `companion.ps1`'s own source broke the script's tokenizer under a misdetected codepage when served over `irm | iex` — fixed by using `—`/`[char]0x2014` escapes everywhere instead of a literal byte in the file.)
- Diagnosability: `/status` gains `lastOpen` (most recent deep-link this launch) and a `champSelect` resolution snapshot (cell id, pick intent, action-fallback id, role — while `phase=="ChampSelect"`), both shown subtly on `/live-setup`. A rolling log at `%LOCALAPPDATA%\CoachBuild\companion.log` (capped ~200KB, truncates to the newest half) records phase transitions, champ-select opens, and apply-runes/apply-itemsets results — never the session token or any name — for remote debugging without a screen-share.
- COMPANION_VERSION bumped to 1.2.0 (`public/companion.version`). `-SelfTest`/`-Mock` extended with the merge-safety, GET-fail, malicious-title, role-less-open, and actions[]-only-resolution assertions above.

## [0.32.2] — 2026-07-20
### Fixed (companion v1.1.0, two real-device findings from gaming-PC testing)
- **Silent autostart.** `-Install` wrote a Startup `.lnk` targeting `powershell.exe -WindowStyle Hidden`, but Windows Terminal (Win11's default terminal) ignores `-WindowStyle Hidden` on the process it spawns — autostart showed a visible console tab. Replaced with a silent `.vbs` launcher (`WScript.Shell.Run ..., 0, False`, whose hidden-window flag is honored regardless of the default-terminal setting). `-Install` now also removes any old `.lnk` from a prior install; `-Uninstall` removes both forms.
- **Pairing impossible before first champ select.** The bridge session token was purely per-launch and only ever reached the browser via a champ-select deep-link, so `/live-setup`'s Test Connection was permanently greyed out until the user's first champ select. Fixed three ways: the token now persists to `%LOCALAPPDATA%\CoachBuild\companion-session.txt` (read-if-exists, else generate+write, per-launch GUID fallback on any IO failure — same security posture, still 127.0.0.1-only + exact-Origin gated); tray "Reopen page" now opens `/live-setup?session=<token>` when no champion has been opened yet this run (previously opened the bare home page with no session at all); `-Install` finishes by auto-opening the pairing page once, so install→pair is one flow instead of two.
- COMPANION_VERSION bumped to 1.1.0 (`public/companion.version`); `-SelfTest` extended with a session-token persistence round-trip (isolated temp dir, self-cleaning) and an autostart-VBS well-formedness check.

## [0.32.3] — 2026-07-20
### Changed
- `/live-setup` connection-error copy: per-browser unblock instructions (Chrome/Edge lock-icon flow vs Brave's silent `brave://settings/content/localhostAccess` allowlist) + a note that the same error appears when the companion simply isn't running (fetch cannot distinguish connection-refused from a permission block).

## [0.32.1] — 2026-07-20
### Added
- "Companion" footer link in the sidebar (both desktop and collapsed/mobile layouts) opening `/live-setup`.

## [0.32.0] — 2026-07-20
### Added
- **CoachBuild Live** — champ-select/live-game companion integration. A KB-scale PowerShell 5.1 companion (`/companion.ps1`, installed via `irm https://coachbuild.vercel.app/companion.ps1 | iex`, COMPANION_VERSION 1.0.0) watches the League client: champ select auto-opens the exact champion+role build page (open-once debounce, re-open on champion change only); an **Apply runes** button pushes the recommended page into the client via the LCU (delete-then-create importer pattern, fail-soft on the known LCU DELETE bug with a manual-delete hint); in-game, a **Live panel** polls the companion's proxy of Riot's official Live Client Data API and renders the enemy comp (champion icons + positions only). New `/live-setup` page: install one-liners, pairing-token capture, Local-Network-Access explainer + connection test, 5-minute self-test checklist. Bridge security: 127.0.0.1-only, exact-origin CORS, per-launch session token, POST-only mutation. Riot-compliance hard lines enforced by tests: no summoner names rendered (livePanelModel key-shape assert), no cooldown/timer computation, rune apply strictly user-clicked, zero game-automation endpoints. Companion assets served no-store + SW-bypassed (never cached stale). Comp-aware situational highlighting ships dormant (`matchupConditioned` gate — activates automatically if upstream matchup data ever unlocks). Pre-ship adversarial audit: SHIP, no P0/P1; two P2 polish items folded in (tray Reopen preserves role; setup copy honesty), two logged as fast-follows (URL token scrub, poll timeout tuning).
- Dev fixture `app/api/mock-companion/` mirroring the bridge wire contract; companion `-SelfTest` / `-Mock` CI-runnable test seams (real-client E2E is gaming-PC-only by nature).

## [0.31.1] — 2026-07-19
### Fixed
- **Pro Play feed missing the Esports World Cup 2026.** The ingest tournament resolver (`lib/prostage/tournaments.ts`) matches Leaguepedia pages by LIKE pattern, and no existing pattern matched the real page name "Esports World Cup 2026" (it doesn't contain "Worlds"/"World Championship" — EWC is a third-party event, not a Riot-run international). Added `"Esports World Cup"` to the contains-pattern list, plus the matching lolesports league-slug mapping in `lib/prostage/resolveGame.ts` (`ewc_lol`, live-verified against `getLeagues()` 2026-07-19) so item-build timelines can resolve for EWC games too.


### Added
- **Optimized item order**: the core build's item sequence re-derived with each pick conditioned on owning the previous one (the coachless API supports 2 priors — verified live), with an adoption-relative floor so thin conditional tails can't surface as advice. Shown under the core path when it differs; a quiet confirmation note when identical.
- **Rank bracket selector**: filter builds by real league tiers (Platinum+ through Challenger; default remains the legacy high-elo blend, byte-identical requests). Persisted per device.
- **Patch Movers page**: biggest headline keystone/item WPA swings between the current and previous patch, per lane, compared daily.
- **Update toast**: new deploys offer "Update ready — Refresh" instead of applying silently on next navigation.

### Not shipped (honest finding)
- Matchup-conditioned builds: the upstream API rejects matchup parameters (verified 403 across endpoints). The engine degrades gracefully and will auto-activate if support ever appears; no UI is shown.

### Fixed (pre-ship audit)
- Patch-movers route gained `maxDuration = 60` (its cold path exceeded the platform default — the first daily visit would have 500'd).
- First-time visitors no longer get a spontaneous reload from the new SW lifecycle (reload now only fires when the user tapped Refresh).

## [0.30.0] — 2026-07-18
Full adversarial codebase review (Fable, cold-start) at v0.29.1: no P0, 1 P1, 2 P2, P3 batch — all implemented, re-verified by the same reviewer (one new seam defect found in re-verify, patched same release).

### Fixed
- **P1: `/api/hero-stats` no longer CDN-caches degraded results.** A transient upstream (coachless) failure returned `{winRatePct: null, gamesCount: null}` with a 6h edge cache — pinning a broken win-rate banner and most-played-lane landing per PoP (the v0.15.1 cached-empty incident class). Degraded and no-data results now go out `no-store`; healthy results keep the cache.
- **P2: prostage cron tournament rotation no longer pins dead tournaments.** Staleness was proxied by `max(ingested_at)`, which never advances on a zero-new-rows pass — a finished tournament would win the rotation every day forever, starving ongoing ones. New `prostage_ingest_attempts` table (migration 0008) stamps every attempt; rotation orders by last attempt.
- **P2: match-ingest cursor walk no longer skips half the backlog.** OFFSET pagination over an ORDER BY that mutates mid-walk (processing bumps `last_fetched_at`) skipped ~batch accounts per step for external pingers. Replaced with a stable walk-start-timestamp predicate; the daily-cron path is unchanged. Re-verify found the rewrite could loop forever on a zero-progress page (e.g. suspended Riot key → all 403s); errored and unmapped-region accounts now stamp `last_fetched_at` so the walk always terminates, and a future cursor is clamped to now.
- Transient Riot blips can no longer stick `active=false` on a healthy pro account (definitive 4xx only).
- Ultra-long game timelines that hit the 500-frame walk cap, and games beyond the 10-page schedule search, are now marked transient (retryable) instead of being persisted as complete/unavailable.
- Team comps are omitted for sides whose role ordering degraded to source order (soloq producer) — the "vs" laner shown can no longer be silently wrong for those rows.
- Pro-consensus: a keystone whose games all lack a resolved rune tree can no longer render above a different keystone's tree (falls back to a consistent tree+keystone pair or a tree-less page).
- Prostage icons no longer resolve against a frozen 16.11.1 CDN folder — the live patch version is derived from the champion icon map, hardcoded version only as last resort.
- Back/forward history entries no longer capture a stale tab/source when a champion's lane correction lands after a mid-flight filter change.

### Changed
- Recommendation engine: alternatives' noise floor lowered 800→400 games so it is always below the headline adoption bar (was inverted for sub-16k-game champ+role combos; sparse combos may show different alternates — intended).
- Ingest auth uses constant-time comparison; prostage cron logs and returns an error count (diagnosing why the scheduled run has never landed data).

### Removed
- Orphan public `/api/lane-defaults` route (zero consumers; its lib remains).
### Fixed
- **Durable pro-account match ingest: fixed the root cause of accounts never getting fetched** (audit 2026-07-13 found 1,312/1,445 active `pro_accounts` permanently stuck at `last_fetched_at IS NULL`, incl. all 6 of pro player Nemesis's EUW accounts, added 2026-07-09 — his tracked gameCount was 0). `lib/pro/ingestMatches.ts`'s account-selection query ordered by `last_fetched_at ASC NULLS FIRST` with NO tiebreaker — Postgres gives no ordering guarantee among equal (all-NULL) sort keys, so an `OFFSET`/`LIMIT` window over a 1,312-row NULL cohort could return an arbitrary subset per invocation with no bounded-time guarantee every account is ever reached. Added `created_at ASC` as a deterministic tiebreaker — oldest-registered never-fetched account goes first, and a fresh fetch pushes an account to `now()` (far behind the remaining NULLs), so the queue is now a strict FIFO that provably drains.
- **Raised the daily cron's effective batch from 5 to 20** (`app/api/ingest/matches/route.ts`'s un-parameterized default — the Hobby-plan cron hits the route with no query string, so this default IS the cron's daily throughput). Worked through the 60s `maxDuration` budget: a never-fetched account can cost up to `1 + 20*2 = 41` paced Riot calls (`getMatchIdsByPuuid` + `getMatch`/`getMatchTimeline` per new match, 1.3s pacer floor) ≈ 53s — nearly the whole budget for ONE account, so neither the new batch of 20 nor the old default of 5 is provably safe against an all-worst-case batch. Raised anyway: ingest is idempotent/resumable at the match level (`ON CONFLICT DO NOTHING` + an `existing`-match filter before fetching), so a mid-batch timeout only delays that account's `last_fetched_at` bump by a day, never loses data — batch=20 maximizes drain rate for the common (incremental, few-new-match) case while degrading gracefully on the worst case. Full math in the route's header comment.
- New test `lib/__tests__/pro-ingestMatches.test.ts` asserts the account-selection query text contains the `created_at ASC` tiebreaker in the same `ORDER BY` clause.

## [0.29.0] — 2026-07-13
### Fixed
- **Fixed an impossible Pro Consensus rune page** (user report on a champion with a modal-only keystone — e.g. Deathfire Touch 16/30): the card showed a page no in-game rune setup could produce — minors mixing two trees (Presence of Mind from Precision sitting next to Sorcery minors), a "secondary tree" equal to the primary tree, and the same rune (Manaflow Band, Celerity) appearing as BOTH a primary minor AND a secondary pick. Root cause: `components/hextech/proConsensus.ts` flat-aggregated `primaryMinors`/`secondaryPicks`/`secondaryTree` over ALL games regardless of each game's primary tree. When the top keystone is only modal (16 of 30 games), the other 14 games ran DIFFERENT primary trees, so their `primary[]` polluted the minors row and their secondary trees/picks polluted the secondary column.
  - **Fix — condition the whole page on the top keystone's TREE, resolved from the game data itself.** Every game already carries `runes.primaryTree` (set by `lib/pro/extract.ts` from Riot's perk styles and `lib/prostage/extract.ts` from Leaguepedia's `PrimaryTree` column, where `primary[]`/`secondary[]` are bucketed by parent tree), so NO hardcoded keystone→tree table is needed. New `resolvePrimaryTree()` picks the tree the modal keystone actually ran under; the page sample is then games whose `primaryTree` matches it. `primaryMinors` aggregate `primary[]` over that page sample only; `secondaryTree` is the modal secondary tree over the page sample EXCLUDING the primary tree (impossible in-game); `secondaryPicks` aggregate only over page-sample games whose secondary tree equals that modal tree — so every pick belongs to the displayed secondary tree and, being a different tree from the primary, can never duplicate a primary minor.
  - The top keystone itself stays modal over ALL games with a resolved keystone (the honest "16/30" is unchanged). Shards, spell pair, items, and boots are tree-independent and remain aggregated over every game.
  - `ProConsensusModel` gains `primaryTree: number | null` and `primaryTreeSampleSize` (N_page). `ProConsensusCard.tsx` now shows the resolved primary tree as the PRIMARY header (icon + name, mirroring the secondary tree header) and names the tree in the conditioned-sample caption ("minors from 18 games running Sorcery").
  - 13 new tests in `components/__tests__/proConsensus.test.ts` (43 total in the file) encode the invariants: no rune id in both minors and picks; `secondaryTree ≠ primaryTree`; a different-tree-keystone game contributes nothing to minors/secondary; a mixed-tree fixture reproducing the screenshot (16 Sorcery + 14 Precision) shows only the Sorcery-conditioned page; conditioned denominators ≠ gamesTotal; graceful degradation to a null primaryTree when no game carries tree data; plus `resolvePrimaryTree` unit coverage. Item/boots/shards/spells tests unchanged and green.

## [0.28.1] — 2026-07-13
### Fixed
- **Fixed a real visible defect in v0.28.0's `BootsStackTile`: boot names clipped mid-word with no ellipsis** ("Spellslinge Shoes" for Spellslinger's Shoes, confirmed on the v0.28.0 smoke screenshot at 390px). Root cause, confirmed via DOM measurement rather than assumed: the name's `line-clamp-1` span sat in a flex child with no definite width (`min-w-0` alone, no `flex-1`) — Chromium's `-webkit-line-clamp` height computation goes wrong inside a flex row without one, and the single-line clamp had no room to show an ellipsis in the ~46px column left after the icon. Fixed by giving the text column `flex-1` (a definite width before line-clamp is evaluated) and switching the name to `line-clamp-2 break-words`, the same two-line wrap treatment `ItemTile`'s own name already uses — a boot name now always wraps (even mid-word for an unbroken token like "Spellslinger's" in this narrow column) instead of losing characters.
- Re-verified the stacked boots cell's vertical alignment against sibling item tiles (existing `justify-center` on the stack's container) — measured boot-stack first-icon center within ~6px of the sibling `ItemTile`'s icon center at 390px; no layout change needed there, already effectively centered.
- CSS/layout only — `components/hextech/proConsensus.ts`'s aggregation model, tap-for-detail wiring, and every other Pro Consensus section are unchanged.

## [0.28.0] — 2026-07-13
### Changed
- **Pro Consensus's rune section is now ONE composed in-game rune page instead of a keystone+tree row followed by a separate flat "Additional Runes" list** (user feedback on a live screenshot: "Put the additional runes as the layout lol runes are set as in game. Don't put them like that separately"). `components/hextech/ProConsensusCard.tsx` now lays out a 3-column grid (stacks to 1 column at 390px) mirroring the BUILD tab's `RunesSummonersCard` vocabulary: **Primary** column — keystone (large, gold ring) with its 3 minor runes below it; **Secondary** column — tree icon+name+fraction header, its 2 picks, then stat shards; **Summoners** column — the spell pair. New `ConsensusRuneTile` renders every rune the same way RunesSummonersCard's `RuneTile` does (icon above name above stat), just driven by a pick-rate percentage instead of a WPA score. Honesty affordances are unchanged in substance, consolidated in form: every tile still shows its own `pct · count/denom` (minors/picks/shards keep their own per-slot sample-size denominators, per `proConsensus.ts`'s module header), and the three "from N games" captions collapse into one small footer line instead of three repeated ones. N=0 hide and N<3 caution behavior unchanged; every rune/shard tile keeps its tap-for-detail popover wiring.
- **Boots now occupy ONE item-grid slot instead of two** (user feedback on the live ITEMS row: Crimson Lucidity 35% and Spellslinger's Shoes 27% were each taking a full item slot on Viktor mid, crowding out a real item). `components/hextech/proConsensus.ts`'s `ProConsensusModel` gains a `boots: ItemFrequency[]` field (top 2 boots by pick rate, partitioned from the same completed-item counts via `itemMeta`'s `tags.includes("Boots")` — an item with no metadata is never classified as boots) — `items` is now top 6 NON-boots, so a real item backfills the slot boots used to double-occupy. New `BootsStackTile` renders both boot choices stacked vertically in one grid cell (icon+name+pct+count each, independent fractions against the same games-total denominator — never merged into a combined stat); hidden entirely when the sample has no boots. Each stacked row keeps its own tap-for-detail popover.
- New tests in `components/__tests__/proConsensus.test.ts` cover the boots partition (tags-based classification, top-2 cap with items backfilling to top-6, an item with no metadata never classified as boots, empty-boots sample). Two pre-existing tests updated to assert boots now surface via `model.boots`, not `model.items`.

## [0.27.5] — 2026-07-13
### Fixed
- **Fixed a real prod P0: the Pro Consensus card could crash on load with "Pro consensus data couldn't load (undefined is not an object (evaluating 'D.tags.includes'))"** (Safari/iOS phrasing — reported from the user's phone PWA). Root cause: `components/itemDetail.ts`'s `readLocalStorageCache` JSON-parsed whatever was stored under `coachbuild:itemdata:v1:<ver>` and trusted its shape blindly; v0.27.1 added `into`/`from`/`tags`/`purchasable` to `ItemDetail` without bumping that cache prefix, so a device still holding a pre-v0.27.1 entry returned an object missing those fields. `components/hextech/proConsensus.ts`'s `isBuildItem`/`isBootsFinal` then called `meta.tags.includes("Boots")` on `undefined`.
  - Bumped the localStorage cache key to `coachbuild:itemdata:v2:` — no stale pre-v0.27.1 entry is ever read again. `readLocalStorageCache` now also normalizes every parsed entry defensively (`into`/`from`/`tags` default to `[]`, `purchasable` defaults to `true`, etc.), so a future shape change degrades instead of crashing. `writeLocalStorageCache` best-effort sweeps any lingering `v1:*` keys on next write.
  - `isBootsFinal`/`isBuildItem` (`proConsensus.ts`) are now defensive independently of the cache fix — `Array.isArray` guards on `tags`/`from`/`into` before touching them, since `meta` ultimately flows from `JSON.parse` and the type signature is only a compile-time guarantee. A malformed/legacy-shape meta now degrades to "exclude" (same "never assume, never invent" posture as the existing `!meta` branch) instead of throwing.
  - New regression test in `components/__tests__/proConsensus.test.ts` asserts `isBuildItem` never throws on a legacy-shape meta object (name/gold/description only, no into/from/tags/purchasable).

## [0.27.2] — 2026-07-13
### Fixed
- **Fixed a real, live-reproduced P0: the BUILD tab could silently render the WRONG champion's entire build** (runes/summoners/items) under the CORRECT champion's header. `BuildTabContent.tsx`'s `/api/build` fetch had no stale-response guard — a champion/lane change starts a new fetch without cancelling the previous one, so two in-flight requests can resolve OUT OF ORDER (a fresh pick's cache-MISS request landing after an OLDER cache-HIT request from a since-abandoned pick, e.g. via a quick browser back). Reproduced live on prod (Slow 3G: search Ahri, immediately hit back to Viktor) — Ahri's Electrocute/Ignite build rendered under the "VIKTOR" header, while `ChampionHero`/`Sidebar` (driven by separate, correctly-guarded page state) kept showing Viktor. Fixed with the same `cancelled`-closure pattern `ProConsensusCard` already used, so a superseded response is now inert regardless of resolution order.
- **A slow `getMostPlayedLane()` correction (v0.26.0) could apply to the wrong view after a browser back/forward.** Every OTHER navigation handler (lane tap, champion pick, player pick, sheet-tap jump) invalidates a pending most-played-lane lookup by bumping a request-id ref; a back/forward restore never did, since it's driven by `useSheetBackNav`'s popstate listener rather than one of those handlers. A lookup that outlived a back-navigation could still land, silently changing the CURRENT (unrelated) view's lane and overwriting its history entry with the STALE champion. `app/page.tsx`'s `restoreMainView` now bumps the same ref on every restore (mount-resume and popstate alike), closing the gap.
- **`ProConsensusCard` no longer conflates a genuine zero-pro-games result with a fetch failure.** Both used to collapse into the same silent "render nothing" state — indistinguishable from the outside, which is what made a live user report ("the Pro Consensus card just isn't there") impossible to triage from a screenshot alone. A real fetch failure now renders a small muted line ("Pro consensus data couldn't load — try refreshing") instead of nothing; a true N=0 (e.g. Viktor Support, essentially never played by pros) still renders nothing, unchanged.
- Investigation note: the originally-hypothesized repro (champion → PROS-mode toggle → player search → back) was tested exhaustively (local dev + live prod, throttled network, forward/back/reload combos) and never reproduced a missing card — that mechanism is ruled out. The two races above were found instead while probing the same suspect file (`BuildTabContent.tsx`) and are real, independently confirmed bugs in the same failure class (unguarded async state updates surviving a navigation change).

## [0.27.1] — 2026-07-13
### Fixed
- **Pro Consensus card refinements** (user feedback on a live Viktor Mid screenshot: Needlessly Large Rod — a component, not a finished item — was showing next to Blackfire Torch; the card only showed keystone + secondary tree NAME, no fraction/percentage anywhere).
  - **Every fraction on the card now shows a percentage** — "90% · 35/39" (percentage primary/bold, fraction muted), applied consistently to items, keystone, secondary tree, and spells (`components/hextech/proConsensus.ts`'s new `formatSharePct`).
  - **Items are now filtered to real finished builds.** New `isBuildItem` predicate (`proConsensus.ts`) excludes mid-build components using REAL ddragon recipe data (`into`/`from`/tags/purchasable, extended onto `ItemDetail` in `components/itemDetail.ts` — same fetch that already resolved item names/gold, no extra network cost): completed = purchasable + no further `into` upgrade, PLUS a boots-specific carve-out (the 2026 boot-mastery rework added a tier-2→tier-3 enchant step, so a tier-2 boot like Sorcerer's Shoes still has an `into` even though "stopped at tier 2" is a totally normal final build), PLUS an explicit starting-item allowlist (Doran's x3, Dark Seal, Tear of the Goddess, Cull, World Atlas, Guardian's Amulet/Shroud — Dark Seal and Tear of the Goddess are the two that actually need it, since both have a real `into` upgrade path; the rest are pinned defensively). Verified against a live 16.13.1 item.json pull: Needlessly Large Rod (1058, `into`: 6 core mage items) is excluded; Crimson Lucidity/Spellslinger's Shoes (tier-3 boot enchants) and Blackfire Torch/Rocketbelt (completed items) still show.
  - **New "Additional Runes" block** — aggregates the FULL rune picture, not just keystone + secondary tree name: top 3 primary-tree minors, top 2 secondary-tree picks, top 3 stat shards, each flat-frequency-ranked (not positionally slotted — Leaguepedia's prostage rune extraction doesn't reliably preserve row order, so claiming "row 1 pick" would overstate the data) with its OWN sample-size denominator (games whose payload actually carried that slot, never gamesTotal) and an honest sub-sample caption ("from 8 solo-queue games" when a slot — shards, structurally, since Leaguepedia never carries shard data — turns out to be soloq-only; a mixed "N games (X solo queue, Y pro play)" note otherwise). Renders via the same tap-for-detail popover wiring the rest of the card already uses (rune/shard EntityKind).

## [0.27.0] — 2026-07-13
### Added
- **New "Pro Consensus" card on the BUILD tab** (user request: "pro players seem to build Rocketbelt on Viktor — create another builds and runes space based on what pro players are often building"). Complements the WPA-ranked recommendation with a plain pick-rate count over the SAME champion-scoped pro-games feed PRO BUILDS already lists (`GET /api/pros?championId=&role=&source=all`, always `source=all` regardless of whatever filter the user has picked for the PRO BUILDS list below — a bigger, independent sample). New pure aggregation module (`components/hextech/proConsensus.ts`, `aggregateProConsensus`): top items by pick rate (deduplicated per game, consumables excluded via the existing `CONSUMABLE_ITEM_IDS` list, boots counted like any other item), top keystone + secondary tree (each with its OWN sample-size denominator — a prostage row can have one resolved without the other, per Leaguepedia's per-field Cargo resolution — so neither fraction silently borrows the other's sample), top summoner-spell pair (canonicalized so Flash-on-D and Flash-on-F count as the same combo). Verified live against Viktor Mid: **Hextech Rocketbelt is built in 35 of 39 recent pro games (90%)**, tied with Blackfire Torch — confirms the user's observation. Card (`components/hextech/ProConsensusCard.tsx`) reuses the tab's existing tap-for-detail popovers (`ItemDetailPopover`/`EntityDetailPopover`) rather than standing up a second popover instance; renders nothing for N=0 (e.g. Viktor Support, essentially never played by pros) and shows a low-sample caution line for N<3; sample-size footer states real fetched totals + source split + up to 3 named tournaments, nothing invented. Placed below SITUATIONAL, above the shared item/entity popover mount.
### Fixed
- **All 5 lanes now fit at 390px with no horizontal scroll** — the collapsed (mobile top-bar) LANES strip was `overflow-x-auto` with a 92px-min-width row, forcing ~492px of content into ~358px of available width, so Support scrolled off-screen. Switched to a fixed 5-column grid (`grid grid-cols-5`) sized to the actual viewport; the per-lane "you are viewing X here" champion-name subtitle (only ever shown on the active row) is dropped on the collapsed bar specifically — it was competing for the 5-column width budget for a fact the hero already states one scroll below — and kept on the desktop vertical list, which has room to spare.

## [0.26.0] — 2026-07-13
### Fixed
- **In-sheet player links from the home shell no longer escape to the legacy `/history` page.** Tapping a player in a game sheet's Teams box — from either PRO BUILDS' or the PROS-mode player view's sheet — previously always fell through to a stashed-selection + `router.push("/history")` fallback, because neither call site ever wired `GameDetailSheet`'s `onSelectPlayer` prop. The tap now closes the sheet and switches the home page's own main content to that player's Hextech view (the same view a PROS sidebar search pick lands on), pushing a history entry (an identity change, matching v0.23.0's back-nav policy). Handles both player kinds a Teams-box row can carry: **tracked** pros (`proId` → `/api/pros?proId=`, hero resolves real team/game-count in the background when not already known) and **link-only untracked** pros (`/api/pros?player=<player_link>`, prostage-only — the games filter locks to Pro Play with an explanatory label, mirroring `/history`'s own `ProHistoryResults` treatment, and the hero omits a game count entirely rather than guessing one). Back reopens the game sheet the tap came from (mirrors `/history`'s already-shipped cross-player-jump policy exactly — the simplest correct option, zero new back-nav branches).
- **Lane taps on the home page now change the LANE for the champion you're viewing, not the champion.** Previously each lane row carried its own most-played champion (Garen/Lee Sin/Ahri/Senna/Thresh-style), so tapping a different lane silently swapped to a different champion. Viewing Ahri and tapping Top now shows Ahri Top (different runes/items/hero-stats for that champ+lane pair, refetched via the existing champ+lane-keyed effects) — lanes are pure lane selectors for the current champion. A fresh champion pick (search or default) now lands on that champion's own most-played lane, derived cheaply (5 calls to the already-public `/api/hero-stats` route, reusing its `gamesCount` — the same keystone-occurrence-sum definition `lib/laneDefaults.ts`'s per-lane sweep uses) rather than a new backend endpoint; resolves in the background without blocking the pick, and a manual lane/champion/player action before it resolves wins outright. `lib/laneDefaults.ts` (most-played champion per lane) keeps its module — this fix removed its now-dead sidebar consumer, not the module itself. PRO BUILDS' existing `role=<selected lane>` filter (already the "use the lane's role" behavior) is unchanged, now documented as the deliberate, consistent choice.

## [0.25.0] — 2026-07-13
### Added
- **The Hextech BUILD tab shows the full recommended rune page, not just the keystone.** `RunesSummonersCard` previously showed only the keystone + secondary tree icon + 3 tiny shard dots — the pre-redesign Builds page's full rune page (primary tree's 3 minors, secondary tree's 2 picks, all named, with per-rune WPA and low-sample ⚠ markers) never got wired into the Hextech shell. Restored via a new pure `buildRunesPageModel` helper (`components/hextech/runesPage.ts`) that assembles it from the same `/api/build` `RunesBlock` payload the compact version already had — no backend change. Desktop keeps a compact 3-column layout (primary | secondary+shards | summoners) inside one card; 390px stacks cleanly to one column per section.
- **Every rune, shard, summoner spell, and item on the BUILD tab is now tap-for-detail** — the CommunityDragon-backed rune tooltips, hardcoded shard stat text, summoner cooldowns, and sanitized item gold/stats/passives (`components/runeDetail.ts` / `shardDetail.ts` / `summonerDetail.ts` / `itemDetail.ts`) all existed already from the pre-redesign Builds page but were never wired into the Hextech cards. `BuildTabContent.tsx` now owns the same activeDetail/lastDetail popover-state pattern `GameDetailSheet.tsx` uses, rendering `EntityDetailPopover` (rune/shard/spell) or the centered `ItemDetailPopover` (starting/core-build-order/situational items). Popovers are overlay state only — never history-backed, consistent with v0.23.0's back-nav policy.
- **New `useBodyScrollLock` hook** (`components/useBodyScrollLock.ts`), extracted from `GameDetailSheet.tsx`'s inline iOS-safe scroll-lock recipe (`position:fixed` pinned at the current offset, not `overflow:hidden` — the latter doesn't stop Safari's rubber-band scroll bleeding the page behind through an overlay). The BUILD tab's popovers have no enclosing sheet to inherit a lock from (unlike GameDetailSheet's own popovers, which sit over an already-locked sheet), so this tab locks scroll itself while a popover is mounted. **Gotcha caught during live verification**: an early version tied the lock to `lastDetail !== null` (the "which popover to keep rendering" flag) instead of a short-lived "currently mounted" flag — since `lastDetail` is deliberately never cleared back to null (so the popover can play its exit fade), that locked page scroll *permanently* after the very first tap. Fixed by tracking mount state separately, released 150ms after close (matching `DetailPopover`'s own exit-transition duration).

## [0.24.0] — 2026-07-13
### Added
- **The All/Solo Queue/Pro Play games filter is back on the Hextech home page** — the pre-redesign `/history` page had this SegmentedControl (still live there, `components/ProGamesSection.tsx`) but the Hextech shell dropped it. Restored on both PRO BUILDS (champion view) and the pro player view, reusing the exact `ProGameSource`/`SOURCE_FILTER_OPTIONS`/empty-state copy `/history` already has (`components/proGames.types.ts`) rather than forking a second copy. PRO BUILDS defaults to **Pro Play**, matching the Hextech spec mockup (`Design/redesign-2026-07/pro-builds-tab.png`) pixel-for-pixel on first load; the player view defaults to **All**, since a player's tracked history is mostly solo queue. Selecting a filter that yields zero games shows the same filter-aware empty-state copy `/history` uses ("No pro-play games tracked yet for Bwipo", etc.) instead of a generic message.
- **The filter is view sub-state, same policy as the BUILD/PRO BUILDS tab**: it survives back/forward within a view (carried in the `WireMainView` wire shape, `components/hextech/homeSearch.ts`) and resets to that view's own default the moment the champion or player identity actually changes (lane tap, champion search pick, or a new player pick) — flipping CHAMPIONS/PROS mode alone, or switching BUILD/PRO BUILDS tabs, leaves it untouched. A filter change while a game sheet is open just closes the sheet first (same documented trade-off as the tab-switch-while-sheet-open case, v0.23.0) rather than swapping the list underneath an open sheet.

## [0.23.0] — 2026-07-12
### Added
- **Back on the home page now walks your view trail** — champion → search a pro (player view) → back returns to the champion you were on; player view → open a game sheet → back closes the sheet (still the player view) → back again returns to the previous champion. Lane taps and champion search picks each get their own back-gesture step; the BUILD/PRO BUILDS tab does not (it's sub-state of a champion view, not a page of its own — switching tabs updates the current step in place instead of adding one). Same `useSheetBackNav` hook `/history` (v0.20.0) and the home PRO BUILDS sheet (v0.21.1) already use, now instantiated with the actual champion/player selection instead of nothing. A same-tab reload preserves whatever view you were on; a fresh tab/hard reload still lands on the default champion (no URL/query-param involvement — see app/page.tsx's design note for why a query-param design was evaluated and not used).
### Fixed
- **Switching tabs while a game sheet was open no longer strands a "ghost" back-stack entry** (previously documented as a known gap: `ProBuildsTab`/`BuildTabContent` unmount on a tab switch, silently orphaning the sheet's history entry, so one extra silent back-press was needed before the page would actually navigate). Tab switches now explicitly close an open sheet via a real back-navigation instead of leaving it behind. The same fix incidentally covers champion/lane/player changes made while a sheet was open, which had the identical gap.

## [0.22.0] — 2026-07-12
### Added
- **Search for a pro player, not just a champion**: the sidebar search now has a CHAMPIONS/PROS toggle (two small uppercase tabs sitting directly on top of the search field, same underline vocabulary as the BUILD/PRO BUILDS tabs). PROS mode searches tracked pros via the same typeahead `/history` uses; picking one swaps the whole main content to a player view — a hero (gold serif name, team, total fresh-game count — no invented imagery, since there's no headshot data anywhere in this app) followed by their recent games across every champion they've played, using the same row/sheet components PRO BUILDS already uses. Opening a game's detail sheet integrates with the same back-gesture history hook, so a back-swipe closes it here too. Switching modes never loses your champion pick — tapping a lane while browsing a player's games exits back to CHAMPIONS for that lane, same as picking a champion from search.
- **Rows now show their own champion** when they can vary game-to-game (`ProBuildRow`'s new `showOwnChampion` prop, opt-in — PRO BUILDS' fixed-champion rows are unaffected): the player view's games span many champions, so each row now carries a small icon + name for the champion actually played, not just the opponent.

## [0.21.1] — 2026-07-12
### Fixed
- **PRO BUILDS rows no longer overflow sideways on mobile** — the Hextech redesign's row kept its desktop horizontal layout at 390px (content ~530px wide inside a 356px card), pushing the whole page into horizontal scroll and clipping KDA, the 4 item icons, and league+date off-screen. The row now reflows into two stacked lines at `<=sm` (badge/identity/KDA, then vs/items/league+date) — every datum stays visible, nothing drops behind a `hidden sm:block` anymore. The BUILD tab was already clean and is unchanged.
- **Opening a game sheet from the home PRO BUILDS tab now integrates with browser/iOS back-gesture**, same as the Pro's page (`/history`, v0.20.0) — previously it pushed no history entry, so a back-swipe navigated away from the app instead of closing the sheet. The pushState/popstate machinery /history originally hand-rolled is now a shared hook (`components/useSheetBackNav.ts`); both pages consume the identical contract instead of a second hand-rolled copy.

## [0.20.2] — 2026-07-12
### Fixed
- **New champions no longer show as a grey "Champion #id" tile the moment they ship** — coachless's static champion bundle is pinned to its own data patch and can lag ddragon by a patch (verified live: Locke, id 805, shipped 16.13.1, missing from coachless's 172-champion 16.12.1 bundle; Bwipo's Locke games rendered blank comp-strip tiles and no portrait on Locke's own card). `getAllChampions`/`getChampionById` (`lib/staticData.ts`, backing `GET /api/champions`) now gap-fill any id missing from coachless with ddragon's own latest champion.json (name + an absolute ddragon icon URL) — coachless stays primary/authoritative for every id it already has, and any ddragon failure degrades to exactly today's behavior (no crash, fallback tile).

## [0.20.1] — 2026-07-11
### Fixed
- **Game cards on the Pro's list are visibly distinct now** — each card gets a brighter surface + clearer border than the page bg (scoped to the game list; other glass surfaces unchanged), a bigger gap between cards, and a win/loss accent edge (green/red, matching the WIN/LOSS pill) so results scan at a glance without reading every card.
- **Fixed a real bug**, not just a tweak: the ally/enemy comp strip at the bottom of each card had an unintentional 60%-opacity white divider (a Tailwind opacity-modifier-on-an-rgba-token gotcha) — ~7.5x brighter than the 8% hairline it was meant to be — which made the strip read as a bolted-on, disconnected element rather than the bottom of the same card. Now a matching faint hairline, so the whole card reads as one unit.

## [0.20.0] — 2026-07-11
### Added
- **Back returns to where you were**: the Pro's page now integrates with browser history — jump from a game sheet to another player's games, swipe back, and you land on the sheet you came from; back again walks to the previous view. Closing a sheet with ✕ never leaves ghost entries.
- **Every player in the Teams boxes is clickable** — including pros not in the tracked roster (their pro-play games load via their Leaguepedia identity; the view locks to Pro Play since they have no tracked solo queue).

## [0.19.0] — 2026-07-11
### Changed
Performance release, driven by a measured audit (the Builds page measured excellent and was untouched):
- **Images lazy-load** across the Pro's page — selecting a player no longer decodes 400+ icons at once (initial requests 414 → 117); all icons carry explicit dimensions so layout never waits on them.
- **Game list payload cut ~53%**: per-player team builds now load on demand when a game's detail sheet opens (new team-players endpoint, day-long cache), instead of shipping with every list.
- **Icons cache on-device**: the icon CDN sends no cache headers, so the service worker now serves repeat visits from a local cache (measured 364ms → 2.4ms per icon).
- Combined-sources game queries overlap their database round-trips (faster first view).

## [0.18.1] — 2026-07-11
### Fixed
- Sheet/card header identity line no longer shows the raw team suffix ("Saint — LYON", not "Saint — LYON (2024 American Team)") — the last uncleaned team field.

## [0.18.0] — 2026-07-11
### Added
- **Tap a player in the Teams boxes to jump to their games** — any tracked pro in either team is a link (name underlined with a chevron); works from the Pro's page and cross-page.
- **Pro-play matchup on top**: "LYON vs HLE"-style line in the game sheet header and on the game cards before the tournament name.
### Fixed
- **Data audit round**: 213 pro-play rows had silently-broken links to their tracked pros (Leaguepedia writes "Zeka (Kim Geon-woo)", roster says "Zeka") — matching fixed at ingest + repaired live. Keystone naming verified correct across tournaments (including Deathfire Touch, a valid 2026 Sorcery keystone).
- **In-game names only**: player names no longer show real-name parentheticals; team names no longer show wiki disambiguation suffixes ("LYON", not "LYON (2024 American Team)").

## [0.17.0] — 2026-07-11
### Added
- **Teams section redesigned, matchday-style**: each team sits in its own highlighted panel (WIN/LOSS chip in the header) with five per-player rows — champion, role, player name, and their full final build as tappable item icons with the usual info cards. Solo-queue games backfilled with per-player data (1,131 games); pro-play games derive it from the tracked rows. Games without the data keep the compact strip.

## [0.16.0] — 2026-07-11
### Added
- **Favorite champions**: star a champion from the search results on the Pro's page — starred champions appear as chips (with icons) under the search box for one-tap reuse. Same on-device storage and 12-champ cap as player favorites, fully independent of them.

## [0.15.1] — 2026-07-11
### Fixed
- **Pro Play intermittently showing "No pro-play games tracked yet" despite tracked games** (P0, prod-only). Root cause: on Vercel, the Neon HTTP driver's query POSTs went through Next.js's patched, Data-Cache-aware `fetch`; a `{rows:[]}` response cached while `prostage_matches` was still being backfilled kept being replayed — keyed on the exact query bytes + params, persisting across deployments — while byte-different variants of the same query (e.g. a different `limit`) returned live rows. The Neon client now opts every driver call out of the fetch data cache (`fetchOptions: { cache: "no-store" }`, lib/pro/db.ts).
- **Empty `/api/pros` responses are no longer CDN-cached**: previously an empty (or degraded-to-empty) result was pinned by `s-maxage=1800` for 30-60 min per URL, amplifying any upstream glitch into a user-visible outage. Empty responses are now `no-store`; only non-empty responses keep the long cache.

## [0.15.0] — 2026-07-11
### Changed
- **Team comps are role-ordered**: both strips read Top → Jungle → Mid → Bot → Support, so a mid-laner's champion sits in the middle slot (all 1,134 solo-queue games re-backfilled; pro-play ordered from tracked roles; falls back to source order when a side's roles don't cleanly resolve). Sheet roster rows carry positional hints.
- **Item build order redesigned** to matchday's density: 28px icons, minute labels tight to their items, no per-group card chrome — roughly a third of the previous height, same tappable items with named labels and consumables toggle.

## [0.14.1] — 2026-07-11
### Fixed
All four findings from the 18/20 anchored review (path to 20):
- Rune-tooltip cache now self-refreshes (10-day TTL) — returning users can't keep stale rune numbers across patch rebalances.
- Item buttons announce real item names to screen readers ("Rabadon's Deathcap", not "item #3152") across final build and build order.
- Modern `mobile-web-app-capable` meta emitted (console deprecation warning gone); search inputs carry stable id/name for autofill association.
- Removed the dead "pending" retry branch from the pro-play timeline client (server never returns it) — state machine simplified to loading/ok/unavailable/error.

## [0.14.0] — 2026-07-11
### Added
- **Ally + enemy team comps on every game** (dpm.lol-style): tiny 5v5 champion icon strips on game cards (your pro's champ highlighted) and a Teams section in the game detail view. Pro-play games have comps immediately; solo-queue games fill in as the backfill completes.
### Changed
- **Rune info cards now show real numbers** — descriptions come from the in-client tooltip data (e.g. Second Wind: "heal for 4% of your missing health over 10s") instead of Riot's placeholder-stripped public text. Item cards verified across all 706 items: every armor/MR stat line already renders.

## [0.13.0] — 2026-07-10
### Added
- **Runes, stat shards, and summoner spells are now tappable** in the game-detail view — same centered info card as items, with names and descriptions.
### Fixed
- **Skill-order grid readability**: filled cells were near-invisible (1.07:1 contrast) — now a teal-tinted chip measured at 7.9:1, with the R row still distinct.
- **Stormraider's Surge keystone rendered as an empty circle** (its icon path 403s on the CDN; special-cased like Deathfire Touch). Any icon that fails to load now shows a lettered placeholder instead of vanishing — everywhere (cards, sheet, Builds page).
- **LCK "Road to MSI" pro-play games couldn't resolve their item timelines** — resolver now finds them on lolesports' schedule.
- Accessibility round (from an adversarial audit): dialogs now trap Tab, the item card returns focus where you were on close, background can't scroll behind the sheet on iOS, picker aria states corrected.

## [0.12.0] — 2026-07-10
### Added
- **Pro-play games now show the in-game item build order** (matchday-style): reconstructed from the official lolesports broadcast feed by walking the game's frames, matched to each player by champion. Computed once per game on first view (a few seconds), then served instantly from the database. Items in the timeline are tappable like everywhere else. Skill order remains unavailable for on-stage games (the feed carries no ability-level data).
### Changed
- **Item detail card now opens centered on screen** (was bottom-anchored on mobile), matchday-style, on all viewports.

## [0.11.0] — 2026-07-10
### Added
- **Tap an item for details**: every item in the game-detail view (final build + build order) opens a mini-sheet with the item's name, gold cost, and stats/passive description, version-matched to the game's patch.
### Changed
- **Item build order wraps into rows** — no more sideways scrolling; each minute group is a self-contained card.
- **Skill order is a per-ability grid**: Q/W/E/R each on their own row across 18 level columns, R row highlighted — fits phone width with no scrolling.

## [0.10.0] — 2026-07-10
### Added
- **Favorite players**: star a player from search results or after selecting them — favorites appear as chips under the search box for one-tap reuse (stored on-device, newest first, up to 12).
- **Game detail view**: tap any game card for a full breakdown — runes with names (keystone prominent), summoner spells, final build, item build order as a minute-by-minute timeline, and a per-level 1–18 skill order. Full-screen on mobile, modal on desktop. Pro-play games show what on-stage data allows, with a note.
### Changed
- The inline "Details" expander on game cards is gone — the whole card opens the detail view.
- Player search no longer shows a "type at least 2 characters" hint while typing.

## [0.9.0] — 2026-07-10
### Removed
- **CoachBuild Score removed** (user preference): the per-game 0-100 score, S–D grade chip, and CS/min + KP micro-stats are gone from the Pro's page and the /api/pros response. The underlying stats columns and ingest stay (data keeps accumulating, nothing shown).
### Changed
- **Pickers are direct-type**: the player and champion search fields are now real inputs — tap, keyboard opens, type, results appear. No more second box opening to type into.
- "Pro History" renamed to **"Pro's"** (tab + page heading).

## [0.8.0] — 2026-07-10
### Added
- **CoachBuild Score**: every solo-queue pro game now carries a 0-100 performance score and S/A/B/C/D grade (blended KDA curve + CS/min pace + kill participation + win bonus — formula documented in `lib/pro/score.ts`). Rendered as a color-graded chip in the Pro History game row; CS/min and KP micro-stats in the expandable panel. All 1134 historical games backfilled with the stats the formula needs (migration 0004: cs, damage to champions, team kills, gold). Pro-play (on-stage) games deliberately show no score — Leaguepedia data can't feed the full formula, and a degraded score next to a full one read as a real performance gap.
### Changed
- **dpm.lol-inspired reskin**: warm charcoal base, glassy translucent cards, cyan/lavender accents, Plus Jakarta Sans, WPA count-up motion (respects reduced-motion), and a denser single-line Pro History game row (full runes moved into the expandable panel). Focus rings on all pills/buttons; AA+ contrast throughout.

## [0.7.8] — 2026-07-10
### Changed
- **Builds and pro games are now fully separate** (user request): the Pro Games section no longer renders inline on the Builds page — pro history lives only in the Pro History tab. Home page loads 100 kB lighter.
### Added
- KR mains for 9 pros (Chovy, Zeus, Canyon, Gumayusi, Kanavi, Keria, Kiin, Oner, Peyz) via Leaguepedia SoloqueueIds, each validated through Riot account-v1 — +129 current KR solo-queue games.

## [0.7.7] — 2026-07-10
### Fixed
- **Pro-play extraction handles CargoExport response shapes**: list fields (Items, SummonerSpells) arrive as JSON arrays and K/D/A as JSON numbers via CargoExport (api.php serves delimited/numeric strings) — extraction now accepts both.
- **Tournament resolver false positives**: league codes are prefix-anchored ("LCK/…"), so LPLOL and "Schneider Electric …" no longer match LPL/LEC; MSI 2026 recognized by its real page name "2026 Mid-Season Invitational".
- `--via-export` retries once (~10s) on a transient Cloudflare challenge.

## [0.7.6] — 2026-07-10
### Added
- **CargoExport ingest transport** (`scripts/ingest-prostage.mjs --via-export`): Leaguepedia's api.php cargoquery anonymous rate limit proved unusably aggressive (trips after ~1 call, sticky, escalating — from every IP tried). `Special:CargoExport` serves the same Cargo queries rate-limit-free; the local backfill now queries it through a curl subprocess transport (Node's TLS fingerprint gets Cloudflare-challenged; curl's mostly doesn't). The prod route/cron keeps the api.php path.

## [0.7.5] — 2026-07-10
### Fixed
- **Pro-play tournament resolver no longer selects unplayed tournaments.** The 90-day window matched future events (next Worlds, unstarted playoffs), which filled all 7 ingest slots ahead of tournaments with real scoreboard data (MSI, LEC Summer, LPL) — the pro-play table stayed empty since v0.7.0. Resolver now requires DateStart <= today and excludes Academy pages (they match tier-1 name patterns but carry no scoreboard rows).

## [0.7.4] — 2026-07-10
### Fixed
- Champion display names on pro-game cards (Wukong, not Riot's internal MonkeyKing).
### Added
- SoloQ account riot ID shown small on each game card (pros have several accounts — now you can tell which one played).
- Bin (BLG) tracked via his active KR account — 20 current games with full build order.

## [0.7.3] — 2026-07-10
### Changed
- **Accounts now follow the player's pro-team region** (T1/LCK → KR, G2/LEC → EUW, etc. — curated tier-1 team map; unmapped/ex-pro teams keep all accounts). Off-region bootcamp smurfs no longer feed match history.
- Faker tracked via his real KR main (Hide on bush#KR1) — 20 current games. Bwipo (ex-pro) added with all accounts.

## [0.7.2] — 2026-07-10
### Fixed
- **Freshness window (90 days)** on all pro-game queries, player game counts, and match ingest (Riot startTime filter). Stale bootcamp history (e.g. Faker's Oct-2024 Worlds EUW games) no longer serves as "recent" — builds are patch-relative and months-old games are misleading.
- New scripts/ingest-player.mjs <name> — targeted on-demand fill for one player (jumps the backfill queue).

## [0.7.1] — 2026-07-09
### Fixed
- Pro-play ingest MWException: `Patch` is not a column on Leaguepedia's `ScoreboardPlayers` (verified against the table's CargoDeclare schema) — removed from the query; pro-stage `patch` is now always null (icon URLs fall back to a pinned version).

## [0.7.0] — 2026-07-09
### Added
- **Official pro-play (on-stage) games** via Leaguepedia (CC BY-SA, attributed): final build, runes, spells, result per player per game, in a new `coachbuild.prostage_matches` table with name→id resolution through ddragon. No purchase/skill order — that data does not exist in any free source for stage games.
- **Source filter** "All | Solo Queue | Pro Play" on the home Pro Games section and both History modes. Pro-play cards: gold badge, tournament name, no timeline panel.
- **Cross-region roster seeding** (`scripts/seed-crossregion.mjs`): ~40 famous non-EUW pros via lolpros profiles (Faker, Chovy, Zeus... searchable now via their EUW bootcamp accounts; KR mains pending a Leaguepedia retry).
- Guarded `/api/ingest/prostage` + staleness-rotated daily cron (stalest tournament first, so all leagues cycle).
### Fixed
- Null-role pro-stage rows stay visible (lane label omitted) instead of silently vanishing — guards against Leaguepedia Role-vocabulary drift.
- Rune/spell row hidden on cards with no rune/spell data (no empty rings).
### Known
- Pro-play table ships empty: Leaguepedia rate limiting + an MWException on the ScoreboardPlayers query blocked the first ingest; query fix + retry queued. UI degrades to a friendly empty state.

## [0.6.0] — 2026-07-09
### Added
- **Pro History tab** (`/history`) — search by pro player name or champion name; games are shown only after a selection. Player mode: debounced typeahead over tracked pros (team, lane, game count). Champion mode: the familiar champion picker + optional lane filter. Player-mode cards show the champion icon + name.
- Tab navigation (Builds | Pro History) on both pages.
- `GET /api/players?q=` — player typeahead search (wildcard-escaped, game counts included).
- `GET /api/pros?proId=` — all recent games by one player (role optional; exactly one of proId/championId required).
### Fixed
- Champion-icon slot no longer renders as an empty circle on cards without a resolved icon.
- Player search: selecting a result now invalidates in-flight searches (stale-list race).

## [0.5.0] — 2026-07-09
### Added
- **Pro Games section** — recent solo-queue games by tracked pro players for the selected champion (+lane when a concrete lane is picked; the default "auto" view shows all lanes with a per-card lane label). Each card: player/team, region, result, KDA, patch, game length, final items + trinket, full rune page (keystone, minors, shards), summoner spells, and an expandable detail with the undo-adjusted item purchase timeline and skill order.
- **Pro data pipeline** (personal-use scale): roster from lolpros.gg (accounts, smurf/rename history, PUUID with riot-id fallback resolution), matches from Riot match-v5 + timeline (rate-paced, idempotent upserts), stored in a dedicated `coachbuild` Postgres schema. Guarded `/api/ingest/*` routes + local runner scripts; daily Vercel cron.
- `GET /api/pros` — champion(+lane) query over ingested pro games; role 5 = all lanes.
### Notes
- Requires `DATABASE_URL`, `RIOT_API_KEY`, `CRON_SECRET` env vars for live data; the app degrades to a friendly empty state without them.

## [0.4.1] — 2026-07-06
### Fixed
- **Icon versions now track the data patch.** Rune/item/champion/spell icon URLs derive from the dynamically-resolved patch (CDN evidence-checked: icons exist for all recent patches, including ones without stats data yet) with a static floor fallback. The hardcoded `RUNE_VER`/`ASSET_VER` pins are gone, so icons can no longer age behind the self-advancing data patch.
- **Patch probe hardened**: 4s timeout per candidate (a hung upstream socket can't stall the first cold request) and a single-flight guard (concurrent cold requests share one probe walk).
- "Most played" label threshold aligned with the visual red cutoff (only shows next to numbers that actually render red); a parametrized test pins the two thresholds together.

## [0.4.0] — 2026-07-06
Review-driven release (2026-07-06 audit: 15.5/20; all findings fixed).
### Fixed
- **Data patch no longer frozen.** `getLatestPatch()` was a hardcoded 16.11 literal; it now probes ddragon's newest versions against coachless and picks the newest one with populated data (16.12 today), cached 6h with last-known-good and a 16.11 static floor as fallbacks. The app self-advances every patch from now on.
- **Recovered `app/api/build/route.ts` into version control.** The `.gitignore` rule `build/` had silently swallowed the route directory — the file serving the entire app was never committed and was missing from this checkout (recovered from the Vercel deployment; rule scoped to `/build/`). Restores the 7 route tests that could not run.
### Added
- **Low-sample caution surfaced.** Item alternatives and rune tiles now show sample counts and a quiet ⚠ on low-sample picks (the `lowSample` flag was computed but never rendered — a 1K-sample alt no longer masquerades as 10x better than a 117K-sample pick).
- **"Most played" label** on headline keystones with negative WPA, explaining the red number on the top pick (most-adopted-keystone ranking is intentional).
### Removed
- Dead `<StatBadge>` component (helpers extracted; glyph now rendered inline).

## [0.3.2] — 2026-06-14
### Added
- Full keyboard navigation + ARIA combobox semantics in the champion picker (Up/Down/Home/End to move, Enter to select, opens at the current pick, `aria-activedescendant`).
- Route-level tests for /api/build status mapping (404 for not-played/empty, 400 for bad params, 500 with no detail leak) — closes the integration-test gap that let the earlier bugs ship. 19 tests total.
### Removed
- Dead `getSecondaryTreePlaycount` export (the engine computes its own secondary ranking).

## [0.3.1] — 2026-06-14
### Fixed (full bug sweep — 3 cold-start audits + 108-combo convergence sweep)
- **Off-role / unknown-champ queries now return 404, not 500** (recommend.ts threw plain `Error` at 3 sites; now `NotPlayedInRoleError`). 0 crashes across 108 champ/role combos.
- **EmptyState now actually shows** for not-played combos instead of a misleading Viktor sample under a wrong heading. The header always reflects the selected champion + role (page.tsx).
- **No more duplicate "Flash, Flash" spells** — distinct-spell selection (`pickSpells`), fills Ignite when only Flash is adopted. Regression tests added.
- **Keystone picks the best-WPA option among adopted** within a tree (Thresh now Guardian over Aftershock), while trees still rank by adoption (no off-meta primary).
- Role label / pill no longer desync on "Auto" (role 5); strict API param validation (rejects `2x`/`86.5`); 500s no longer leak internal error text.
- **Service worker is now network-first for the app shell** (a redeploy serves fresh HTML even without a version bump) and only caches `res.ok` responses.
- Picker closes on Escape; collision-safe React keys; footer text meets AA contrast.

## [0.3.0] — 2026-06-14
### Added
- **Per-slot item alternatives** — each item slot now shows situational swaps (an "or" row), e.g. Plated Steelcaps vs AD, Mercury's vs MR. There is one dominant core path per champ (verified against the data), with viable per-slot options rather than 3 separate item builds.
- **PWA**: installable with a web manifest, icons, theme colour, and a service worker whose cache is tied to the app version.
### Fixed
- Version number now actually renders in the footer (was reading the wrong env var). Single source = package.json, inlined as `NEXT_PUBLIC_APP_VERSION`.
- SW cache name is `coachbuild-v<version>`; bumping the version rotates the cache and evicts stale ones, so installed PWAs never serve an old UI.

## [0.2.0] — 2026-06-14
### Changed
- **Every primary tree is now evaluated**, not just the most-played keystone. Variants can differ in primary tree + keystone + primary runes (e.g. Graves: Dark Harvest vs Fleet Footwork; Yasuo: Lethal Tempo vs Grasp). Variants prefer different primary trees, falling back to secondary variation when one primary dominates (e.g. Viktor stays Sorcery, varies secondary).
- Variant subtitles now show the full rune identity ("Sorcery + Precision").

## [0.1.0] — 2026-06-14
### Added
- Champion + lane rune/item recommender powered by coachless.gg's WPA API (Next.js 14 + TS + Tailwind, serverless proxy).
- **Top-3 setups** per champion + lane (one per best secondary tree), ranked by confidence-weighted WPA.
- **All-trees** rune evaluation: compares every secondary tree, not just the default pairing.
- Confidence-weighted ranking: headline pick = most-played positive (reliable); alternatives = best-WPA above a noise floor; viability filter drops weak trees.
- Role coverage Top/Jungle/Mid/Bot/Support, with support-item slot handling.
- Modern coachless-style UI: rune pages, shards, item path, summoner spells, WPA + win rate + sample per pick.
