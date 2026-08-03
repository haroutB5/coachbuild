/** Runtime wire-shape validation for the Pro Players page's history state.
 *
 * History state is an untyped browser boundary. Keep this pure helper outside
 * app/history/page.tsx so the route exports only Next.js-supported page
 * symbols, while the page still validates every selection before reading it.
 */

export interface WirePlayerSubjectTracked {
  kind: "tracked";
  id: string;
  name: string;
  team: string | null;
}

export interface WirePlayerSubjectLink {
  kind: "link";
  playerLink: string;
  name: string;
}

export type WirePlayerSubject = WirePlayerSubjectTracked | WirePlayerSubjectLink;

export type WireSelection =
  | { mode: "player"; subject: WirePlayerSubject }
  | {
      mode: "champion";
      championId: number;
      championKey: string;
      championName: string;
      championIcon: string;
      lane: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWirePlayerSubject(value: unknown): value is WirePlayerSubject {
  if (!isRecord(value)) return false;
  if (value.kind === "tracked") {
    return (
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      (value.team === null || typeof value.team === "string")
    );
  }
  return value.kind === "link" && typeof value.playerLink === "string" && typeof value.name === "string";
}

/** Rejects every payload not written by /history, including the Builds page's
 *  `{ view, tab, source }` shape before any champion request can be derived. */
export function isWireSelection(value: unknown): value is WireSelection {
  if (!isRecord(value)) return false;
  if (value.mode === "player") return isWirePlayerSubject(value.subject);
  return (
    value.mode === "champion" &&
    typeof value.championId === "number" &&
    Number.isInteger(value.championId) &&
    typeof value.championKey === "string" &&
    typeof value.championName === "string" &&
    typeof value.championIcon === "string" &&
    typeof value.lane === "number" &&
    Number.isInteger(value.lane) &&
    value.lane >= 0 &&
    value.lane <= 5
  );
}

/** Converts an untyped history payload into a safe restore value. Invalid
 *  entries are treated as absent, never as a partial champion selection. */
export function restoreSelectionState(selection: unknown): WireSelection | null {
  if (selection === null) return null;
  return isWireSelection(selection) ? selection : null;
}
