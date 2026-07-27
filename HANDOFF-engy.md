<!-- merged into HANDOFF.md 2026-07-26 21:11:30Z; previous content preserved there. Append new rounds below. -->

# HANDOFF — engy — Recommended skill order (op.gg), 2026-07-27

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
