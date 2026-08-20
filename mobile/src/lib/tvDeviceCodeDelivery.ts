/** Pure arbitration for the TV's concurrent event and fallback-poll lanes. */
export type TVDeviceCodeDeliveryInput = {
  status: "pending" | "authorized" | "expired";
  token?: string;
};

export type TVDeviceCodeDeliveryDecision = "sign_in" | "claim" | "wait" | "rotate";

export function decideTVDeviceCodeDelivery(
  result: TVDeviceCodeDeliveryInput,
  claimInFlight: boolean,
): TVDeviceCodeDeliveryDecision {
  if (result.status === "expired") return "rotate";
  if (result.status !== "authorized") return "wait";
  // The token-bearing lane always wins. Another lane being mid-claim cannot
  // make the one-time bearer redundant; discarding it strands the TV.
  if (result.token) return "sign_in";
  return claimInFlight ? "wait" : "claim";
}
