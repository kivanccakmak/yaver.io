// LanBeacon.swift — broadcast this TV's waiting sign-in on the LAN so any
// authenticated Yaver surface on the same network can approve it with one
// tap (the "no QR, no typing" path).
//
// Transport: UDP broadcast on port 19837 — the SAME port the mobile app's
// BeaconListener and the Go agent already speak on for agent discovery
// (mobile/src/lib/beacon.ts BEACON_PORT, desktop/agent/beacon.go). A TV
// approval beacon is marked `svc: "yaver-approve"` so listeners can tell it
// apart from an agent beacon.
//
// Privacy/security contract (2026-08-13):
//   * The beacon carries the approveNonce + matchCode + machine name + expiry.
//     It NEVER carries the userCode — an eavesdropper on the LAN cannot bind
//     this TV to their own account (approval requires an authenticated
//     session, and the nonce is single-purpose).
//   * matchCode is a 3-digit number shown on BOTH screens (WhatsApp-style
//     number matching) so the user confirms they're approving THEIR TV.
//   * Timeouts: the beacon expires with the code (15 min TTL from Convex) and
//     the pending-approval window is 60s server-side; the TV re-publishes
//     every 3s and stops on sign-in.
//
// No Bonjour: the agents/phones that need to hear this already bind UDP 19837,
// and browsers reach it via the connected agent (GET /auth/lan-approvals).

import Foundation
import Network

final class LanApprovalBeacon {
    static let port: UInt16 = 19837
    static let serviceType = "yaver-approve"

    private var connection: NWConnection?
    private var timer: Timer?
    private var payload: Data?
    private var running = false

    /// Start broadcasting the waiting sign-in. `approveNonce` + `matchCode`
    /// come from POST /auth/device-code (same response as the QR code);
    /// `expiresAtMs` is the code TTL. Stops automatically on deinit/stop().
    func start(machineName: String, approveNonce: String, matchCode: String, expiresAtMs: Double) {
        stop()
        let body: [String: Any] = [
            "v": 1,
            "svc": Self.serviceType,
            "id": "tvos-" + String(approveNonce.prefix(8)),
            "n": machineName,
            "nonce": approveNonce,
            "mc": matchCode,
            "exp": expiresAtMs,
            "dev": "tvos",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        payload = data
        running = true
        sendNow()
        let t = Timer(timeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.sendNow()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        connection?.cancel()
        connection = nil
        payload = nil
        running = false
    }

    deinit { stop() }

    private func sendNow() {
        guard running, let payload else { return }
        if connection == nil {
            let params = NWParameters.udp
            // Broadcast to every interface's subnet broadcast is what the Go
            // agent does (beacon.go fans out to global + per-subnet). The
            // phone's BeaconListener binds 0.0.0.0:19837 with reusePort, so a
            // single global broadcast to 255.255.255.255 reaches it on most
            // home routers; sending to the subnet broadcast as well covers the
            // routers that drop the global address.
            for ip in [NWEndpoint.Host("255.255.255.255"), .ipv4(IPv4Address.broadcast)] {
                let conn = NWConnection(host: ip, port: .init(rawValue: Self.port)!, using: params)
                conn.start(queue: .global(qos: .utility))
                conn.send(content: payload, completion: .contentProcessed { _ in
                    conn.cancel()
                })
            }
        }
    }
}
