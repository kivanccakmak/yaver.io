package io.yaver.tv

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Enumeration

/**
 * LanApprovalBeacon — broadcast this TV's waiting sign-in on the LAN so any
 * authenticated Yaver surface on the same network can approve it with one tap
 * (the "no QR, no typing" path). Mirror of tvos/YaverTV/LanApprovalBeacon.swift.
 *
 * Transport: UDP broadcast on port 19837 — the SAME port the mobile app's
 * BeaconListener and the Go agent speak on for agent discovery. A TV approval
 * beacon is marked `svc: "yaver-approve"` so listeners can tell it apart from
 * an agent beacon.
 *
 * Privacy/security contract: the beacon carries the approveNonce + matchCode +
 * machine name + expiry. It NEVER carries the userCode — an eavesdropper on the
 * LAN cannot bind this TV to their own account (approval requires an
 * authenticated session, and the nonce is single-purpose). matchCode is a
 * 3-digit number shown on BOTH screens so the user confirms they're approving
 * THEIR TV. The beacon expires with the code and stops on sign-in.
 */
class LanApprovalBeacon(private val context: Context) {

    companion object {
        const val PORT = 19837
        const val SERVICE_TYPE = "yaver-approve"
    }

    private var job: Job? = null
    private var payload: ByteArray? = null

    /** Start broadcasting the waiting sign-in every 3s until stop(). */
    fun start(machineName: String, approveNonce: String, matchCode: String, expiresAtMs: Double, deviceTag: String = "androidtv") {
        stop()
        val body = JSONObject()
            .put("v", 1)
            .put("svc", SERVICE_TYPE)
            .put("id", "$deviceTag-${approveNonce.take(8)}")
            .put("n", machineName)
            .put("nonce", approveNonce)
            .put("mc", matchCode)
            .put("exp", expiresAtMs)
            .put("dev", deviceTag)
        payload = body.toString().toByteArray(Charsets.UTF_8)

        val scope = CoroutineScope(Dispatchers.IO)
        job = scope.launch {
            while (isActive) {
                sendNow()
                delay(3000)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        payload = null
    }

    private fun sendNow() {
        val p = payload ?: return
        try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                for (host in broadcastHosts()) {
                    try {
                        val address = InetAddress.getByName(host)
                        socket.send(DatagramPacket(p, p.size, address, PORT))
                    } catch (e: Throwable) { /* one host failing is not the beacon failing */ }
                }
            }
        } catch (e: Throwable) { /* no network — the QR path still works */ }
    }

    /** Global + per-subnet broadcast addresses, like the Go agent's beacon. */
    private fun broadcastHosts(): List<String> {
        val hosts = mutableListOf("255.255.255.255")
        try {
            NetworkInterface.getNetworkInterfaces().let { ifaces: Enumeration<NetworkInterface>? ->
                if (ifaces != null) {
                    while (ifaces.hasMoreElements()) {
                        val iface = ifaces.nextElement()
                        if (!iface.isUp) continue
                        if (iface.name.startsWith("wlan") || iface.name.startsWith("eth")) {
                            val addresses = iface.interfaceAddresses ?: continue
                            for (ia in addresses) {
                                val addr = ia.address
                                if (addr is Inet4Address && ia.broadcast != null) {
                                    ia.broadcast.hostAddress?.let(hosts::add)
                                }
                            }
                        }
                    }
                }
            }
        } catch (e: Throwable) { /* best-effort */ }
        return hosts.distinct()
    }
}
