# CoachBuild — features (desktop 2.3.2, 2026-09-10)

Personal League of Legends coaching companion. **One Windows desktop app.** No
website, no account, no ads, no tracking, no server, no database. It reads your
League client on your own machine and the build sites you already use, and it
writes item sets and rune pages back into the client.

**Everything is local, and as of 2026-09-09 that is literally true.** v2.0.0
retired the web app; on 2026-09-09 the hosting and the database behind it were
deleted outright. There is no CoachBuild server to send anything to, no account
to sign into and nothing to pay for. The v1 feature set is preserved in
`docs/archive/` and `CHANGELOG.md`.

**Honesty posture (a deliberate feature, not a disclaimer).** Every surface
labels its data as MEASURED, CURATED or JUDGMENT. A missing value renders as an
explicit absence — never a plausible number, never a dash with a unit welded on.
A curated stand-in says so. Nothing personal ever feeds a score.

## The window

Four tabs, one window (the "Research window"), opened from the tray or
automatically when champ select starts.

| Tab | What it is |
|---|---|
| **Draft** | CoachBuild's own page, shipped inside the app |
| **u.gg** | the real site — also the source of counters and skill order |
| **Coachless** | the real site |
| **MyStats** | op.gg, opened on your own profile |

Each tab loads lazily the first time you visit it, and each keeps its own browser
profile, so a Cloudflare check or a cookie banner you clear on one site stays
cleared and none of them shares storage with the app's session. There is no
address bar: every navigation starts from a link on a site you chose, and only
https is allowed, so a page can never hand Windows a `steam:` or `ms-settings:`
link.

**The site tabs are read-mostly, and that is enforced rather than promised.** The
app runs a fixed, named set of scripted reads against them — the item extractors,
the Coachless runes read, the counters read, the skill-order read and the consent
dismissal — and the build fails if a new one appears anywhere, or if any
automated navigation goes somewhere outside the app's own deep links for the
champion you just locked.

**Ads are blocked on the site tabs.** A maintained list of adtech domains is
rejected for u.gg, Coachless, MyStats and the hidden import readers. First-party
content, the sites' CDNs and their consent dialogs are explicitly allowed, so
nothing breaks. The Draft tab never receives the filter, because it has nothing
to filter.

**Tabs you are not using get cleaned up.** A site tab left invisible for ten
minutes has its browser torn down; the button stays and revisiting recreates it
with your cookies and sign-ins intact. The tab you are looking at and Draft are
never torn down.

## Draft

Your lane, your pick, your team, their team — and who beats the champion you are
actually up against.

- **It fills itself in from champ select.** Your lane, the enemies as they lock,
  and your own hover arrive live from the League client. Editing lane, your pick
  or the enemy list puts the page in manual mode until you reset or the next
  champ select starts.
- **Marking your lane opponent is not an edit.** Tagging which enemy you are
  actually laning against is an annotation of live data, so enemy picks keep
  filling in after you tag one — and the tag clears itself if that champion
  leaves the enemy list. (This was a real bug: tagging at three-of-five enemies
  froze the page, so picks four and five never arrived.)
- **Counter picks come from u.gg.** For the selected enemy and lane, at World
  Emerald+ Ranked Solo on the current patch, the strip shows **Best Lane
  Counters** — the fifteen champions with the largest gold lead at 15 minutes
  against them — and **Worst Picks**, the ten with the lowest win rate into them.
  It follows u.gg's own 0.5% matchup pick-rate threshold, and names its source
  and patch on the card. Results are cached for an hour.
- **Your champion pool comes from the client.** Your top 20 champions by mastery,
  read live. In v1 this was approximated from your recorded match history; it is
  now the real thing.
- **Live setup** is a section at the bottom of the same page: whether the
  companion is running, whether the client is connected, and what phase you are
  in. There is no separate pairing page and no pairing step — the app is the
  companion.

**Limitations, plainly.** The counters list is u.gg's data ranked by u.gg's own
numbers: there is no extra sample-size gate of the app's own, and the list is
**not** reordered to put your most-played champions first (an earlier version,
on a different data source, did that). If u.gg's page shape changes or the read
times out, the strip says it could not load — it never shows an empty list that
reads as "nothing counters this champion". Counters need the desktop app: the
page fetches them through the app's own browser, so opening the exported page
anywhere else shows an explicit message rather than blank cards.

## Lane scores — your own matchup history

The counters strip is thousands of strangers' games. This is yours.

