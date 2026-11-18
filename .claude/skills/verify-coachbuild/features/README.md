# CoachBuild verification map

The maintained source for what to verify in the CoachBuild desktop UI. Read this index, then the feature file for the screen you changed.

## Baseline preconditions

- Built by `scripts/launch.sh` and passing `scripts/doctor.sh`. The UI is the static export in `desktop/ui/out/`; the WPF shell is out of reach on this laptop.
- Empty state: no `.env*` file, no key, no League client, no `lane-scores.json`. The browser context is a fresh incognito one.
- Page URL `https://coachbuild.local/index.html?session=fixture-session`. The page removes `session` from the URL.
- The outside world is fixtures: bridge on `127.0.0.1:48291` (`/status`, `/lane-scores/pending`, `/lane-scores/recommendations`, `/lane-scores`), ddragon `versions.json` and `champion.json`, and `window.chrome.webview` for u.gg counters. Roster from `desktop/tests/CoachBuild.Core.Tests/Fixtures/champions.live.json`.

## Driving conventions

- Prefer the `aria-label` handles listed in each file over `d25-*` class names or coordinates (classes only for reading table cells).
- Proof is the action plus the state it caused: a screenshot, table text, and what the page sent outward.
- Never point the page at a real bridge. A bridge write replaces whole item sets and rune pages on a real account.

## Features

| File | Feature | Status |
|---|---|---|
| [draft-counters.md](draft-counters.md) | Live draft, mark a lane opponent, u.gg counter tables | Driven by `verify.sh` |
| [previous-game-score.md](previous-game-score.md) | Score the last ranked lane, save through the bridge | Mapped from `scripts/verify-draft-ui.mjs`, not scripted here |
| [manual-picks.md](manual-picks.md) | Pick your champion and enemies by hand, Reset to live | Mapped from `scripts/verify-draft-ui.mjs`, not scripted here |
| [lane-history.md](lane-history.md) | Your lane history for the marked matchup, retry on failure | Mapped from `scripts/verify-draft-ui.mjs`, not scripted here |

The repo's own `npm run test:ui` (`scripts/verify-draft-ui.mjs`) also covers these, but it writes screenshots into the tracked `_evidence/` folder and needs `BROWSER_PATH`. A proof that drives one entry point is incomplete when this map lists others.
