// ─────────────────────────────────────────────────────────────────────────────
// skillOrderGrid.ts — pure transform + styling tokens for THE classic skill
// grid: one row per ability (Q/W/E/R), one column per champion level, a
// coloured chip in the cell where that ability took a point.
//
// ── ONE PRIMITIVE, TWO FILL RULES ──────────────────────────────────────────
// This module (and components/SkillGrid.tsx, which renders what it returns) is
// shared by two surfaces that mean genuinely different things, and the shape of
// that difference is the reason `columns` is a parameter and not a constant
// baked in here:
//
//   * GameDetailSheet — a FACTUAL RECORD of one pro game. If the game ended at
//     level 16, the grid shows 16 points and levels 17-18 stay empty. It is
//     never padded, because padding it would invent levels a player never took.
//   * SkillOrderCard  — a RECOMMENDATION. A recommendation always answers all
//     18 levels (user directive 2026-07-29), so its caller fills the tail: by
//     derivation where lib/skillOrderModel.ts's arithmetic resolves it, by
//     INFERENCE from the published max-priority order where it does not.
//
// This module takes no view on which is right. It renders the cells it is
// handed. COMPLETENESS IS THE CALLER'S DECISION — if you find yourself adding
// an "always 18" default in here, it is in the wrong layer.
//
// What this module DOES own is provenance: every cell carries whether its level
// was MEASURED, DERIVED, INFERRED or AUTO, and components/SkillGrid.tsx gives
// each a visually distinct treatment. Repo CLAUDE.md hard rule #4 — a guess rendered
// identically to a measurement is a fabrication even when the guess is a good
// one.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionKit } from "@/lib/types";

export type SkillLetter = "Q" | "W" | "E" | "R";

export const SKILL_ROWS: readonly SkillLetter[] = ["Q", "W", "E", "R"];

/** The full champion level range. A DEFAULT for callers who want the classic
 *  18-wide grid — not an assertion that every caller's data reaches 18. */
export const SKILL_GRID_COLUMNS = 18;

/**
 * Where a cell's level came from. The four states are not decoration:
 *
 *   * `measured` — the upstream source published this level verbatim.
 *   * `derived`  — this app computed it by arithmetic that has exactly one
 *                  answer (`completeSkillOrder`: remaining points = caps minus
 *                  spent). Not measured, but not a choice either.
 *   * `inferred` — the arithmetic did NOT resolve, and the level was filled
 *                  from the champion's published max-priority order so the
 *                  recommendation reads as a complete 18. This is the honest
 *                  name for a good guess, and it must always be visible as one.
 */
export type SkillCellProvenance = "measured" | "derived" | "inferred" | "auto";

export interface SkillGridCell {
  /** 1-based champion level this chip sits at. */
  level: number;
  provenance: SkillCellProvenance;
}

export interface BuildSkillGridOptions {
  /** How many columns wide the grid is. Defaults to the full 18. A per-game
   *  caller keeps 18 (so a short game reads as "ended early", not "rescaled")
   *  but may narrow it deliberately. */
  columns?: number;
  /** Count of LEADING entries of `order` that were measured. Defaults to the
   *  whole order — i.e. "everything here is measured", which is exactly what a
   *  per-game timeline means. */
  measuredThrough?: number;
  /** Count of leading entries that are measured OR derived. Everything at a
   *  higher index is `inferred`. Defaults to the whole order — i.e. "nothing
   *  was inferred", which is the SAFE default: a caller who forgets this
   *  parameter under-claims (calls a guess derived arithmetic) rather than
   *  over-claims. Clamped up to `measuredThrough`, so it can never demote a
   *  measured cell. */
  derivedThrough?: number;
  /** Champion rank rules for recorded non-standard kits. Omitted means the
   * historical standard grid behavior. */
  kit?: ChampionKit | null;
}

interface NormalizedSkillEntry {
  letter: string;
  auto: boolean;
}

/**
 * Normalize the two automatic-R wire shapes before placing cells. Aphelios's
 * timeline includes zero-cost R markers, so strip them and put them back at
 * the canonical levels; Jayce's transform is not a timeline entry at all and
 * is represented only by a level-1 overlay. Both paths are bounded by the
 * observed order length so a short factual grid never gains a guessed tail.
 */
