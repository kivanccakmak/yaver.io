// SignInView.swift — TV sign-in.
//
// Two paths, and the fast one leads:
//
//   * Sign in with Apple, natively. The TV already holds an Apple ID, so this
//     needs no second device and no transcription at all — one click, confirmed
//     on the paired iPhone. Seconds.
//   * Device code + QR, for everything Apple can't serve: a Google/Microsoft/
//     GitHub/passkey account, or an account with 2FA. Unlike the headset, a QR
//     genuinely works here — a TV is a real screen and a phone's camera can see
//     it. (VisionSignInView drops the QR for exactly that reason.)
//
// Mirrors mobile/app/tv-signin.tsx.

import AuthenticationServices
import Combine
import SwiftUI
import UIKit
import CoreImage.CIFilterBuiltins

struct SignInView: View {
    @EnvironmentObject var store: YaverStore
    @State private var start: DeviceCodeStart?
    @State private var error: String?
    @State private var expired = false
    @State private var approving = false      // approval seen; token arriving
    @State private var appleBusy = false
    @State private var pollTask: Task<Void, Never>?
    @State private var fallbackPollTask: Task<Void, Never>?
    /// Non-nil while polls are failing to reach the backend — surfaced verbatim
    /// so "nothing is happening" is never indistinguishable from "the network is
    /// down". Cleared by the first successful poll.
    @State private var unreachable: String?
    /// Drives the elapsed / expires-in line. A wait with no clock on it reads as
    /// a hang.
    @State private var now = Date()
    @State private var waitingSince = Date()

    var body: some View {
        HStack(spacing: 56) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Sign in to Yaver")
                    .font(.system(size: 44, weight: .heavy))
                    .padding(.bottom, 12)

                Text("Scan with the Yaver app:")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.secondary)

                stepText("1. Scan the code with your phone, or visit yaver.io/auth/device in any browser")
                stepText("2. Sign in if asked, then tap Approve")
                stepText("3. This Apple TV signs in automatically")

