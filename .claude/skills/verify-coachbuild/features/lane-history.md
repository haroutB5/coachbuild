# Lane history for the marked matchup

When a lane opponent is marked, the page asks the bridge for `/lane-scores/recommendations?enemy=<id>&role=<id>` and shows the user's own best and worst picks into that champion, with average score.

## Driving it with puppeteer-core

Not scripted in this skill. Recipe from `scripts/verify-draft-ui.mjs`: start live with `historyFails: true`, wait for text `Your lane history is unavailable`, set `window.__draftTest.historyFails = false`, click `Retry lane history`, wait for `8.0/10 avg`. This skill's fixture sets `historyEmpty: true`, so the history panel shows no games.

## Gotchas

- The fixture in this skill returns `totalGames: 0`. It does not exercise the populated state.
