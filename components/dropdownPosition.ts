// Pure positioning math for ChampionPicker's portaled results dropdown (see
// ChampionPicker.tsx doc comment — the dropdown renders into document.body
// via createPortal, `position: fixed`, so it escapes ANY clip-path/overflow
// ancestor, notably `.dt-panel`'s chamfered-corner clip-path on /draft that
// was silently clipping the results list away entirely). Extracted so the
// flip-above/clamp decision has a real unit test rather than only living
// inside a DOM effect.
export interface DropdownCoords {
  /** Set (and `bottom` omitted) when there's enough room below the anchor. */
  top?: number;
  /** Set (and `top` omitted) when flipped above the anchor. */
  bottom?: number;
  left: number;
  width: number;
}

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

const GAP_PX = 6; // matches the old `mt-1.5`
const MAX_WIDTH_PX = 280; // matches the old `w-[min(280px,90vw)]`
const WIDTH_VW_FRACTION = 0.9;
/** Conservative estimate of the dropdown's rendered height (list `max-h-[240px]`
 *  + border/padding) — used only to decide whether to flip above, never to
 *  actually size anything (the real element is height:auto). */
const ESTIMATED_HEIGHT_PX = 260;
const EDGE_PADDING_PX = 8;

/** Given the anchor's viewport-relative rect and the current viewport size,
 *  compute where the dropdown should render. Flips above the anchor when
 *  there isn't enough room below AND there's strictly more room above than
 *  below; otherwise (including "neither side has enough room") stays below,
 *  matching the pre-portal default. Left is clamped so the fixed-width
 *  dropdown never renders off-screen. */
export function computeDropdownPosition(anchor: AnchorRect, viewport: ViewportSize): DropdownCoords {
  const width = Math.min(MAX_WIDTH_PX, viewport.width * WIDTH_VW_FRACTION);
  const left = Math.max(
    EDGE_PADDING_PX,
    Math.min(anchor.left, viewport.width - width - EDGE_PADDING_PX)
  );

  const spaceBelow = viewport.height - anchor.bottom;
  const spaceAbove = anchor.top;
  const flipAbove = spaceBelow < ESTIMATED_HEIGHT_PX && spaceAbove > spaceBelow;

  if (flipAbove) {
    return { bottom: viewport.height - anchor.top + GAP_PX, left, width };
  }
  return { top: anchor.bottom + GAP_PX, left, width };
}
