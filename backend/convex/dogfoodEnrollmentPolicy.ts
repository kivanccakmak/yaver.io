export type DogfoodInstallationStatus = "pending" | "active" | "cancelled" | "revoked" | "superseded";
export type DogfoodInstallationAction = "approve" | "cancel" | "revoke";

export type DogfoodTesterAssignment = {
  status: "active" | "revoked";
  testerEmail: string;
  testerUserId?: string;
};

export function normalizeDogfoodTesterEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** An assignment that has resolved to one account id stays bound to it even
 * if the email is later reused by another account. */
export function dogfoodTesterBinding(existingUserId?: string, matchedUserId?: string): string | undefined {
  return existingUserId || matchedUserId;
}

/** App owners can always enroll their own exact installation. Everyone else
 * must be explicitly assigned to the app by email or resolved Yaver user id. */
export function dogfoodTesterAssigned(input: {
  appOwnerUserId: string;
  sessionUserId: string;
  sessionEmail: string;
  assignments: DogfoodTesterAssignment[];
}): boolean {
  if (input.appOwnerUserId === input.sessionUserId) return true;
  const email = normalizeDogfoodTesterEmail(input.sessionEmail);
  return input.assignments.some((assignment) => assignment.status === "active" && (
    assignment.testerUserId
      ? assignment.testerUserId === input.sessionUserId
      : normalizeDogfoodTesterEmail(assignment.testerEmail) === email
  ));
}

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
  testerAssigned?: boolean;
}): boolean {
  return input.appEnabled
    && (input.appOwnerUserId === input.sessionUserId || input.testerAssigned === true)
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

/** First-run completion is monotonic. A later preference change can switch
 * between Y and gesture, but it must never make an already-onboarded tester
 * look new again. */
export function dogfoodControlOnboardingSeenAt(
  existing: number | undefined,
  requestedSeen: boolean,
  now: number,
): number | undefined {
  return existing || (requestedSeen ? now : undefined);
}
