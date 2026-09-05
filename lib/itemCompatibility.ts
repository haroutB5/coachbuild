/** Mutually exclusive completed-item families. IDs checked against 16.17.1.
 * These are purchase restrictions, not a popularity or WPA adjustment.
 * Keep component/transform IDs together so upgrading cannot bypass a family.
 * References: https://wiki.leagueoflegends.com/en-us/Item_group and Riot's
 * https://ddragon.leagueoflegends.com/cdn/16.17.1/data/en_US/item.json.
 */
const ITEM_FAMILIES: readonly (readonly number[])[] = [
  [3035, 3036, 3033, 6694], // Last Whisper
  [3155, 3156, 3053, 6673], // Lifeline
  [4630, 3135, 3137], // Void penetration
  [3070, 3003, 3040, 3004, 3042, 3119, 3121], // Tear / Manaflow
];

export function itemsConflict(a: number, b: number): boolean {
  return a === b || ITEM_FAMILIES.some((family) => family.includes(a) && family.includes(b));
}

export function conflictsWithItems(id: number, selected: ReadonlySet<number>): boolean {
  return Array.from(selected).some((other) => itemsConflict(id, other));
}
