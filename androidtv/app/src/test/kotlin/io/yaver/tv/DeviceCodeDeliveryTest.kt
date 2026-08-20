package io.yaver.tv

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceCodeDeliveryTest {
    @Test
    fun tokenWinsWhileSiblingLaneClaims() {
        assertEquals(
            DeviceCodeDeliveryAction.SIGN_IN,
            deviceCodeDeliveryAction("authorized", hasToken = true, claimInFlight = true),
        )
    }

    @Test
    fun onlyOneLaneStartsClaim() {
        assertEquals(
            DeviceCodeDeliveryAction.CLAIM,
            deviceCodeDeliveryAction("authorized", hasToken = false, claimInFlight = false),
        )
        assertEquals(
            DeviceCodeDeliveryAction.WAIT,
            deviceCodeDeliveryAction("authorized", hasToken = false, claimInFlight = true),
        )
    }

    @Test
    fun pendingWaitsAndExpiredRotates() {
        assertEquals(DeviceCodeDeliveryAction.WAIT, deviceCodeDeliveryAction("pending", false, false))
        assertEquals(DeviceCodeDeliveryAction.ROTATE, deviceCodeDeliveryAction("expired", false, false))
    }
}