function normalizeSkillEntries(order: readonly string[], kit?: ChampionKit | null): NormalizedSkillEntry[] {
  const observedLength = Math.min(order.length, SKILL_GRID_COLUMNS);
  const rAuto = kit?.rAuto === true || kit?.maxRanks.R === 1;
  if (!rAuto) {
    return order.slice(0, observedLength).map((letter) => ({ letter, auto: false }));
  }

  const basics = order.slice(0, observedLength).filter((letter) => letter !== "R");
  const autoLevels = kit?.maxRanks.R === 1
    ? []
    : (kit?.ultimateLevels ?? [6, 11, 16]).filter((level) => level <= observedLength);
  const entries: NormalizedSkillEntry[] = [];
  let basicIndex = 0;
  for (let level = 1; level <= observedLength; level += 1) {
    if (autoLevels.includes(level)) {
      entries.push({ letter: "R", auto: true });
    } else if (basicIndex < basics.length) {
      entries.push({ letter: basics[basicIndex], auto: false });
      basicIndex += 1;
    }
  }
  return entries;
}

/**
 * Build the rows-by-columns cell grid. Rows follow SKILL_ROWS order; a cell is
 * `null` when that ability took no point at that level.
 *
 * Unrecognised entries (not Q/W/E/R) are SKIPPED rather than thrown on — a
 * malformed or legacy row should degrade to a gap, never crash the surface it
 * sits in. Entries past `columns` are ignored for the same reason.
 */
export function buildSkillGrid(
  order: readonly string[],
  options: BuildSkillGridOptions = {}
): (SkillGridCell | null)[][] {
  const columns = options.columns ?? SKILL_GRID_COLUMNS;
  const entries = normalizeSkillEntries(order, options.kit);
  const measuredThrough = clampCount(options.measuredThrough, entries.length, entries.length);
  const derivedThrough = Math.max(
    measuredThrough,
    clampCount(options.derivedThrough, entries.length, entries.length)
  );

  const grid: (SkillGridCell | null)[][] = SKILL_ROWS.map(() =>
    new Array<SkillGridCell | null>(columns).fill(null)
  );

  for (let i = 0; i < entries.length && i < columns; i += 1) {
    const entry = entries[i];
    const rowIdx = SKILL_ROWS.indexOf(entry.letter as SkillLetter);
    if (rowIdx === -1) continue;
    grid[rowIdx][i] = {
      level: i + 1,
      provenance: entry.auto
        ? "auto"
        : i < measuredThrough
          ? "measured"
          : i < derivedThrough
            ? "derived"
            : "inferred",
    };
  }

  // Jayce's transform is automatic at level 1 but is not serialized as a
  // skill event. Overlay it only when this order has at least one observed
  // cell; an empty order stays genuinely empty.
  if (options.kit?.maxRanks.R === 1 && entries.length > 0 && columns > 0) {
    const rRow = SKILL_ROWS.indexOf("R");
    if (rRow >= 0 && grid[rRow][0] === null) {
      grid[rRow][0] = { level: 1, provenance: "auto" };
    }
  }
  return grid;
}

function clampCount(raw: number | undefined, max: number, fallback: number): number {
  if (!Number.isInteger(raw) || (raw as number) < 0) return Math.min(fallback, max);
  return Math.min(raw as number, max);
}

/** Every level in a row that carries the given provenance. Used to build the
 *  row's accessible name, so a screen-reader user is told which levels are
 *  derived/inferred rather than only sighted users getting that signal — a
 *  visual-only provenance marker tells one audience the truth and the other a
 *  fabrication (hard rule #4, aimed at a subset). */
export function levelsWithProvenance(
  cells: readonly (SkillGridCell | null)[],
  provenance: SkillCellProvenance
): number[] {
  return cells.filter((c): c is SkillGridCell => c?.provenance === provenance).map((c) => c.level);
}

/** Accessible name for one ability row — the levels it is ranked at, plus an
 *  explicit note for anything not measured. */
export function describeSkillRow(
  letter: SkillLetter,
  cells: readonly (SkillGridCell | null)[]
): string {
  const all = cells.filter((c): c is SkillGridCell => c !== null).map((c) => c.level);
  if (!all.length) return `${letter} — no levelling data`;

  const parts = [`${letter} ranked at level${all.length === 1 ? "" : "s"} ${all.join(", ")}`];
  const derived = levelsWithProvenance(cells, "derived");
  if (derived.length) {
    parts.push(`Level${derived.length === 1 ? "" : "s"} ${derived.join(", ")} derived, not recorded`);
  }
  const inferred = levelsWithProvenance(cells, "inferred");
  if (inferred.length) {
    parts.push(
      `Level${inferred.length === 1 ? "" : "s"} ${inferred.join(", ")} inferred from the max-priority order, not recorded`
    );
  }
  const auto = levelsWithProvenance(cells, "auto");
  if (auto.length) {
    parts.push(`Level${auto.length === 1 ? "" : "s"} ${auto.join(", ")} auto-ranked, not recorded`);
  }
  return parts.join(". ");
}

