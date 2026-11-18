# Previous game: score your last ranked lane

After a ranked game the bridge reports a pending game. The user opens the `Previous game` pill, picks the lane opponent and role if unknown, scores 0 to 10, adds a note and saves. The page POSTs one lane score to the bridge.

## Sub-features

- `pending-card` appears when `/lane-scores/pending` returns a game (`[aria-label="Score your last ranked lane"]`).
- `save-gate` keeps `Save score` disabled until opponent, role and score are set.
- `save-post` POSTs `{matchId, score, roleId, opponentChampionId, note}` to `/lane-scores` and clears the card.

## How to get to it (user POV)

Click the `Previous game` pill at the top of the Draft tab.

## Driving it with puppeteer-core

Not scripted in this skill. `scripts/verify-draft-ui.mjs` check `unknown opponent and role require input; save submits once and clears card` is the recipe: override the fixture with `pending: { matchId: 'fixture-ranked', queueId: 420, myChampionId: 106, myChampionName: 'Volibear', roleId: null, opponentChampionId: null, enemyChampionIds: [887, 24] }`, click `[aria-label="Gwen"]`, `select` role `4`, click `[aria-label="Score 8 out of 10"]`, type a note, click `Save score`, then read `window.__draftTest.submissions`.

## Gotchas

- The POST is the only write the page makes. In this skill the bridge is a fixture, so nothing reaches a real `lane-scores.json`. Never point it at a live bridge.