**After a ranked game**, the companion window shows a card: *How did your lane
go?* — your champion against the enemy laner, scored **1 to 10**, where 1 is
unplayable and 10 is a free lane. There is an optional note ("what decided the
lane?") and a **Skip this game** button. The card never steals focus and never
pulls you off a tab you are reading; if you ignore it, the game is saved and the
card is waiting next time.

**In champ select**, once an enemy is selected, a panel appears next to the
counters: **"Your lane history vs {Enemy}"**. It lists up to three of your best
champions into that enemy and up to three of your worst, each with its mean score
**and the number of your games behind it**. It is labelled unmistakably as your
own games, so it can never be mistaken for the global data beside it.

### How to use it

1. Play a ranked game (solo/duo or flex).
2. When the game ends, the Research window offers the card. Score the lane, or
   skip it. If the app could not work out who you laned against, it asks you to
   tap one of the five enemy champions first.
3. Next time that champion is on the enemy team in champ select, your history
   with them shows up in Draft.

### Honest limitations

- **Ranked only** — queue 420 (solo/duo) and 440 (flex), and nothing else. Normal
  games, ARAM, and the practice tool never produce a card. This is deliberate:
  a lane score from a normal game is not the same measurement. The side effect is
  that you cannot try the feature out without playing ranked.
- **Nothing is ever inferred backwards.** Scoring Volibear 9/10 into Gwen is a
  fact about picking Volibear when Gwen is already locked. It says nothing about
  Gwen into Volibear, and the app will never report it as if it did.
- **No invented confidence.** The number shown is the plain arithmetic mean of
  your scores, to one decimal, with the sample count next to it. There is no
  weighting, no shrinkage toward the middle, no bar length, no star rating. One
  game is shown as one game.
- **Best and worst never overlap.** The worst list is drawn only from what the
  best list did not take, so the same champion is never printed as both the
  recommendation and the warning. With only one champion recorded, it is in
  "best" and "worst" is empty.
- **When it cannot tell who you laned against, it asks.** Rather than guessing —
  a guessed opponent silently poisons the recommendation forever — it records the
  game as "opponent unknown" and the card asks you to pick. Bot lane used to ask
  every single time, because the ADC and the support both report the same lane;
  since 2.3.1 the client's role field separates them, and it only asks when that
  is missing or unusable too.
- **Existing scores keep the role they were saved with.** Support games recorded
  before 2.3.2 were filed under the bot-lane role, which is not the role champ
  select asks for. Those older scores are **not** rewritten, so a support history
  saved by an earlier build will not appear in the panel. Games from 2.3.2 onward
  are filed correctly.
- **Deduplicated and one-shot.** Each match is offered once. A scored or skipped
  game is never offered again, including after a restart.
- **It stays on your machine.** One file,
  `%LOCALAPPDATA%\CoachBuild\lane-scores.json`, written whole and atomically so a
  crash mid-write cannot corrupt it. Nothing is uploaded. There is no database
  behind this feature and there is not going to be one. Deleting that file
  deletes your history; nothing else knows it existed.

There is also a developer-only switch, `--lane-score-demo`, which renders the
card with fabricated data and writes nothing — two independent locks keep demo
data out of your real history.

## Importing builds

- **Item sets import themselves.** When you hover a champion long enough to look
  deliberate, when you lock in, and again if you move the build page you are
  looking at, the app fetches both u.gg's and Coachless's item set for your
  champion and role in the background and writes them into the client **in one
  go**, so both appear in the shop's set list together as
  `CoachBuild import: {Champion} {Role} (u.gg)` and `(Coachless)`. It never
  touches the tab you are reading.
- **Runes import themselves too — there is no button any more.** Every lock or
  build-page change writes both source pages into the client, named
  `u.gg {Champion}` and `Coachless {Champion}` (with the role in brackets when
  champ select has assigned you one). If only one rune slot is free, u.gg wins.
  Neither page is selected for you unless a page the app owns was already
  current.
- **Coachless items are read as the site presents them.** The top-WPA row per
  build slot — starter, first through fifth item (a sixth for ADC), and boots
  after the first full item — with the purchase sequence shown as one Build order
  row in the shop. Every selection is unique; low-sample choices the site itself
  dims are excluded; a slot the page does not fill is reported as missing rather
  than filled with an invented item.
- **It never touches anything that is not ours.** The app will not delete or
  overwrite a rune page or item set it does not own. Ownership is a name prefix:
  `u.gg `, `Coachless ` or the legacy `CoachBuild`. Applying a rune page by hand
  is the one exception, because a free account has two rune slots and a real
  click is real consent.
- **Exactly one set per champion and role.** Re-importing replaces it in place
  rather than accumulating. The client stores all your item sets as one document
  that is written whole and rejected whole, so an unbounded pile of old sets is
  not a tidiness problem, it is how every one of your own sets stops saving.
- **Cookie walls are handled once.** At the start of an import the app dismisses
  the specific consent dialog it recognises on each site, and says so in the log.
  An unrecognised wall is left alone and the import fails honestly rather than
  clicking something nobody identified.

## In-game overlay

The skill-order overlay draws over the game and highlights an unspent point.
Position it once with the adjust hotkey and it stays.

**Recommended levelling order is back (2.2.7)**, read from u.gg's published Skill
Path for your champion and lane at World Emerald+. It disappeared in 2.0.0 along
with the server that used to supply it. A partial path is shown exactly as
published — the app does not fill in the missing levels with a guess, and it does
not serve you a stale order from a previous game. If u.gg has nothing for that
champion and role, the overlay simply shows live ability state.

Nothing is read from the game beyond your own champion's level and ability ranks.
Screen capture, OCR and reading game memory are permanently out of scope. The WPA
numbers over the shop, removed in desktop 1.0.23, are not coming back: they were
anchored to one hand-calibrated position while the row they labelled moved
depending on the champion, and the overlay cannot see the screen to find it.

## Tray, updates and setup

- **Tray**: status (app version, phase, companion busy/ready), reopen the window,
  calibrate the overlay, open the log folder, quit.
- **Updates** are checked every five minutes in the background, and
  opportunistically at game end, on window close and on resume from sleep. A
  downloaded update applies and restarts on its own when nothing is busy —
  including with the Research window open, which used to block it indefinitely.
  It will never restart during matchmaking, a ready check, champ select, a game
  or a reconnect; a deferred update resumes as soon as that clears.
- **Setup is the installer.** There is no key to enter, no account to link, no
  pairing secret and no environment to configure. If the League client is
  running, it works.

## Compliance

- IDs and champion names only. **No summoner names, anywhere.**
- Rune writes are the automatic import (opt-out default) or your own click. Never
  a polled action taken during a game.
- Item sets are an inert suggestion in the shop panel, the same class of thing as
  any external build-importer.
- No auto-pick, no auto-ban, and no cooldown or timer computation from the
  in-game data feed.
- Only champion picks are read from champ select, which are visible to you before
  the game starts. Nothing about what enemies buy during a game is used.

## Data attribution

- Counter picks, builds, runes, item sets and skill order: **u.gg** and
  **coachless.gg**, read as the sites themselves.
- Champion data and icons: **ddragon** (Riot's public CDN).
- Your own profile page: **op.gg**.
- Everything about your own client: the **League Client API** and the in-game
  **Live Client Data API**, on your own machine.
- Your lane scores: you.

Nothing leaves your machine except the requests to those public sites. There is no
CoachBuild server to send anything to.

This is a personal, non-commercial project — not endorsed by Riot Games.

## What changed since v1, plainly

**Gone (2.0.0):** the website and everything only it could do — the app's own WPA
build recommender and its three consensus cards, post-game, My Stats (including
LP tracking and play sessions), Pro Players, Patch Movers, the installable mobile
app, and the PowerShell companion's download page. The scheduled data pipelines
behind all of it are gone too, along with the database they wrote to.

**Gone for good (2026-09-09):** the Vercel project and the Neon database
themselves were deleted, and the scheduled tasks on this machine were disabled.
A complete backup of the database sits in the repo under
`data-backups/neon-final-20260909/`; nothing reads it.

**Kept and now local:** the draft assistant, counter picks, live champ-select
follow, automatic item-set and rune import from both sites, the MyStats tab, the
overlay, the tray and the updater.

**New since 2.0.0:** automatic rune pages from both sites with no button (2.2.0),
ad blocking on the site tabs (2.2.0), u.gg counters (2.2.4), faster and less
obstructive updates (2.2.5), skill order restored from u.gg (2.2.7), and **lane
scores** (2.3.0–2.3.2).

**Better:** your champion pool is read from the client instead of estimated; the
draft page can no longer be a different version from the app it is running in,
because it ships inside it; and the app needs no key, no database and no internet
service of its own to work.