// ── Per-ability colour tokens ────────────────────────────────────────────────
//
// The classic grid convention every reference site uses (and the look the user
// asked for, 2026-07-29): Q blue, W orange, E purple, R red. Deliberately NOT
// the app's gold accent — four abilities need four distinguishable hues, and a
// single-accent ramp cannot supply that.
//
// COLOUR IS NEVER THE ONLY SIGNAL. The row's leading label carries the literal
// Q/W/E/R letter and each chip carries its level number, so the grid is fully
// readable with no colour perception at all. The hues are a fast second channel
// for the 30-second champ-select glance this app is built around, not the
// primary one.
//
// Tailwind arbitrary values rather than theme tokens on purpose: these four are
// scoped to this one primitive and adding four decorative colours to
// tailwind.config.ts's palette would invite them into surfaces where the
// single-gold-accent rule should hold.
export interface AbilityPalette {
  /** Solid chip — a MEASURED level. */
  measured: string;
  /** Tinted chip with a solid hairline — a DERIVED level. */
  derived: string;
  /** Dashed outline, no fill — an INFERRED level. */
  inferred: string;
  /** Muted marker — a kit-provided automatic rank, not a skill point. */
  auto: string;
  /** The row's leading letter label. */
  label: string;
}

export const ABILITY_PALETTE: Readonly<Record<SkillLetter, AbilityPalette>> = {
  Q: {
    measured: "bg-[#4c8ff0] text-[#07130f] border border-[#4c8ff0]",
    derived: "bg-[#4c8ff0]/22 border border-[#4c8ff0]/85 text-[#9dc4f8]",
    inferred: "bg-transparent border border-dashed border-[#4c8ff0]/70 text-[#7fb0f2]",
    auto: "bg-[#9aa4ad]/18 border border-dashed border-[#9aa4ad]/65 text-[#c2c9cf]",
    label: "text-[#9dc4f8]",
  },
  W: {
    measured: "bg-[#e2903f] text-[#07130f] border border-[#e2903f]",
    derived: "bg-[#e2903f]/22 border border-[#e2903f]/85 text-[#f0c08a]",
    inferred: "bg-transparent border border-dashed border-[#e2903f]/70 text-[#eab073]",
    auto: "bg-[#9aa4ad]/18 border border-dashed border-[#9aa4ad]/65 text-[#c2c9cf]",
    label: "text-[#f0c08a]",
  },
  E: {
    measured: "bg-[#a878e4] text-[#07130f] border border-[#a878e4]",
    derived: "bg-[#a878e4]/22 border border-[#a878e4]/85 text-[#cbaef1]",
    inferred: "bg-transparent border border-dashed border-[#a878e4]/70 text-[#bd9aec]",
    auto: "bg-[#9aa4ad]/18 border border-dashed border-[#9aa4ad]/65 text-[#c2c9cf]",
    label: "text-[#cbaef1]",
  },
  R: {
    measured: "bg-[#e8595c] text-[#07130f] border border-[#e8595c]",
    derived: "bg-[#e8595c]/22 border border-[#e8595c]/85 text-[#f3a0a2]",
    inferred: "bg-transparent border border-dashed border-[#e8595c]/70 text-[#ef8c8f]",
    auto: "bg-[#9aa4ad]/18 border border-dashed border-[#9aa4ad]/65 text-[#c2c9cf]",
    label: "text-[#f3a0a2]",
  },
};

/** Udyr's R is a fourth basic ability, so it uses a basic-row palette rather
 * than the red ultimate palette. */
export const BASIC_R_PALETTE: AbilityPalette = {
  measured: "bg-[#54b6a2] text-[#07130f] border border-[#54b6a2]",
  derived: "bg-[#54b6a2]/22 border border-[#54b6a2]/85 text-[#a5e0d4]",
  inferred: "bg-transparent border border-dashed border-[#54b6a2]/70 text-[#8bd2c3]",
  auto: "bg-[#9aa4ad]/18 border border-dashed border-[#9aa4ad]/65 text-[#c2c9cf]",
  label: "text-[#a5e0d4]",
};

/** Empty cell — a level this ability took no point at. Low-contrast on
 *  purpose: the eye should land on the chips, not the gaps. */
export const EMPTY_CELL_CLASS = "bg-black/25 border border-line/25";

/** Chip classes for one cell. `null` → the empty treatment. */
export function skillCellClass(
  letter: SkillLetter,
  cell: SkillGridCell | null,
  options: { rAsBasic?: boolean } = {}
): string {
  if (!cell) return EMPTY_CELL_CLASS;
  const palette = letter === "R" && options.rAsBasic ? BASIC_R_PALETTE : ABILITY_PALETTE[letter];
  return palette[cell.provenance];
}

export function skillRowLabelClass(letter: SkillLetter, options: { rAsBasic?: boolean } = {}): string {
  return letter === "R" && options.rAsBasic ? BASIC_R_PALETTE.label : ABILITY_PALETTE[letter].label;
}
