# Architecture (partial — skill-order data path only)

This wiki was started 2026-08-04 from the skill-order overhaul session. Only the surfaces that
session touched are documented; a full read-only sweep should extend this file.

## Skill-order data flow

```
Riot match-v5 timeline
  └─ lib/pro/extract.ts  extractMatch → buildSkillOrder
       (NORMAL-only filter · dedupe · kit-aware budget guard · 18-cap)
       ├─ lib/otp/ingest.ts   → coachbuild.otp_matches.skill_order   (writes only when NULL)
       └─ lib/pro/ingestMatches.ts → coachbuild.pro_matches.skill_order
  └─ scripts/backfill-skill-orders.mjs — re-fetch + rewrite either table (kit-aware candidates)

Read path
  ├─ lib/otp/featured.ts → aggregateRecordedSkillOrders(values, kit) → featured OTP card
  ├─ app/api/pros/route.ts → per-game payload (+kit) → ProConsensusCard aggregate + GameDetailSheet
  └─ kits resolved server-side via lib/staticData.ts (ddragon) → lib/championKit.ts semantics

Rendering
  └─ components/skillOrderGrid.ts (ONE primitive, two fill rules) → SkillGrid.tsx
     · recommendation grids: complete to 18 where derivable
     · factual per-game grids: exactly the levels reached, kit-aware legality/styling
```

## Related but distinct

- `lib/skillOrderModel.ts` — RECOMMENDATION-path model (published sources), already kit-aware
  before this session; `aggregateRecordedSkillOrders` is the RECORDED-path sibling.
- `prostage_matches` (Leaguepedia pro-play) has no skill_order column; pro skill grids come only
  from Riot-sourced `pro_matches`.
