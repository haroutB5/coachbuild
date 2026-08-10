// ─────────────────────────────────────────────────────────────────────────────
// otpRunePage.ts — the OTP rune GRID ADAPTER: turn the featured one-trick's
// stored page plus its per-slot counts into the shared `RunePageGridPage` the
// rune grid renders.
//
// Extracted out of FeaturedOtpCard.tsx (v0.105.2) for the same reason
// mostBuiltPath.ts was: this repo cannot import a JSX-bearing module from a
// plain .ts test, and the property worth testing here is precisely that the
// FRACTION THE GRID DRAWS is the one the aggregation computed. A test that
// could only check the aggregation would leave the adapter — the half that can
// silently attach a number to the wrong icon — unverified.
//
// ── The one rule this file exists to enforce ────────────────────────────────
// A fraction is drawn ONLY when the count's own `runeId` equals the rune the
// grid is about to draw in that slot (`slotGridSample`). The aggregation in
// lib/otp/featured.ts places counts by row; this adapter places icons by row;
// if the two ever drift, the guard drops the number and the slot renders bare
// rather than captioning one rune with another's count. Absence beats a wrong
// number — the standing rule on every count surface in this app.
//
// Runtime imports stay JSX-free on purpose. `SHARD_ROWS` lives in
// BuildVisuals.tsx and is passed IN rather than imported, so this module (and
// its test) never pull a component tree in.
// ─────────────────────────────────────────────────────────────────────────────

import type { Pick as RunePick } from "@/lib/types";
import type { OtpRunePageSamples, OtpRuneSlotSample } from "@/lib/otp/featured";
import { shardIconUrl, shardName, treeIconUrl, treeName } from "@/components/proAssets";
import { PERK_TREES, primaryMinorRow } from "./perkSlots";
import type { RuneGridSample, RunePageGridPage, RunePageGridRow } from "./builds/BuildVisuals";

/** The stored page shape the card renders and the apply button writes.
 *  Structurally identical to ProConsensusCard's `OtpRunePageForApply`; declared
 *  here so this module stays free of runtime imports from a .tsx. */
export interface OtpGridRunePage {
  primaryTree: number | null;
  keystone: number | null;
  primary: number[];
  secondaryTree: number | null;
  secondary: number[];
  shards: number[];
}

export type RuneDisplayLookup = (id: number) => { name: string; icon: string };

/** A slot's count, but only when it provably belongs to the rune being drawn.
 *  Every other case — no count, a count for a different rune, an empty or
 *  impossible sample — yields `null`, and the grid then draws no fraction. */
export function slotGridSample(
  slot: OtpRuneSlotSample | null | undefined,
  shownId: number | null
): RuneGridSample | null {
  if (!slot || shownId == null) return null;
  if (slot.runeId !== shownId) return null;
  if (slot.sampleSize <= 0 || slot.count < 0 || slot.count > slot.sampleSize) return null;
  return { count: slot.count, denominator: slot.sampleSize };
}

export function otpRunePick(id: number, runeOf: RuneDisplayLookup): RunePick {
  const display = runeOf(id);
  return { id, name: display.name, icon: display.icon, wpa: 0, winrate: null, occurrence: 0 };
}

export function otpStaticRuneRow(
  optionIds: readonly number[],
  selectedId: number | null,
  runeOf: RuneDisplayLookup,
  sample: RuneGridSample | null = null
): RunePageGridRow {
  const ids = [...new Set([...optionIds, ...(selectedId == null ? [] : [selectedId])])];
  return {
    options: ids.map((id) => ({ ...otpRunePick(id, runeOf), occurrence: id === selectedId && sample ? sample.count : 0 })),
    selectedIds: selectedId == null ? new Set<number>() : new Set([selectedId]),
    sample,
    empty: selectedId == null,
  };
}

export function otpStaticShardRow(
  optionIds: readonly number[],
  selectedId: number | null,
  sample: RuneGridSample | null
): RunePageGridRow {
  const ids = [...new Set([...optionIds, ...(selectedId == null ? [] : [selectedId])])];
  return {
    options: ids.map((id) => ({
      id,
      name: shardName(id),
      icon: shardIconUrl(id),
      wpa: 0,
      winrate: null,
      occurrence: id === selectedId && sample ? sample.count : 0,
    } satisfies RunePick)),
    selectedIds: selectedId == null ? new Set<number>() : new Set([selectedId]),
    sample,
    empty: selectedId == null,
  };
}

/** Combine the complete static rune tree with the one page this model carries.
 *  Every static alternative stays visible, every slot the page does not fill
 *  stays an explicit empty marker, and every slot it DOES fill carries its own
 *  count when one exists for that exact rune.
 *
 *  Primary minors are placed POSITIONALLY (Riot serialises the three primary
 *  selections in row order) and secondary picks are placed through the
 *  perkSlots row map, first claim wins — the same two rules
 *  `buildRunePageSamples` counts by, which is what keeps a number under the
 *  rune it is about. A secondary id of unknown or already-claimed row stays
 *  visible in `unmapped` instead of being guessed into a slot. */
export function otpRunePage(
  page: OtpGridRunePage,
  runeOf: RuneDisplayLookup,
  slots: OtpRunePageSamples | null | undefined,
  shardRows: readonly (readonly number[])[]
): RunePageGridPage {
  const primarySlots = page.primaryTree == null ? null : PERK_TREES[page.primaryTree] ?? null;
  const primaryRows = Array.from({ length: 3 }, (_, index) => {
    const id = page.primary[index] ?? null;
    return otpStaticRuneRow(
      primarySlots?.minorRows[index] ?? [],
      id,
      runeOf,
      slotGridSample(slots?.primaryRows[index], id)
    );
  });
  const unmapped: RunePick[] = [];
  page.primary.slice(3).forEach((id) => unmapped.push(otpRunePick(id, runeOf)));
  const secondarySelected: (RunePick | null)[] = [null, null, null];
  if (page.secondaryTree != null) {
    for (const id of page.secondary) {
      const row = primaryMinorRow(page.secondaryTree, id);
      const pick = otpRunePick(id, runeOf);
      if (row == null || secondarySelected[row] !== null) {
        unmapped.push(pick);
      } else {
        secondarySelected[row] = pick;
      }
    }
  } else {
    page.secondary.forEach((id) => unmapped.push(otpRunePick(id, runeOf)));
  }
  const secondarySlots = page.secondaryTree == null ? null : PERK_TREES[page.secondaryTree] ?? null;
  const secondaryRows = secondarySelected.map((pick, index) =>
    otpStaticRuneRow(
      secondarySlots?.minorRows[index] ?? [],
      pick?.id ?? null,
      runeOf,
      slotGridSample(slots?.secondaryRows[index], pick?.id ?? null)
    )
  );
  return {
    primaryTree:
      page.primaryTree == null
        ? null
        : { id: page.primaryTree, name: treeName(page.primaryTree), icon: treeIconUrl(page.primaryTree) },
    keystone: otpStaticRuneRow(
      primarySlots?.keystones ?? [],
      page.keystone ?? null,
      runeOf,
      slotGridSample(slots?.keystone, page.keystone ?? null)
    ),
    primaryRows,
    secondaryTree:
      page.secondaryTree == null
        ? null
        : { id: page.secondaryTree, name: treeName(page.secondaryTree), icon: treeIconUrl(page.secondaryTree) },
    secondaryRows,
    shards: Array.from({ length: 3 }, (_, index) => {
      const id = page.shards[index] ?? null;
      return otpStaticShardRow(shardRows[index] ?? [], id, slotGridSample(slots?.shards[index], id));
    }),
    unmapped,
  };
}
