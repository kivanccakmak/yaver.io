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

/** The shortcut is deliberately two-factor: a full Yaver session must match
 * the account bound during enrollment, and the exact app/installation key must
 * still be active. App ownership is reported separately; it never substitutes
 * for registering the phone. */
export function dogfoodInstallationAuthorized(input: {
  appEnabled: boolean;
  appOwnerUserId: string;
  sessionUserId: string;
  installationStatus?: DogfoodInstallationStatus;
  testerUserId?: string;
}): boolean {
  return input.appEnabled
    && input.installationStatus === "active"
    && !!input.testerUserId
    && input.testerUserId === input.sessionUserId;
}

export function dogfoodControlActionMessage(input: {
  deviceId: string;
  installationDocId: string;
  action: DogfoodInstallationAction;
  signedAt: number;
}): string {
  return `yaver-dogfood-control-action-v1\n${input.deviceId}\n${input.installationDocId}\n${input.action}\n${input.signedAt}`;
}
