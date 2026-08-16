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
    // Email/password (2026-08-13): an account that isn't Apple-linked, or an
    // Apple account with 2FA, can still sign in on the couch. Typed with the
    // remote's on-screen keyboard; hits POST /auth/login (Backend.EmailAuth).
    @State private var email = ""
    @State private var password = ""
    @State private var emailBusy = false
    @FocusState private var emailFocused: Bool
    @FocusState private var passwordFocused: Bool
    // LAN approval (2026-08-13): an authenticated surface on the same network
    // saw this TV's UDP beacon and requested approval. Non-nil renders the
    // Allow/Deny prompt; confirm goes through DeviceCodeAuth.lanConfirm.
    @State private var lanApprover: LanPendingInfo?
    @State private var lanConfirming = false
    /// Broadcasts the waiting code on UDP 19837 so same-network surfaces can
    /// approve without a QR scan. Started when a code is minted, stopped on
    /// sign-in / disappear / code rotation.
    @State private var beacon = LanApprovalBeacon()
    /// Holds the ASAuthorizationController delegate so it isn't deallocated
    /// mid-flight (the classic "white button does nothing").
    @State private var appleDelegate: AppleAuthControllerDelegate?
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
        HStack(alignment: .top, spacing: 56) {
            ScrollView(.vertical, showsIndicators: false) {
              VStack(alignment: .leading, spacing: 14) {
                Image("yaver-login-wordmark-light")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 260, height: 104, alignment: .leading)
                    .accessibilityLabel("Yaver")
                    .accessibilityIdentifier("signin.yaver-logo")

                Text("Sign in to Yaver")
                    .font(.system(size: 44, weight: .heavy))
                    .padding(.bottom, 12)

                Text("Scan with the Yaver app:")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.secondary)

                stepText("1. Scan the code with your phone, or visit yaver.io/auth/device in any browser")
                stepText("2. Sign in if asked, then tap Approve")
                stepText("3. This Apple TV signs in automatically")

                if DeviceCodeAuth.lastOwnerUserId != nil {
                    // Proactive approve event ("mobil onay"): this TV remembers
                    // its owner, so their signed-in Yaver app is being offered a
                    // one-tap approve — say so, and say how to verify (number
                    // match), instead of leaving the shortcut undiscoverable.
                    Label {
                        Text("We've also asked the Yaver app on your phone — approve there and check the code matches this screen.")
                            .font(.system(size: 17))
                            .foregroundStyle(.secondary)
                    } icon: {
                        Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                            .foregroundStyle(.blue)
                    }
                    .padding(.top, 6)
                }

                if let code = start?.userCode {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("OR ENTER THIS CODE")
                            .font(.system(size: 15, weight: .bold)).tracking(2)
                            .foregroundStyle(.secondary)
                        Text(code)
                            .font(.system(size: 46, weight: .heavy, design: .monospaced))
                            .tracking(4)
                        // LAN approval number match (2026-08-13): approving
                        // surfaces on the same network show this same 3-digit
                        // number. Compare on both screens before approving.
                        if let mc = start?.matchCode {
                            HStack(spacing: 8) {
                                Text("Match code")
                                    .font(.system(size: 15)).foregroundStyle(.secondary)
                                Text(mc)
                                    .font(.system(size: 26, weight: .heavy, design: .monospaced))
                                    .foregroundStyle(.green)
                            }
                            .padding(.top, 2)
                        }
                    }
                    .padding(.top, 24)
                }

                if approving {
                    Label("Approved — signing in…", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.green).padding(.top, 20)
                } else if let approver = lanApprover, let s = start {
                    // LAN approval prompt (2026-08-13): an authenticated
                    // surface on the same network saw this TV's beacon and
                    // asked to sign it in. The user physically at the TV
                    // confirms Allow/Deny — the number-match guard against a
                    // rogue LAN request. The 60s window expires server-side.
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Approve sign-in from \(approver.approverEmail ?? "your phone")?")
                            .font(.system(size: 24, weight: .semibold))
                        HStack(spacing: 8) {
                            Text("Match code")
                                .font(.system(size: 15)).foregroundStyle(.secondary)
                            Text(approver.matchCode ?? s.matchCode ?? "---")
                                .font(.system(size: 34, weight: .heavy, design: .monospaced))
                                .foregroundStyle(.green)
                        }
                        Text("The same number must show on the requesting device. Approving signs this TV into that account.")
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                        HStack(spacing: 14) {
                            Button(lanConfirming ? "Confirming…" : "Allow") {
                                confirmLan(allow: true)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(lanConfirming)
                            Button("Deny") {
                                confirmLan(allow: false)
                            }
                            .buttonStyle(.bordered)
                            .disabled(lanConfirming)
                        }
                        .padding(.top, 4)
                    }
                    .padding(.top, 20)
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
                    Button {
                        startNativeAppleSignIn()
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "apple.logo")
                            Text(appleBusy ? "Signing in…" : "Sign in with Apple")
                                .font(.system(size: 20, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(.black)
                    .disabled(appleBusy)
                    Text("Uses the Apple ID already on this Apple TV. If nothing happens when you press it, the build's provisioning profile may be missing the Sign in with Apple capability — use the QR or email below instead.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 28)

                // Email/password — the third path. The QR covers every
                // provider but needs a phone; Apple needs a linked account.
                // Email needs neither. Same /auth/login the web uses.
                VStack(alignment: .leading, spacing: 10) {
                    Text("or sign in with email")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 22)
                    TextField("Email", text: $email)
                        .textFieldStyle(.plain)
                        .font(.system(size: 20))
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .background(.gray.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                        .focused($emailFocused)
                    SecureField("Password", text: $password)
                        .textFieldStyle(.plain)
                        .font(.system(size: 20))
                        .textContentType(.password)
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .background(.gray.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                        .focused($passwordFocused)
                    HStack(spacing: 14) {
                        Button(emailBusy ? "Signing in…" : "Sign in") {
                            handleEmailSignIn()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(emailBusy || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                        Text("Type with the remote — or approve the QR above from your phone.")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                    }
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.bottom, 36)
            }
            .frame(maxWidth: 620, maxHeight: .infinity, alignment: .topLeading)

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
            beacon.stop()
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

    /// Native Apple sign-in via a MANUAL ASAuthorizationController (2026-08-13).
    ///
    /// SwiftUI's SignInWithAppleButton swallowed failures on tvOS: when the
    /// build's provisioning profile lacks the Sign in with Apple capability,
    /// pressing the white button did NOTHING — no sheet, no callback, no error
    /// to the app. A manual controller surfaces every failure through the
    /// delegate, so "does nothing" becomes a named message pointing at the fix
    /// (profile capability) or at the QR/email fallbacks.
    private func startNativeAppleSignIn() {
        guard !appleBusy else { return }
        error = nil
        appleBusy = true
        defer { appleBusy = false }
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        let controller = ASAuthorizationController(authorizationRequests: [request])
        let delegate = AppleAuthControllerDelegate { result in
            Task { @MainActor in
                await handleAppleAuthResult(result)
            }
        }
        // Strong ref so the delegate (and the controller) outlive the call —
        // deallocating either mid-flight is a silent no-op.
        appleDelegate = delegate
        controller.delegate = delegate
        controller.presentationContextProvider = delegate
        controller.performRequests()
    }

    private func handleAppleAuthResult(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let err):
            // Backing out of the Apple sheet is a choice, not a failure.
            if (err as? ASAuthorizationError)?.code == .canceled { return }
            let ns = err as NSError
            if ns.domain == "AuthenticationServicesErrorDomain" && ns.code == ASAuthorizationError.failed.rawValue {
                error = "Apple sign-in isn't available in this build — its provisioning profile is likely missing the Sign in with Apple capability. Use the QR code or email below."
            } else {
                error = err.localizedDescription
            }
        case .success(let authorization):
            do {
                let token = try await AppleNativeAuth.completeSignIn(with: authorization)
                beacon.stop()
                pollTask?.cancel()      // the device code is moot now
                store.signIn(token: token)
            } catch {
                // Covers 2FA and accounts that sign in with another provider —
                // both point at the QR/email paths which serve every case.
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// Email/password sign-in — the couch path for an account that isn't
    /// Apple-linked (or has 2FA). Same POST /auth/login the web + CLI use;
    /// the server's own rate limits and allowlist apply unchanged.
    private func handleEmailSignIn() {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty, !password.isEmpty, !emailBusy else { return }
        emailBusy = true
        error = nil
        emailFocused = false
        passwordFocused = false
        Task {
            defer { emailBusy = false }
            do {
                let token = try await EmailAuth.signIn(email: cleanEmail, password: password)
                pollTask?.cancel()      // the device code is moot now
                fallbackPollTask?.cancel()
                store.signIn(token: token)
            } catch {
                // Includes 2FA ("use the QR"), invalid creds, lockout, and the
                // server's 403 allowlist message verbatim.
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// LAN approval, phase 2 (2026-08-13): the user at the TV presses
    /// Allow/Deny. Allow binds the requesting surface's account; Deny clears
    /// the pending window (the QR path stays usable). On Allow the code is
    /// authorized server-side and the normal claim flow picks up the token.
    private func confirmLan(allow: Bool) {
        guard let s = start, !lanConfirming else { return }
        lanConfirming = true
        error = nil
        Task {
            defer { lanConfirming = false }
            let r = await DeviceCodeAuth.lanConfirm(deviceCode: s.deviceCode, allow: allow)
            if allow, r.ok == true, let handle = r.claimHandle {
                // Authorized by the LAN approver — claim exactly like a QR
                // approval. Stop the beacon; the code is spent.
                beacon.stop()
                let claimed = await DeviceCodeAuth.claim(deviceCode: s.deviceCode, claimHandle: handle)
                if let token = claimed.token {
                    pollTask?.cancel()
                    fallbackPollTask?.cancel()
                    store.signIn(token: token)
                    return
                }
                error = "Approved — but the session couldn't be picked up yet. Retrying…"
                lanApprover = nil
            } else if !allow {
                lanApprover = nil // denied — back to the normal waiting screen
            } else if let reason = r.reason, reason == "no_pending_approver" {
                lanApprover = nil
                error = "The approval request expired. Ask the other device to try again."
            } else {
                lanApprover = nil
                error = r.reason ?? "Approval failed — try the QR code instead."
            }
        }
    }

    private func begin() async {
        error = nil
        expired = false
        unreachable = nil
        lanApprover = nil
        beacon.stop()
        do {
            let s = try await DeviceCodeAuth.start()
            start = s
            waitingSince = Date()
            now = Date()
            // Same-network discovery: broadcast the waiting code so an
            // authenticated surface on the LAN can approve without scanning.
            if let nonce = s.approveNonce, !nonce.isEmpty {
                beacon.start(machineName: "Apple TV",
                             approveNonce: nonce,
                             matchCode: s.matchCode ?? "000",
                             expiresAtMs: s.expiresAt)
            }
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
            beacon.stop()
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
            // LAN approval surfaced — render Allow/Deny while the 60s window
            // is open; clear the prompt once the window lapses server-side.
            if let pending = r.lanPending {
                if pending.expiresAt == nil || (pending.expiresAt ?? 0) > Date().timeIntervalSince1970 * 1000 {
                    lanApprover = pending
                } else {
                    lanApprover = nil
                }
            } else {
                lanApprover = nil
            }
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

/// Manual ASAuthorizationController delegate (2026-08-13).
///
/// SwiftUI's SignInWithAppleButton swallowed failures on tvOS — when the
/// provisioning profile lacks the Sign in with Apple capability, the button
/// did NOTHING (no sheet, no callback), which read as a dead button. A manual
/// controller reaches the delegate with the real error in every case, so the
/// TV can name the cause (missing profile capability) and point at the
/// QR/email fallbacks instead of leaving the user staring at a button.
private final class AppleAuthControllerDelegate: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private let completion: (Result<ASAuthorization, Error>) -> Void

    init(completion: @escaping (Result<ASAuthorization, Error>) -> Void) {
        self.completion = completion
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        completion(.success(authorization))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        completion(.failure(error))
    }

    /// tvOS presentation anchor: the key window's root view controller.
    @MainActor
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
    }
}
