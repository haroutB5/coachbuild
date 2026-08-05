/**
 * Open a search menu from a pointer/click interaction without toggling it
 * closed when the input was already open. Focus and change handlers can fire
 * in the same interaction, so this transition is deliberately idempotent.
 */
export interface SearchOpenState {
  open: boolean;
  activeIndex: number;
}

export function openSearchFromPointer(state: SearchOpenState): SearchOpenState {
  if (state.open) return state;
  return { open: true, activeIndex: 0 };
}
