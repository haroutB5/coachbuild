# Decisions

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
