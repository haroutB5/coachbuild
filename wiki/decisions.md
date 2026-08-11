# Decisions

- **2026-08-06 — OPTIMIZED ORDER may show a negative-WPA step (user: "leave it").** With the
  strip constrained to the WPA build's own items (v0.100.1), `conditionedLeader` can pick an
  in-build item whose conditioned WPA is negative (Lee Sin: Black Cleaver −0.17) because
  nothing better remains in-build. Deliberately rendered, not hidden — the number is the
  honest read and the user judges. Revisit only if the user asks.
- **2026-08-06 — OTP backfill guards are permanent invariants, not patches.** Support-quest
  finals stay out of non-support recommendation surfaces (`excludeSupportFinalItems`), and the
  slots include-set is floor-clearing ∪ displayed ids — see wiki/gotchas.md "Build-surface
  invariants" for the measured failures each one closes.
- **2026-08-04 — Recorded skill orders are kit-aware end-to-end.** Per-champion caps and R-slot
  semantics come from `lib/championKit.ts` (ddragon-derived; R maxrank ∈ {1,3,4,6} carries the
  semantics) and thread through `aggregateRecordedSkillOrders`, both consumers (featured OTP,
  pro consensus), and every skill grid. Rationale: seven champions genuinely break 5/5/5/3, and
  clamping them rendered false grids (Udyr shown an ultimate he doesn't have; Jayce truncated).
- **2026-08-04 — Extract-time guards drop only PROVABLY impossible events**: non-NORMAL
  levelUpType, and events exceeding the champion's own rank caps (Viego possession phantoms).
  Under-cap phantoms are accepted rather than guessed at. Absence beats invention everywhere:
  aged-out timelines → NULL, never a fabricated order.
- **2026-08-04 — Aggregation follows real played prefixes** (prefix-conditional walk), not
  per-level marginal votes. A rendered order should be an order somebody actually played, as far
  as the data allows.
- **2026-08-04 — Paced batch jobs run detached by the orchestrator**, never inside an agent's
  tool-mediated shell (timeout ceiling). Agents write + smoke-test the script and hand back the
  command. Rule also lives in AGENTS.md house rules.

## Nocturne redesign (v0.104.0, 2026-08-09)

Full-surface redesign from the user's design handoff (`design_handoff_coachbuild_redesign/` — spec,
tokens, prototype, 11 acceptance screenshots). Token swap kept LEGACY NAMES (cyan→gold→blurple
trick) so untouched call sites reskin free. Staged: tokens → shell → Builds∥Draft → Companion∥data
screens → mobile → 4 adversarial audit rounds + scoped final verify. Load-bearing decisions:
- Phase spine + companion card: a step is active/complete ONLY when genuinely polled (honesty rule
  extended to session-observed history; phaseSpineModel has tests now).
- Draft rank model: TIER is a champion property from canonical server rank (single 1..N ladder even
  on the 0-enemy merged recommended+blind list); # column is display position; THE CALL pins to
  server order; filter tabs never re-rank. Sort-invariance is test-locked. KNOWN P2: Blind tab's own
  ladder can disagree with the merged Recommended badge for the same champion — deliberate trade,
  revisit as product question.
- Delta basis is lane average, LABELED as such everywhere; unmeasured renders "—", never ?? 0.
- IN-GAME OVERLAY IS EXEMPT from Nocturne (user directive): native pink #FF2F9E boxes stay; /compact
  + /live-setup preview mirror the real pink; target screenshot 11 (blurple) is overridden. Do not
  "fix" back.
- lib/ stayed logic-untouched except one read-side exposure (matchup matrix full rows for locked
  enemies) with a matrix-equality test; ranking slices untouched.

## 2026-08-11 — "Diamond II and above" was requested; only "Diamond and above" is expressible

The user asked for data from Diamond 2+. coachless filters by TIER with no division axis, so the
request cannot be met exactly. Decision: ship the closest superset (`[6,7,8,9]` — Diamond, Master,
Grandmaster, Challenger) and state the imprecision in the UI ("tiers only, not divisions") rather
than imply an exactness the data cannot support. Revisit only if the provider adds a division filter.

## 2026-08-11 — The hero action buttons perform actions or say why they cannot; they never scroll

IMPORT BUILD and APPLY RUNES were `scrollIntoView` shortcuts wearing action labels. The scroll was
dropped rather than kept alongside the real action: both anchors are inside `display:none` tabpanels
on two of three tabs, and the buttons now report their own state in the hero, which a scroll would
carry off-screen. A blocked action is disabled with a VISIBLE reason — never hidden, never silently
inert.

## 2026-08-11 — The rank tier labels were relabelled, not renumbered

Both were available once the real enum was known. Relabelling keeps every existing query identical
and only corrects what the user reads; renumbering would have changed the data under every cached
build. The subsequent Diamond-and-above change DID renumber, deliberately and visibly, with the cache
key fixed in the same change.

## 2026-08-11 — "Diamond II and above" IS expressible on the draft side, and is shipped there exactly

The decision above (Diamond+ as the closest superset) stands for **Builds**, because coachless has no
division axis. u.gg does: `DIAMOND_2_PLUS = 15`. So the two halves of the app deliberately run on
different brackets — **Builds Diamond+, Draft Diamond II+** — each labelled by what it actually is
rather than forcing a false match between two providers. Revisit only if coachless adds divisions.

## 2026-08-11 — BAN_MIN_MATCHUP_GAMES stays at 1000 because it is a directive, not a calibration

The user named that figure. Every other draft threshold in the v0.109.0 pass was re-derived from the
live tier-15 distribution; this one was deliberately not, because re-deriving it would override an
instruction. Same-class thresholds are no longer pinned equal to each other — that coupling is how a
single July measurement silently propagated into five constants.

## 2026-08-11 — Popularity floors are shares; evidence floors are absolute

A popularity floor answers "is this champion played enough to rank" and must scale with the
population, so it is now expressed as a share of lane games and cannot rot when the bucket moves. An
evidence floor answers "is this number real" and must not scale — scaling `MASS_GATE_MIN_GAMES` by the
8.08x population ratio would have accepted 4-game cells as evidence.

## 2026-08-11 — A gate that withholds data must say so

The pool floor now reports how many champions it held back and at what threshold, and the blind-pick
route distinguishes no-data from all-withheld from no-candidates. A short list and an empty source
must never look identical to the user.
