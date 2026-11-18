# Manual picks and Reset to live

Outside champ select, or to try a matchup, the user picks their champion and enemies by hand from a combobox. `Reset to live` returns to what the League client reports.

## Driving it with puppeteer-core

Not scripted in this skill. Recipe from `scripts/verify-draft-ui.mjs`: click `[aria-label="Choose your champion"]` (or `Change your champion from Ahri`), type into `input[role="combobox"]`, press Enter, then click `button` with text `Reset to live`. Enemy slots are `[aria-label="Add an enemy champion to slot 1"]` with `input[aria-label="Add an enemy"]`.

## Gotchas

- Escape then Enter must not select a hidden search result.
- Own and enemy pickers open together must keep unique DOM ids.
- A manual edit sticks while the live champ select keeps changing, until Reset to live.
