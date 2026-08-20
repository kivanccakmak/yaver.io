package io.yaver.tv

/** Arbitration for the concurrent long-event and fallback-poll delivery lanes. */
enum class DeviceCodeDeliveryAction { SIGN_IN, CLAIM, WAIT, ROTATE }

fun deviceCodeDeliveryAction(
    status: String,
    hasToken: Boolean,
    claimInFlight: Boolean,
): DeviceCodeDeliveryAction = when {
    status == "expired" -> DeviceCodeDeliveryAction.ROTATE
    status != "authorized" -> DeviceCodeDeliveryAction.WAIT
    // The one-time bearer always wins even while the sibling lane is claiming.
    hasToken -> DeviceCodeDeliveryAction.SIGN_IN
    claimInFlight -> DeviceCodeDeliveryAction.WAIT
    else -> DeviceCodeDeliveryAction.CLAIM
}
