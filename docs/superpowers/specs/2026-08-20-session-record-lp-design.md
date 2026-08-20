# Session record and LP delta for My Stats

**Status:** approved 2026-08-20. Ships as ONE release: web + desktop 1.0.21 together.
Nothing user-visible until both halves are real (user's explicit call).

## What the user asked for

A win/loss record and an LP gain/loss figure for "the session" on the logged account, where a
session is one sitting of play. **A session that runs past midnight must NOT split into two.**

## Why this is not a small change

`coachbuild.my_matches` already stores `game_creation` and `win`, so **session W/L is pure
derivation over data we already hold, retroactively, for every past session.**

LP is different. `coachbuild.my_account` (migration 0022) holds `rank_tier` / `rank_division` /
`rank_lp` as a SINGLE CURRENT VALUE that is OVERWRITTEN on every refresh. There is no history.
**Riot's match API does not return per-game LP change and never has.** So LP delta needs a new
time series, and it can only be exact from the day capture ships.

Existing sampling is far too sparse to bracket a session: the `/api/ingest/mystats` cron runs once
daily (20:00 UTC) and page loads refresh on a 30-minute TTL. Most sessions would be unknown.

## Decisions taken (do not re-litigate)

1. **Session boundary: a gap of >= 8 hours between consecutive counted games.** User chose "only
   sleep ends it" over 3h/4h/6h. Effectively one session per waking day. Midnight is never a
   boundary; the past-midnight requirement falls out of the gap rule by construction rather than
   from a special case.
2. **Queue scope: ranked solo (420) only.** Already settled by the 2026-07-30 directive encoded in
   `lib/mystats/queues.ts` as HARD RULE 4. Both new queries MUST bind `COUNTED_QUEUE_IDS`;
   `lib/__tests__/mystats-queue-invariant.test.ts` fails any read that forgets.
3. **Unknown LP shows a best estimate, MARKED** (user's call), except where there is no signal at
   all, which shows a dash. Three states, below.
4. **LP is read from the LCU, not the Riot API.** The shared Riot key is the app's scarcest
   resource (`rank.ts` exists almost entirely to conserve it). The LCU read is local and free.

## Components

### 1. `lib/mystats/sessions.ts` (new, pure)

Groups counted matches into sessions. New session when
`game_creation[n] - game_creation[n-1] >= 8h`.

Gaps are measured creation-to-creation because `my_matches` has no duration column, so true idle
time is roughly one game shorter than the measured gap. Immaterial at an 8h threshold. Document it;
do NOT add a column for it.

Sessions are labelled by their START date. A session beginning 22:40 and ending 01:32 is one
session dated the earlier day.

### 2. `lib/mystats/ladder.ts` (new, pure)

`tier + division + lp -> absolute integer`, so Gold I 90 -> Plat IV 10 is **+20**, not -80.

Apex tiers (Master / Grandmaster / Challenger) have no divisions and unbounded LP; handle
explicitly. **This module is the likeliest place for a subtle wrong number. It gets its own
exhaustive test table**: within-tier, promotion, demotion, apex entry, apex-to-apex.

### 3. Migration 0027 - `coachbuild.my_rank_samples`

```
puuid        text        not null
observed_at  timestamptz not null
tier         text
division     text
lp           integer
source       text        not null   -- 'companion' | 'cron' | 'page'
```

Index `(puuid, observed_at DESC)`.

**A retention policy ships WITH this table, not later.** Four tables reached production with no
retention at all and that is a direct contributor to the 2026-08-20 Neon quota exhaustion. Follow
the pattern in `da26db9`.

### 4. `POST /api/mystats/rank-sample` (new)

Gated by the existing shared-secret in `lib/mystats/accountAuth.ts` - the same gate that already
protects companion writes. Do not invent a second auth scheme.

Request:  `{ puuid, tier, division, lp, observedAt, source }`
Response: `{ ok: true }` or `{ ok: false, reason }`

Writes one row. Idempotent on `(puuid, observed_at)`. Never 500s on a duplicate.

### 5. Companion capture (desktop)

`public/companion.ps1` and the C# bridge read ranked LP from the LCU and POST a sample at:
**app start, champ select entry, and game end.**

`companion.ps1` already owns LCU auth (CIM on `LeagueClientUx.exe`, lockfile fallback) and
`Invoke-LcuRaw`, and already calls `/lol-summoner/v1/current-summoner`. Follow that pattern
exactly.

**The exact ranked endpoint path MUST be verified against a real running client before code is
built on it.** League IS installed on this dev box (`C:\Riot Games\League of Legends\`); an earlier
handoff claiming otherwise was wrong. Do NOT hardcode a path taken from memory or a blog post.

Capture fails silently and NEVER blocks or degrades an item-set or rune apply. Same discipline as
the diagnostics lines in `c00d684`.

### 6. Derivation and the three confidence states

`sessionLpDelta(session, samples)` returns one of:

- **`exact`** - a sample exists strictly between the previous session's last game and this
  session's first game, AND a sample exists at or after this session's last game, with no counted
  games between those two samples other than the session's own. Render a plain signed number.
- **`approximate`** - samples exist but the bracket is one-sided or contains games outside the
  session. Render the number WITH A MARKER, and carry the reason plus the count of extra games in
  the payload so the UI can explain it.
- **`unavailable`** - no usable samples. Every session predating capture is in this state. Render
  a dash. **Do not synthesise a number from win count; that is invention, not estimation.**

### 7. API and UI

`/api/mystats/summary` gains `sessions`: the last 10, each
`{ startedAt, endedAt, wins, losses, lpDelta: { value, confidence, reason?, extraGames? } }`.

A new panel renders one row per session: time range, `5W 3L`, and the LP delta signed and coloured,
with a marker on `approximate`. Follow the section's existing card/row pattern; do not introduce a
new visual language.

## Testing

- Session boundaries: midnight-spanning (the headline requirement), exactly-8h, just-under-8h,
  single game, empty history.
- Ladder: the exhaustive table above.
- Confidence: one case per state, including the contaminated bracket.
- Queue invariant: both new queries bind `COUNTED_QUEUE_IDS`.

## Out of scope

Flex queue. Per-game LP attribution (only session totals). Backfilling LP before capture exists.
