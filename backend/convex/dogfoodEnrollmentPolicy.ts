export type DogfoodInstallationStatus = "pending" | "active" | "cancelled" | "revoked" | "superseded";
export type DogfoodInstallationAction = "approve" | "cancel" | "revoke";

/** Fail-closed lifecycle shared by the mutation and dependency-free tests. */
export function dogfoodActionAllowed(status: DogfoodInstallationStatus, action: DogfoodInstallationAction, proofVerified: boolean): boolean {
  if (action === "approve") return status === "pending" && proofVerified;
  if (action === "cancel") return status === "pending";
  return status === "active";
}

/** Re-registration replaces only the active generation for the same logical
 * slot. A different phone/installation slot remains active. */
export function dogfoodGenerationsToSupersede<T extends { id: string; appId: string; registrationSlot: string; status: DogfoodInstallationStatus }>(
  rows: T[], next: Pick<T, "id" | "appId" | "registrationSlot">,
): string[] {
  return rows
    .filter((row) => row.id !== next.id && row.appId === next.appId && row.registrationSlot === next.registrationSlot && row.status === "active")
    .map((row) => row.id);
}