                if let code = start?.userCode {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("OR ENTER THIS CODE")
                            .font(.system(size: 15, weight: .bold)).tracking(2)
                            .foregroundStyle(.secondary)
                        Text(code)
                            .font(.system(size: 46, weight: .heavy, design: .monospaced))
                            .tracking(4)
                    }
                    .padding(.top, 24)
                }

                if approving {
                    Label("Approved — signing in…", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.green).padding(.top, 20)
                } else if let s = start {
                    // A quiet live indicator so the screen never looks frozen while
                    // it waits — the Netflix "waiting for you to enter the code" feel.
                    //
                    // It used to be JUST a spinner and "Waiting for approval…", with
                    // no elapsed time, no expiry, and no distinction between "you
                    // haven't approved yet" and "this TV can't reach Yaver". A user
                    // whose approval silently went nowhere had nothing on screen to
                    // tell them so — for the full 15 minutes until the code rotated.
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(unreachable == nil
                                 ? "Waiting for approval…"
                                 : "Can't reach Yaver — retrying every 5s")
                                .foregroundStyle(unreachable == nil ? Color.secondary : Color.orange)
                        }
                        Text(waitDetail(s))
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                        if let unreachable {
                            Text(unreachable)
                                .font(.system(size: 15))
                                .foregroundStyle(.orange)
                        }
                    }
                    .font(.system(size: 18)).padding(.top, 20)
                }

                if let error {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(error).foregroundStyle(.orange)
                        Button("Try again") { Task { await begin() } }   // was: hang forever with no way out
                    }
                    .padding(.top, 16)
                }
                if expired { Text("Code expired — generating a new one…").foregroundStyle(.secondary).padding(.top, 8) }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Secondary sign-in")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.secondary)
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.fullName, .email]
                    } onCompletion: { result in
                        Task { await handleApple(result) }
                    }
                    .signInWithAppleButtonStyle(.white)
                    .frame(height: 52)
                    .disabled(appleBusy)
                    Text("Use this only for a Yaver account already linked to Apple. The QR works with every provider.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 28)
            }
            .frame(maxWidth: 560, alignment: .leading)

            ZStack {
                RoundedRectangle(cornerRadius: 24).fill(.white)
                if let url = start?.verifyURL, let img = qrImage(url.absoluteString) {
                    Image(uiImage: img)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 300, height: 300)
                } else {
                    ProgressView()
                }
            }
            .frame(width: 360, height: 360)
        }
        .padding(64)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await begin() }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
        .onDisappear {
            pollTask?.cancel()
            fallbackPollTask?.cancel()
        }
    }

    private func stepText(_ s: String) -> some View {
        Text(s).font(.system(size: 22)).foregroundStyle(.secondary)
    }

    /// "1:42 elapsed · code expires in 13:18" — the two facts a waiting user
    /// actually needs: that time is passing, and how long this code is good for.
    private func waitDetail(_ s: DeviceCodeStart) -> String {
        let elapsed = max(0, now.timeIntervalSince(waitingSince))
        var line = "\(clock(elapsed)) elapsed"
        let remaining = s.expiresAt / 1000 - now.timeIntervalSince1970
        if remaining > 0 {
            line += " · code expires in \(clock(remaining))"
        } else {
            line += " · code expired — generating a new one"
        }
        return line
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// Native Apple sign-in. Trades the Apple ID already on this TV for a Yaver
    /// session — no code carried to a phone, nothing typed on a remote.
    private func handleApple(_ result: Result<ASAuthorization, Error>) async {
        error = nil
        switch result {
        case .failure(let err):
            // Backing out of the Apple sheet is a choice, not a failure.
            if (err as? ASAuthorizationError)?.code == .canceled { return }
            error = err.localizedDescription

        case .success(let authorization):
            appleBusy = true
            defer { appleBusy = false }
            do {
                let token = try await AppleNativeAuth.completeSignIn(with: authorization)
                pollTask?.cancel()      // the device code is moot now
                store.signIn(token: token)
            } catch {
                // Covers the two things Apple genuinely can't serve here: an
                // account with 2FA, and an account that signs in with another
                // provider (where Apple would fork a second, empty one). Both
                // messages point at the QR below, which serves every provider.
                self.error = error.localizedDescription
            }
        }
    }

    private func begin() async {
        error = nil
        expired = false
        unreachable = nil
        do {
            let s = try await DeviceCodeAuth.start()
            start = s
            waitingSince = Date()
            now = Date()
            startPolling(s)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func startPolling(_ s: DeviceCodeStart) {
        pollTask?.cancel()
        fallbackPollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                if Task.isCancelled { return }
                let r = await DeviceCodeAuth.waitEvent(deviceCode: s.deviceCode)
                if await handlePollResult(r, for: s) { return }
            }
        }
        fallbackPollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { return }
                let r = await DeviceCodeAuth.poll(deviceCode: s.deviceCode)
                if await handlePollResult(r, for: s) { return }
            }
        }
    }

    private func handlePollResult(_ r: DevicePollResult, for s: DeviceCodeStart) async -> Bool {
        unreachable = r.unreachableReason
        switch r.status {
        case .authorized:
            if approving { return true }
            approving = true
            let claimed = r.token == nil
                ? await DeviceCodeAuth.claim(deviceCode: s.deviceCode, claimHandle: r.claimHandle)
                : r
            if let token = claimed.token {
                pollTask?.cancel()
                fallbackPollTask?.cancel()
                store.signIn(token: token)
                return true
            }
            approving = false
            unreachable = claimed.unreachableReason ?? "Approved, but this Apple TV could not pick up the session yet. Retrying..."
            return false
        case .expired:
            expired = true
            await begin()
            return true
        case .pending:
            return false
        }
    }

    private func qrImage(_ string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
