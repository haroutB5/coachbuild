<!-- merged into HANDOFF.md 2026-07-26 21:11:30Z; previous content preserved there. Append new rounds below. -->

# HANDOFF — engy — in-game "level this next" on /compact, 2026-07-27

Follow-on to v0.64.0 (skill-order source/API). **Not versioned, not changelogged, not committed, not deployed** — per brief.

Working tree at handoff: `package.json` still **0.64.0**. Companion `Version` bumped **1.7.0 → 1.8.0** (see "Companion version" below — flag if you disagree).

---

## 1. What was built

| File | What |
|---|---|
| `lib/nextSkill.ts` | **NEW.** Pure resolver: recommended order + live level + live ranks → which ability to level next, or an explicit refusal. Also `parseLiveSkillState` (narrowing guard for the companion response). |
| `lib/__tests__/nextSkill.test.ts` | **NEW.** 34 tests. |
| `public/companion.ps1` | `GET /skills`; `ConvertTo-LiveSkillState` (pure) + `ConvertTo-LiveSkillRank` + `Get-LiveSkillState` (I/O); SelfTest 4f (route) and 8e (shaper); `Version` → 1.8.0; wire-contract header entry. |
| `components/live/companionClient.ts` | `getSkills()`, `SKILL_POLL_MS = 1000`. |
| `components/__tests__/companionClient.test.ts` | +7 tests for `getSkills` degradation. |
| `components/hextech/SkillOrderNextPanel.tsx` | **NEW.** The panel. Renders `null` in every state but one. |
| `app/compact/page.tsx` | Mounts the panel above the champion header, outside the build-fetch state branch. |
| `CLAUDE.md` | Companion section + pipeline map entries. |

---

## 2. The resolver's contract

```ts
resolveNextSkill({ model, level, ranks }) ->
  | { kind: "recommend", ability, fromRank, toRank, atLevel, unspent }
  | { kind: "none", because: NextSkillRefusal }
```

**The derivation.** `unspent = level − (Q+W+E+R)`. The order is indexed by **points spent, not by level** — `order[spent]` is the recommendation for the next point. Those coincide in ordinary play; they diverge for a player holding points back, which is the exact case the panel exists for. Indexing by `level` there would skip a rank permanently.

The passive is excluded **structurally**: `RANKABLE` is the closed set `["Q","W","E","R"]` and nothing else is ever summed. A payload carrying a `Passive` entry contributes zero (tested).

**How it refuses.** Eleven named refusals, all rendering nothing, none an error:

