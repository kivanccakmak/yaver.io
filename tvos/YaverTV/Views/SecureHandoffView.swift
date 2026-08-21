import CoreImage.CIFilterBuiltins
import SwiftUI

struct SecureHandoffView: View {
    @EnvironmentObject private var store: YaverStore
    @State private var request: CredentialHandoffRequest?
    @State private var requestQR: CGImage?
    @State private var envelope: CredentialHandoffEnvelope?
    @State private var scanning = false
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Secure handoff").font(.largeTitle.bold())
                Text("Receive one approved credential directly. Yaver servers receive only this TV’s public key—not the QR response or credential.").foregroundStyle(.secondary)
                Label("Non-secret preferences already follow this signed-in account automatically; only keys and tokens need this handoff.", systemImage: "checkmark.icloud")
                    .foregroundStyle(.secondary)
                if let image = requestQR {
                    Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit()
                        .frame(width: 420, height: 420).background(.white).clipShape(RoundedRectangle(cornerRadius: 16))
                    Text("1. Scan this request with Yaver on your phone.  2. Choose one credential.  3. Show the encrypted response QR to the connected iPhone/iPad camera.")
                }
                if let envelope, let request {
                    Text("Verification code: \(CredentialHandoff.verificationCode(request: request, envelope: envelope))")
                        .font(.title.bold()).monospacedDigit()
                    Button("Codes match — save on this Apple TV") { accept() }.buttonStyle(.borderedProminent).disabled(busy)
                } else {
                    Button("Scan encrypted response") { scanning = true }.buttonStyle(.borderedProminent).disabled(request == nil || busy)
                }
                if let message { Text(message).foregroundStyle(message.hasPrefix("Saved") ? .green : .orange) }
            }.padding(48)
        }
        .task { await prepare() }
        .fullScreenCover(isPresented: $scanning) {
            ContinuityQRScannerView { value in
                do { envelope = try CredentialHandoff.parseEnvelope(value); message = nil }
                catch { message = "That QR is not a valid encrypted Yaver handoff response." }
            }
        }
    }

    private func prepare() async {
        guard !store.token.isEmpty else { message = "Sign in before receiving credentials."; return }
        busy = true; defer { busy = false }
        do {
            var validate = URLRequest(url: Backend.convexSiteURL.appendingPathComponent("auth/validate"))
            validate.setValue("Bearer \(store.token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: validate)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let user = root["user"] as? [String: Any],
                  let accountID = (user["id"] ?? user["userId"]) as? String else { throw URLError(.userAuthenticationRequired) }
            let made = try CredentialHandoff.makeRequest(accountID: accountID)
            var register = URLRequest(url: Backend.convexSiteURL.appendingPathComponent("credential-handoff/devices"))
            register.httpMethod = "POST"
            register.setValue("Bearer \(store.token)", forHTTPHeaderField: "Authorization")
            register.setValue("application/json", forHTTPHeaderField: "Content-Type")
            register.httpBody = try JSONSerialization.data(withJSONObject: ["deviceId": made.targetDeviceId, "publicKey": made.targetPublicKey, "platform": "tvos"])
            let (_, registerResponse) = try await URLSession.shared.data(for: register)
            guard (registerResponse as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.cannotConnectToHost) }
            request = made
            requestQR = try qrImage(CredentialHandoff.encodeQR(made))
        } catch { message = "Secure handoff couldn't start. Check sign-in and network access, then reopen this screen." }
    }

    private func accept() {
        guard let request, let envelope else { return }
        busy = true; defer { busy = false }
        do { let kind = try CredentialHandoff.accept(envelope, request: request); self.envelope = nil; message = "Saved \(kind) in this Apple TV’s Keychain." }
        catch { message = "The response failed authentication, expired, or belongs to another device." }
    }

    private func qrImage(_ value: String) throws -> CGImage {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(value.utf8); filter.correctionLevel = "L"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { throw QRFailure.failed }
        return image
    }
    enum QRFailure: Error { case failed }
}
