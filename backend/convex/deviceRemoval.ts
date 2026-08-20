/** Shared tombstone gate for every user-facing/placement inventory. */
export function isActiveDeviceRow(row: object): boolean {
  return !("removed" in row) || (row as { removed?: boolean }).removed !== true;
}

export function activeDeviceRows<T extends object>(rows: T[]): T[] {
  return rows.filter(isActiveDeviceRow);
}
