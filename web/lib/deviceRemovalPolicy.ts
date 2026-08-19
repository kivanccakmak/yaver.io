export type DeviceHosting = "yaver-hosted" | "byo" | "self-hosted";

/**
 * Only a Yaver-hosted machine owns a Yaver-managed billing resource that must
 * be decommissioned. BYO and self-hosted devices are removed from the account
 * only; Yaver must not ask for provider credentials or snapshots for them.
 */
export function deviceRemovalPolicy(device: {
  hosting?: DeviceHosting;
  managed?: boolean;
}): "cloud-decommission" | "account-forget" {
  if (device.hosting) {
    return device.hosting === "yaver-hosted" ? "cloud-decommission" : "account-forget";
  }
  return device.managed === true ? "cloud-decommission" : "account-forget";
}
