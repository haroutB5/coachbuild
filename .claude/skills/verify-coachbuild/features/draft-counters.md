# Draft: lane opponent and counters

During champion select the Draft tab shows your champion and the enemy team. Marking one enemy as your lane opponent loads u.gg counters for that matchup into two tables.

## Sub-features

- `live-picks` shows the League client's champ select as your champion and enemy slots (`/status` poll).
- `lane-mark` marks an enemy as your lane opponent and shows a `Lane opponent` pill. With no mark the first visible enemy drives the counters.
- `counter-request` asks the native u.gg reader (`ugg-counters` webview message, slug from the champion key, lane from your role).
- `counter-tables` ranks the rows: `Highest lane gold advantage` (Top, by gold at 15) and `Lowest match win rates` (Bottom, by win rate). u.gg rows are the enemy's view and are flipped. Pick rate under 0.5 is dropped, duplicate champions are dropped.
- `small-sample` warns `Small samples` when any shown row has fewer than 20 games.

## How to get to it (user POV)

- Open the Draft tab while in champ select. Your pick shows in the top slot, enemies appear as they lock.
- Click an enemy's portrait button (or leave it unmarked and the first enemy is used) (`Mark <Name> as your lane opponent`).
- Read the two tables under `Counters vs <Name>`.

## Driving it with puppeteer-core

Preconditions: launch and doctor passed. `scripts/drive-draft-counters.mjs` does every step.

- **Start.** Load `https://coachbuild.local/index.html?session=fixture-session`. Wait for the text `Companion test` (a screen-reader heading) and `[aria-label="Change your champion from Ahri"]`. Unmarked, the app already shows `Counters vs Aatrox` (the first visible enemy) with the hint `Without a mark, counters use the first visible enemy.` and no `Lane opponent` pill. `enemyId === null` (tables read `No matchup selected.`) only happens with no enemy in the draft.
- **Mark.** Click `[aria-label="Mark Aatrox as your lane opponent"]`. The `Lane opponent` pill appears and `Patch 16.18` shows. `window.__draftTest.counterRequests` starts with `{slug:"aatrox", enemy:266, lane:"top"}`, sent on load. The mark itself does not refetch: marking the enemy already shown only adds the pill.
- **Tables.** `#d25-table-best .d25-trow` and `#d25-table-worst .d25-trow` hold ten rows each, badges `Top 10` and `Bottom 10`, `.d25-warn` reads `Small samples`. Best starts `Annie +1,500 1,200`, worst starts `Volibear 35.00% 8`. `Jax` (pick rate 0.3) is absent and `Annie` appears once.
- **Switch.** Click `[aria-label="Mark Darius as your lane opponent"]`. Heading `Counters vs Darius` and a second request with slug `darius`.
- **Proof.** `01-draft-live.png`, `02-counters-aatrox.png`, `03-counters-darius.png`, `drive.log`, `drive.json` in `.scratch/verify-coachbuild/evidence/<stamp>/`.

## Gotchas

- The u.gg numbers are synthetic. Names are real champion names from the roster fixture because ids must resolve. The page does not know the fixture is fake, which is the point.
- The tables hold up to 15 best rows but the fixture has only ten eligible, so this proves no limit (`UGG_BEST_LIMIT`).
- `localCounters.ts` caches an answer for an hour per enemy, lane and patch. A second look at an enemy already loaded in the same page does not reach the reader again. The drive switches to a second enemy on purpose so a second request is observable.
- `Companion test` is a visually hidden heading. Wait for it before anything else; the page renders nothing useful until ddragon JSON resolves.
- The lane sent to u.gg comes from `champSelect.roleId` (0 maps to `top` in the fixture). A change to the role mapping shows in `drive.json`.
