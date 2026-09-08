# CoachBuild — features (desktop 2.0.0, 2026-09-08)

Personal League of Legends coaching companion. **One Windows desktop app.** No
website, no account, no ads, no tracking, no server, no database. It reads your
League client on your own machine and two public data sources, and it writes item
sets and rune pages back into the client.

**v2.0.0 retired the web app.** The six web surfaces — Builds, Draft, Companion,
My Stats, Patch Movers, Pro Players — are gone, along with the app's own item
recommender. What replaced the recommender is the thing people actually wanted:
**the real sites, in the app, importing straight into the client.** The v1 feature
set is preserved in `docs/archive/` and `CHANGELOG.md`.

**Honesty posture (a deliberate feature, not a disclaimer).** Every surface
labels its data as MEASURED, CURATED or JUDGMENT. A missing value renders as an
explicit absence — never a plausible number, never a dash with a unit welded on.
A curated stand-in says so. Nothing personal ever feeds a score.

## The window

Four tabs, one WebView2 window, opened from the tray or automatically when champ
select starts.

| Tab | What it is |
|---|---|
| **Draft** | CoachBuild's own page, shipped inside the app |
| **u.gg** | the real site — auto item-set import, plus a runes button |
| **Coachless** | the real site — auto item-set import |
| **op.gg** | the real site, opened on your own profile |

Each tab loads lazily the first time you visit it, and each keeps its own browser
profile, so a Cloudflare check you pass on one site stays passed and none of them
shares storage with the app's session. There is no address bar: every navigation
starts from a link on a site you chose, and only https is allowed, so a page can
never hand Windows a `steam:` or `ms-settings:` link.

**The site tabs are read-mostly, and that is enforced rather than promised.** The
app runs exactly four scripted reads against them — the runes button, the two item
extractions, and the Coachless walk they share — and the build fails if a fifth
appears anywhere, or if any automated navigation goes somewhere outside the
app's own deep links for the champion you just locked.

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
  leaves the enemy list. (This was a real bug in v1: tagging at three-of-five
  enemies froze the page, so picks four and five never arrived.)
- **Counter picks.** As soon as any enemy is visible, a strip shows the champions
  that beat them in your lane, with matchup win rate, delta and games, from
  lolalytics at Emerald+ on the current patch. Your own most-played champions are
  listed first.
- **The direction is proved, not assumed.** The page being read is the *enemy's*
  counters page, so a champion counts as beating them only when the enemy's own
  win rate against it is below 50%, cross-checked against the card's own sentence.
  Rows under 500 games are not suggested. If the page's shape changes, the strip
  says it could not read it — it never shows an empty list that looks like "no
  champion counters this one".
- **Your champion pool comes from the client.** Your top 20 champions by mastery,
  read live. In v1 this was approximated from your recorded match history; it is
  now the real thing.
- **Live setup** is a section at the bottom of the same page: whether the
  companion is running, whether the client is connected, and what phase you are
  in. There is no separate pairing page and no pairing step — the app is the
  companion.

## Importing builds

- **Item sets import themselves.** When you lock in, and again if you change the
  rank filter or otherwise move the build page you are looking at, the app fetches
  both u.gg's and Coachless's item set for your champion and role in the
  background and writes them into the client **in one go**, so both appear in the
  shop's set list together as `CoachBuild import: {Champion} {Role} (u.gg)` and
  `(Coachless)`. It never touches the tab you are reading.
- **Runes are one click, on u.gg.** The gold **Import runes** button reads the
  build page you are looking at and writes the page into the client. It is hidden
  on Coachless, which has no rune page. A build with no runes still imports the
  items and says so.
- **It never touches anything that is not ours.** The app will not delete or
  overwrite a rune page or item set whose name does not start with `CoachBuild` —
  with one deliberate exception: clicking **Import runes** yourself will replace
  the current page whatever it is called, because a free account has two rune
  slots and a real click is real consent.
- **Exactly one set per champion and role.** Re-importing replaces it in place
  rather than accumulating. The client stores all your item sets as one document
  that is written whole and rejected whole, so an unbounded pile of old sets is
  not a tidiness problem, it is how every one of your own sets stops saving.

## In-game overlay

The skill-order overlay draws over the game and highlights an unspent point.
Position it once with the adjust hotkey and it stays.

**In 2.0.0 it shows live ability state only.** It used to fetch a recommended
levelling order from the app's own server; there is no server, so it does not
show one. It does not invent an order and it does not serve you a stale one from
before the upgrade. Nothing is read from the game beyond your own champion's level
and ability ranks.

Screen capture, OCR and reading game memory are permanently out of scope. The WPA
numbers over the shop, removed in desktop 1.0.23, are not coming back: they were
anchored to one hand-calibrated position while the row they labelled moved
depending on the champion, and the overlay cannot see the screen to find it.

## Tray, updates and setup

- **Tray**: status (app version, phase, companion busy/ready), reopen the window,
  calibrate the overlay, open the log folder, quit.
- **Updates** are checked every two hours, and opportunistically at game end, on
  window close and on resume from sleep — never more than once in ten minutes, and
  never restarting mid-game. A staged update shows a quiet line in the window
  (`Update {version} ready — restart from the tray to apply`) rather than a toast
  that steals focus.
- **Setup is the installer.** There is no key to enter, no account to link, no
  pairing secret and no environment to configure. If the League client is running,
  it works.

## Compliance

- IDs and champion names only. **No summoner names, anywhere.**
- Rune writes are user-clicked or the opt-out-default automatic import. Never a
  polled action taken during a game.
- Item sets are an inert suggestion in the shop panel, the same class of thing as
  any external build-importer.
- No auto-pick, no auto-ban, and no cooldown or timer computation from the
  in-game data feed.
- Only champion picks are read from champ select, which are visible to you before
  the game starts. Nothing about what enemies buy during a game is used.

## Data attribution

- Counter-pick matchup data: **lolalytics**.
- Champion data and icons: **ddragon** (Riot's public CDN).
- Builds, runes and item sets: **u.gg** and **coachless.gg**, read as the sites
  themselves.
- Your own profile page: **op.gg**.
- Everything about your own client: the **League Client API** and the in-game
  **Live Client Data API**, on your own machine.

Nothing leaves your machine except the requests to those public sites. There is no
CoachBuild server to send anything to.

This is a personal, non-commercial project — not endorsed by Riot Games.

## What changed in 2.0.0, plainly

**Gone:** the website and everything only it could do — the app's own WPA build
recommender and its three consensus cards, post-game, My Stats (including LP
tracking and play sessions), Pro Players, Patch Movers, the installable mobile
app, and the PowerShell companion's download page. The scheduled data pipelines
behind all of it are gone too, along with the database they wrote to.

**Kept and now local:** the draft assistant, counter picks, live champ-select
follow, automatic item-set import from both sites, the runes button, the op.gg
tab, the overlay, the tray and the updater.

**Better:** your champion pool is read from the client instead of estimated; the
draft page can no longer be a different version from the app it is running in,
because it ships inside it; and the app needs no key, no database and no internet
service of its own to work.
