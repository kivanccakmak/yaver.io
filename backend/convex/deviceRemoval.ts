/** Shared tombstone gate for every user-facing/placement inventory. */
export function isActiveDeviceRow(row: { removed?: boolean }): boolean {
  return row.removed !== true;
}

export function activeDeviceRows<T extends { removed?: boolean }>(rows: T[]): T[] {
  return rows.filter(isActiveDeviceRow);
}