| `because` | When |
|---|---|
| `no-model` | No recommended order (unsupported role, Kha'Zix — `lib/opgg.ts` rejects his `R-Q`/`R-W` evolution tokens outright) |
| `bad-level` | Level not an integer in 1..18 |
| `bad-ranks` | A rank isn't a non-negative integer, or the four sum past 18 |
| `non-standard-kit` | A live rank exceeds 5/5/5/3 → Udyr, Aphelios, Jayce, Yuumi. Caught by **arithmetic on the champion's own data**, not a name blocklist that would rot on the next rework |
| `over-spent` | `sum(ranks) > level` — impossible in a real game, so the reading is incoherent (see §4 on atomic reads) |
| `no-unspent` | Nothing banked. The overwhelmingly common in-game state |
| `model-incomplete` | **The brief's headline rule.** `completed:false` + the 16th point is due → say nothing past level 15 |
| `order-exhausted` | Ran off the end of a *complete* order. Unreachable through the public contract; asserted anyway via a hand-built 3-long model |
| `capped-ability` | The order names an ability already at cap — i.e. the player deviated. We do **not** re-plan around the deviation; re-planning would be inventing an order the source never published |
| `ultimate-illegal` | The order names R at a level the game won't allow it (R2 <11, R3 <16) |
| `bad-order` | A non-Q/W/E/R token reached the resolver |

**`ultimate-illegal` is not defensive padding — it is load-bearing.** Seven champions (JINX, ZED, KASSADIN, SIVIR, CORKI, ZERI, QIYANA — see `skillOrderModel.ts`'s sweep) publish R at level **12**, because the published order is a per-level *modal aggregate* across many games, not one legal path. That's harmless for the rank-count arithmetic `completeSkillOrder` uses, but it is **not** harmless as a live instruction: a player who took R at 6 and 11 arrives at level 12 with R:2, `order[11]` says "R", and R3 needs level 16. Without this guard the panel would tell them to press a key the game will ignore.

A pleasant consequence worth knowing before you assume the guard is dead code: because we only recommend when `unspent >= 1`, always `level > spent === idx`, so `level >= atLevel` — a **legal** order can never trip the guard. It fires only on the modal-aggregate case.

---

## 3. Companion changes

New route, alongside the existing `/live`:

```
GET http://127.0.0.1:<port>/skills?session=<token>
  -> 200 { "level": 9, "abilities": { "Q": 5, "W": 2, "E": 1, "R": 1 } }
  -> 200 { "error": "no-live" }
```

Same origin+session gate as every other route (asserted in SelfTest, not assumed — it's a new entry in the dispatch chain and the gate lives above it).

**Deliberately separate from `/live`, not derived from it.** `/live` is the whole `allgamedata` blob (every player, every score, every item); this is polled once a second by an always-open panel.

**`/liveclientdata/activeplayer` is read FIRST and alone.** It carries *both* level and abilities. That is a correctness argument, not a micro-optimisation: level and ranks from two separate HTTP calls can straddle a level-up, and `(level = N+1, ranks summing to N+1)` reads as **zero unspent points at the exact instant the player has one** — the one moment this panel exists for. One request is one atomic snapshot. `/activeplayerabilities` is consulted only if the first response arrives with no abilities block at all.

**All-or-nothing.** `ConvertTo-LiveSkillState` returns `$null` — not a partial object — if any of level/Q/W/E/R is missing or unparseable. A rank defaulted to 0 does not *weaken* `unspent = level − sum(ranks)`, it **inverts** it: a missing W of 3 reads as three extra unspent points and would tell the player to level something three times. I mutation-tested this (changed the guard to `$rank = 0`) and confirmed 3 SelfTest cases go red.

No `Write-ThrottledErrorLog` on the no-game path — "no game running" is true for most of the day and would bury real errors.

Stays inside CLAUDE.md hard rule 5: read-only, own player only, no timers/cooldowns, no enemy data, computes nothing.

**Companion version.** Bumped 1.7.0 → 1.8.0. Not the app semver the brief reserved for you — but `prebuild` regenerates `public/companion.version` from this literal, and `Test-AutoUpdate` compares with `-ne`, so **without the bump no existing user is ever prompted to update and the feature ships invisible**. Revert the literal if you'd rather bump it at ship time.

> **Users must re-run the install one-liner** (`irm https://coachbuild.vercel.app/companion.ps1 | iex`) to get `/skills`. A pre-1.8.0 companion 404s that path; `getSkills` collapses the 404 to `null`, which the panel treats exactly like "no game" — so an un-updated user sees nothing rather than an error. Tag the CHANGELOG entry `(COMPANION CHANGE → 1.8.0 — re-install required)`.

---

## 4. Verified BY EXECUTION vs assumed-and-unexercised

### Verified by execution

- **The pure resolver.** 34 vitest cases, including an 18-level walk that reproduces Ahri's full order, and an exhaustive sweep over `level × Q × W × E × R` (18×6×6×6×4 = 15,552 inputs) asserting no recommendation ever exceeds a cap, `toRank === fromRank + 1`, `atLevel <= level`, and every R recommendation is at a legal ultimate level.
- **The companion's pure shaper + the all-or-nothing invariant.** SelfTest 8e, plus a mutation test proving the invariant is genuinely pinned.
- **`GET /skills` with no game running** — genuinely executed, not simulated: nothing listens on 2999 here, so SelfTest 4f exercises the real connection-refused path and asserts 200 `{error:'no-live'}`, fast, no stack trace. This is the endpoint's most load-bearing behaviour (a closed game is the normal state) and it is the one live-adjacent thing that *is* fully verifiable without League.
- **`/skills` origin + session gating** — real HTTP round trips, both 403.
- **`getSkills` degradation** — 404 (old companion), `{error:'no-live'}`, partial body, network throw, non-JSON body all collapse to `null`.
- **The panel renders NOTHING with no live data** — real Chrome, **fresh `userDataDir`** so no stale service worker could serve an old shell. Two URLs (`/compact` cold, and `/compact?championId=103&role=2&session=…`, the shape the companion opens). Asserted: no panel node, no "Level next" text, wrapper height 0, **`/skills` never polled at all** (the `phase === "InProgress"` gate), no unexpected failed requests, no page errors. 12/12.
- **The panel renders CORRECTLY when a reading of the documented shape arrives** — same browser, `/skills` and `/status` fulfilled by request interception, but `/api/skill-order` **left real** (real route, real upstream, real Ahri-mid model). 40/40 across: recommend W 2→3, banked-points (3 banked → advises the 8th point, not the 10th), recommend R 0→1, no-unspent → absent, `{error:'no-live'}` → absent, partial reading → absent. Also pinned: panel sits above the champion header, ≤64px tall, no horizontal overflow at 380px.
- `verify-fix.sh` — tsc, lint (0 warnings), 1806 tests, build, sw, manifest.

Smoke harnesses live at `C:/Claude/AI/urgot/.smoke-tools/cb-compact-skill-smoke.mjs` and `cb-compact-skill-render.mjs` (run against `next start -p 3111`).

### Assumed and UNEXERCISED — the honest list

1. **No response from `https://127.0.0.1:2999/liveclientdata/activeplayer` has ever been observed.** There is no League client on this machine. `level` and `abilities.{Q,W,E,R}.abilityLevel` come from Riot's **published schema**, not a captured payload.
2. **Therefore the whole live path is unexercised end to end.** The companion has never talked to 2999 successfully; the browser has never received a real `/skills` reading. The render check above fabricated its responses and says so, in the script and in its output.
3. **`abilityLevel` on form-swap champions is genuinely unknown.** Jayce, Elise, Nidalee, Karma, Gnar, Kayn — does `activeplayerabilities` report the *current form's* abilities, both forms, or something else? No idea. If a key is missing the shaper returns `$null` and the panel stays absent (safe), but if it reports the *transformed* form's ranks the arithmetic would be wrong-but-plausible. **This is the single most important thing to check on a real machine.**
4. **The champion is assumed, not read back from the game.** The panel resolves against whatever champion `/compact` is showing (champ-select deep link or live follow). `/activeplayer` carries no champion name; getting one means pulling the whole `allgamedata` blob and matching on summoner name. If `/compact` is on the wrong champion its runes and items are *already* wrong — pre-existing, not introduced here — but it does mean a stale deep link yields a confidently wrong skill recommendation. **Worth closing later; deliberately not done in this pass.**
5. **The 2s `TimeoutSec` against a live game is unmeasured.** Connection-refused returns instantly (measured); a real game's response time is not known. If 2s ever proves tight at 1Hz the polls would overlap.
6. **Layout shift is real and was not designed away.** The panel appears at each level-up and disappears when the point is spent, shifting the content below by ~74px each time. Reserving space would contradict the "absent, not empty" requirement, so it was left alone rather than silently traded off. Flagging it as a product decision, not an oversight.

---

## 5. Manual validation — run these on your machine

**Prerequisite:** re-install the companion (`irm https://coachbuild.vercel.app/companion.ps1 | iex`) — 1.7.0 has no `/skills`. Confirm with `GET /status` that `version` reads `1.8.0`.

### Step 1 — Riot's API directly, mid-game (the one that matters)

Get into a game (a **Practice Tool** game is ideal — you can level abilities at will). Then, from PowerShell:

```powershell
# PS 7:
curl.exe -sk https://127.0.0.1:2999/liveclientdata/activeplayer | ConvertFrom-Json | ConvertTo-Json -Depth 5
# PS 5.1 equivalent:
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
Invoke-RestMethod https://127.0.0.1:2999/liveclientdata/activeplayer | ConvertTo-Json -Depth 5
```

**A good response contains**, at minimum:

```json
{
  "level": 9,
  "abilities": {
    "Passive": { "displayName": "...", "rawDescription": "..." },
    "Q": { "abilityLevel": 5, "displayName": "...", "id": "..." },
    "W": { "abilityLevel": 2 },
    "E": { "abilityLevel": 1 },
    "R": { "abilityLevel": 1 }
  },
  "championStats": {},
  "currentGold": 0
}
```

**What to look for — this is the checklist, not decoration:**

- [ ] Is the field literally `level`, at the top level? (Not `championLevel`, not nested under `championStats`.)
- [ ] Is each rank literally `abilities.Q.abilityLevel`? (Not `level`, not `rank`, not `abilityRank`.)
- [ ] Does `Passive` have **no** `abilityLevel`? (If it has one, confirm the shaper still ignores it — it should, it only reads four named keys.)
- [ ] Does `level − (Q+W+E+R)` equal the number of unspent points the HUD is showing you? **Bank a point deliberately and re-check** — this is the arithmetic the whole feature rests on.
- [ ] Compare against `curl.exe -sk https://127.0.0.1:2999/liveclientdata/activeplayerabilities` — same four keys, same values?

### Step 2 — form-swap champions (the genuinely unknown case)

Play **Jayce** (or Elise / Nidalee / Gnar / Kayn), and hit `activeplayerabilities` **in both forms**:

- [ ] Do Q/W/E/R keys still exist in the transformed form?
- [ ] Do the `abilityLevel` values **change** when you transform, or stay fixed?
- [ ] For Jayce specifically: he has six ranks on Q and W. Does a rank ever exceed 5? (If so, `non-standard-kit` fires and the panel correctly shows nothing — that's the intended degrade, and Jayce already has no completed model anyway.)
- [ ] Whatever you find, the panel showing **nothing** is an acceptable outcome; the panel showing a **wrong ability** is not. If you see the latter, that's the finding.

### Step 3 — the companion endpoint

```powershell
# Replace <port> (48291/2/3) and <token> (from companion-session.txt next to companion.ps1).
curl.exe -s -H "Origin: https://coachbuild.vercel.app" "http://127.0.0.1:<port>/skills?session=<token>"
```

- [ ] **Out of game:** `{"error":"no-live"}`, immediately. (Already verified here.)
- [ ] **In game:** `{"level":9,"abilities":{"Q":5,"W":2,"E":1,"R":1}}` — flat integers, no nested objects, exactly four ability keys, matching what Step 1 showed.
- [ ] Run it a few times across a level-up. It must never return a level and a rank-set that disagree.

### Step 4 — the panel, end to end

Open `/compact` on the same PC (pop it onto the second monitor), get into a game on a **standard** champion (Ahri is the reference fixture — Q›W›E, order `WQEQQRQWQWRWWEE`+`REE`):

- [ ] **Before you spend your level-1 point:** panel shows **W**, `0 → 1`.
- [ ] **After spending:** panel **disappears entirely** (no placeholder, no empty box).
- [ ] **At level 6, before spending:** shows **R**, `0 → 1`.
- [ ] **Bank two points, don't spend:** shows "2 points banked" and advises the ability for your **next** point (the lower slot), not the one matching your champion level.
- [ ] **Deliberately max the wrong ability:** panel goes absent once the order's next instruction is capped. It must not invent a 6th rank.
- [ ] **Level 16+ on a champion with `completed:false`** (Udyr, Aphelios, Jayce, Yuumi — check `/api/skill-order?champ=<id>&role=<n>` for `"completed":false`): panel absent past level 15.
- [ ] **Kha'Zix:** no panel at any point (no model at all).
- [ ] **Alt-tab away for a minute and back:** panel still tracks. (Chrome throttles hidden tabs — the 1Hz poll may slow, which is fine; it must not *die*.)
- [ ] **End the game:** panel disappears within a few seconds (the `phase` gate drops it).

---

## 6. Things I deliberately did NOT do

- **No LAN endpoint, no cloud relay, no new network exposure.** `/compact` reaches the companion at `127.0.0.1` exactly like the rest of the app. Phone-over-LAN remains an open decision.
- **No overlay, no HUD writing.** Out of scope by directive.
- **No enemy data of any kind.**
- **No mock of the Live Client Data API in any test suite.** SelfTest 8e's header and `nextSkill.test.ts`'s header both say why, so the next person doesn't "helpfully" add one. A green suite over a fabricated wire format reads as coverage and is worse than none — the cancelled desktop app's 31 tests are the precedent.
- **No re-planning around player deviation.** When the order's next instruction is un-followable we say nothing rather than compute a substitute the source never published.
- **No champion cross-check against the live game** (see assumption 4).
- **Did not bump `package.json`, touch `CHANGELOG.md`, commit, or deploy.**

## 7. Follow-ups worth considering

1. **Champion identity from the game** (assumption 4). `allgamedata` → match `activePlayer.riotIdGameName` against `allPlayers[].championName`. Would make the panel self-validating instead of trusting the deep link. Cost: the heavy blob, or a second endpoint.
2. **Kha'Zix evolutions.** `skillOrderModel.ts` already documents why `R-Q`/`R-W` are rejected rather than normalised. If it's ever worth doing properly, the evolution choice is the part a Kha'Zix player actually reads — a panel that named the evolution would be a genuinely better feature than one that flattened it away.
3. **Widen the resolver to `/` (Builds)?** Deliberately not done — `/compact` is the second-monitor surface and the brief scoped it there.

---
---

# HANDOFF — engy — Recommended skill order (op.gg), 2026-07-27 (PREVIOUS ROUND)

Backend half of the skill-order feature. `fronty` owns the UI half
(`components/hextech/SkillOrderCard.tsx`, `components/hextech/skillOrder.ts`,
the `[grid-area:skillorder]` row in `BuildTabContent.tsx`) — untouched here.

## Files

| File | What |
|---|---|
| `lib/skillOrderModel.ts` | NEW. Pure model + completion rule. No I/O. |
| `lib/opgg.ts` | NEW. The single choke point for `mcp-api.op.gg`. |
| `app/api/skill-order/route.ts` | NEW. `GET /api/skill-order?champ=&role=` |
| `lib/types.ts` | `Ability` + `SkillOrderModel` added (canonical contract). |
| `lib/__tests__/skillOrderModel.test.ts` | incl. exhaustive arithmetic sweep. |
| `lib/__tests__/opgg.test.ts` | incl. real captured payloads. |
| `lib/__tests__/skill-order-route.test.ts` | incl. CROSS-HALF integration. |
| `lib/__tests__/fixtures/opggPayloads.ts` | GENERATED from live responses. Do not hand-edit. |

103 tests across the three new files.

## Contract lives in `lib/types.ts`

`Ability` and `SkillOrderModel` are defined in `lib/types.ts` — the file that
already documents itself as "the single handshake between backend and
frontend". `components/hextech/skillOrder.ts` currently declares its own
identical copy (fronty built before this route existed, and says so in its
header). **They agree exactly today** and there is a test that fails if they
drift (see below), but reconciling to one import is worth doing.

## Field meanings — confirmed against the source's OWN schema

The feed self-describes: `class Skills: order,play,win,pick_rate`.

* `play` — game count.
* `win` — **a WIN COUNT, not a rate.** Ahri mid: 41408 of 71667.
* `pick_rate` — a **share of games, not the win rate**.

So `winRate` is **derived** as `win/play` (0.5778 for Ahri mid); it is never
read off the feed, because the feed does not publish it.

`share` is passed through **verbatim**. Its denominator is not published, and
probing could only bound it (~126k for Ahri mid — neither the position's game
count nor the skill-mastery group's). Inventing a denominator to "verify" it
would be fabrication, so the source's number is reported as the source's number.

### The trap that would have bitten a positional parser

Adding `desired_output_fields` to the request **re-orders the declared fields**
— same champion, same minute:

```
class Skills: order,play,win,pick_rate   ->  Skills([...],71667,41408,0.57)
class Skills: order,pick_rate,play,win   ->  Skills([...],0.57,71667,41408)
```

Positional indices would silently read `pick_rate 0.57` as `play`. The parser
therefore reads the `class Skills:` header and maps **by name**, and refuses
(null) if the declared field SET is not exactly what we understand. Both real
payloads are pinned as fixtures and asserted to parse to identical values.

## Completion rule — derivation, never invention

The source publishes **levels 1-15 only**. Under League's standard 5/5/5/3 rank
model the remaining 3 points are fully **determined by subtraction**, so given
a provably-standard first 15 there is nothing to guess. Ahri mid leaves exactly
R×1 and E×2 → R@16 (6/11/16 are the only ultimate levels), E@17, E@18. That
reproduces U.GG's published Ahri path exactly.

`completed: true` means 16-18 were derived. `completed: false` means the
derivation refused and `order` carries **only the 15 levels the source
reported** — never padded. Refusal reasons: `unexpected-length`,
`bad-token`, `rank-over-cap`, `ultimate-remainder`, `already-complete`,
`tail-mismatch`.

Tested **exhaustively** over every (Q,W,E,R) distribution summing to 15 —
completion happens for exactly the tuples that fit the model and no others, and
every completion lands on 18 levels at exactly 5/5/5/3. The "can't happen"
`tail-mismatch` branch is asserted unreachable rather than assumed.

## Non-standard champions — MEASURED across all 172

Full roster sweep, each champion on its primary lane:

```
160  complete cleanly
  7  complete, but publish R at level 12   (see below)
  4  refused, rank-over-cap  — UDYR, JAYCE, YUUMI, APHELIOS
  1  refused, bad-token      — KHAZIX
```

* **UDYR** Q:6 E:6, "R" ranked at level 2. **APHELIOS** W is a fixed 1-rank
  mechanic so Q/E reach 6. **JAYCE** Q:6 W:6, R never ranked. **YUUMI** Q:6.
  All caught by the cap check — **by arithmetic from their own data, not a
  hardcoded blocklist** that would rot on the next rework.
* **KAYN** was flagged up front as a form-swapper risk. The data says his ranks
  are standard 5/5/5/3, so he completes normally. The arithmetic decides.
* **KHAZIX — the one nobody would have predicted.** His ultimate ranks carry
  **evolution suffixes**: the order contains literal `"R-Q"` and `"R-W"` tokens,
  not `"R"`. He is the only champion of 172 that does this. The parser rejects
  the payload → no card.
  **Deliberate open decision:** mapping `R-Q`→`R` would complete him to a clean,
  plausible 5/5/5/3 **while silently discarding which ability he evolves** — the
  part a Kha'Zix player actually reads. Not guessed at a token grammar we have
  one example of. Worth doing properly if someone wants Kha'Zix to have a card.

### What I did NOT ship, and why

An earlier draft was going to refuse any path ranking R outside the legal
6/11/16. **The sweep killed it.** Seven champions — JINX, ZED, KASSADIN, SIVIR,
CORKI, ZERI, QIYANA — publish R at levels 6 and **12**. That is not a legal
ultimate level, which tells us the published order is a **per-level modal
aggregate across many games, not a single legal path**. Their rank counts are
standard, so their tails are perfectly derivable — the check would have refused
seven popular champions to buy nothing. Their observed 15 is passed through
exactly as published; level 12 is never "corrected" to 11.

## Champion + role mapping

* **Champion:** `ChampionRef.key` (Riot key) → UPPER_SNAKE. Verified by diffing
  op.gg's `lol_list_champions` against **ddragon 16.14.1 by numeric id: 0
  mismatches across all 172**. The five champions whose key-derived name differs
  from their display-name-derived one (Nunu, MonkeyKing, KogMaw, RekSai, Renata)
  were probed live — op.gg accepts **both** forms, so no special-case table is
  needed. No second champion table ships.
* **Roster lag is an expected null:** ddragon lists 173, op.gg 172 — champion
  **805 (Locke)** is absent from op.gg. Unknown champion → JSON-RPC error →
  null → no card. Correct behaviour, not a bug to chase.
* **Role:** 0→top 1→jungle 2→mid 3→adc 4→support. **Role 5 → null.**
  The tool schema advertises `position: "all"`, but the server **rejects** it
  (`{"position":["The selected position is invalid."]}`) for all 172 champions.
  Do not "fix" this by trusting the enum.

## Cache TTL: 6 h (`CACHE_TTL_SECONDS = 21_600`)

Skill orders are patch-scale, so the honest lower bound is "long". The ceiling
is what stops us serving last patch's order for days after a new one lands:
patches are ~2 weeks apart on no schedule we track, so a multi-day TTL would do
exactly that. 6 h bounds staleness to a quarter-day while still collapsing
essentially all real traffic. It is also deliberately **the same 6 h
`lib/coachless.ts` uses** — both feeds render on one Builds page, and two halves
of a page ageing at different rates is worse than either TTL being individually
suboptimal.

Applied at two layers: Next fetch data cache (`next: { revalidate }`) and CDN
`s-maxage=21600, stale-while-revalidate=86400`. **A null response gets
`no-store`** (repo gotcha (b)) — verified live, see below. No in-process
single-flight: this path makes ONE upstream call per request, not ~400 like
patch-movers, and Next's data cache already dedupes it.

Outbound call goes through `lib/fetchTimeout.ts` (repo gotcha (v)).

## Cross-half integration — CHECKED, and it passes

This was the highest-risk item: two independently-correct halves that disagree
on a field name or `null` vs `undefined` would pass both suites and still render
nothing. `lib/__tests__/skill-order-route.test.ts` feeds **this route's real
serialized Response into fronty's real `fetchSkillOrder` + `isSkillOrderModel`**
(imported, not copied) and asserts `{status:"ok"}`. Also pinned:

* `null` payload → fronty's `"hidden"` (renders no card), not `"error"`.
* A refused 15-level model still passes the guard and claims nothing past 15.
* `winRate`/`share` serialize as **explicit `null`**, never a dropped key — if
  they were `undefined`, `JSON.stringify` would omit them and fronty's
  `winRate !== null` check would format `undefined` as a percent.
* Field-name drift between the two halves fails loudly.

## Gates

`bash scripts/verify-fix.sh` — tsc / lint / **1765 tests** / build / sw /
manifest: **ALL CHECKS PASSED**.

Live smoke against `next start` (production build), all four paths:

* `champ=103&role=2` (Ahri mid) → 200, 18 levels, `completed:true`,
  `R:[6,11,16]`, `winRate` 0.5778, `s-maxage=21600`
* `champ=77&role=1` (Udyr) → 200, **15 levels**, `completed:false`, nothing
  past level 15, `s-maxage=21600`
* `champ=121&role=1` (Kha'Zix) → 200 `null`, **`cache-control: no-store`**
* `champ=103&role=5` → 200 `null`, **`no-store`**

## Open / not done

1. **Kha'Zix evolution tokens** — see above. Deliberate no-card.
2. **Rank brackets not wired.** `/api/build` supports `rank=`; op.gg exposes its
   own `tier` param whose example values (`all`, `challenger`, `grandmaster`)
   *look* like they line up with `lib/rankBrackets.ts` ids. **Not verified, so
   not wired** — the app's brackets are coachless `leagueTiers` sets and
   assuming a mapping without probing is how you get a High-Elo build shown
   next to a Platinum skill order. One probe session would settle it.
3. **`game_mode` is hardcoded `"ranked"`.** The enum also offers
   flex/urf/aram/nexus_blitz. Fine for the Builds page; note it if ARAM ever
   gets a surface.
4. **`lib/types.ts` vs `components/hextech/skillOrder.ts` duplicate type** —
   reconcile to one import (drift test guards it meanwhile).
5. **No browser smoke run by me** — I verified the API half at HTTP level only.
   The rendered card is fronty's surface; a puppeteer pass on the Builds page
   would close the loop end-to-end.
6. **Wiki proposal (agents propose, urgot merges):** `wiki/architecture.md`'s
   data-pipeline map should gain an `op.gg` entry — it is now a third external
   provider alongside coachless and u.gg. Suggested gotcha entry: "the op.gg
   payload's declared field ORDER changes with `desired_output_fields`; parse
   the `class` header by name, never by position."
