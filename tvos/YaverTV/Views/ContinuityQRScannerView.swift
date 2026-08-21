import AVFoundation
import AVKit
import SwiftUI

@MainActor
final class ContinuityQRScanner: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate {
    let session = AVCaptureSession()
    @Published var error: String?
    private var delivered = false
    var onCode: ((String) -> Void)?

    func connect(_ continuityDevice: AVContinuityDevice?) {
        guard let camera = continuityDevice?.videoDevices.first else {
            error = "The selected continuity device has no available camera."
            return
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.inputs.forEach(session.removeInput)
        session.outputs.forEach(session.removeOutput)
        do {
            let input = try AVCaptureDeviceInput(device: camera)
            guard session.canAddInput(input) else { throw ScannerError.inputRejected }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { throw ScannerError.outputRejected }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            guard output.availableMetadataObjectTypes.contains(.qr) else { throw ScannerError.qrUnavailable }
            output.metadataObjectTypes = [.qr]
            delivered = false
            let captureSession = session
            DispatchQueue.global(qos: .userInitiated).async { captureSession.startRunning() }
        } catch {
            self.error = "The connected camera couldn't start QR scanning."
        }
    }

    func stop() { if session.isRunning { session.stopRunning() } }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        Task { @MainActor [weak self] in
            guard let self, !self.delivered else { return }
            self.delivered = true
            self.stop()
            self.onCode?(value)
        }
    }

    enum ScannerError: Error { case inputRejected, outputRejected, qrUnavailable }
}

private final class CameraPreview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

private struct ContinuityCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> CameraPreview {
        let view = CameraPreview()
        view.previewLayer.videoGravity = .resizeAspectFill
        view.previewLayer.session = session
        return view
    }
    func updateUIView(_ uiView: CameraPreview, context: Context) { uiView.previewLayer.session = session }
}

struct ContinuityQRScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var scanner = ContinuityQRScanner()
    @State private var showPicker = true
    let onCode: (String) -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ContinuityCameraPreview(session: scanner.session).ignoresSafeArea()
            VStack {
                HStack {
                    Button("Cancel") { scanner.stop(); dismiss() }.buttonStyle(.borderedProminent)
                    Spacer()
                }
                Spacer()
                Text(scanner.error ?? "Point the connected iPhone or iPad camera at the encrypted Yaver QR code.")
                    .font(.title3.weight(.semibold)).padding(20).background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 16))
            }.padding(44)
        }
        .continuityDevicePicker(isPresented: $showPicker) { device in scanner.connect(device) }
        .onAppear { scanner.onCode = { value in onCode(value); dismiss() } }
        .onDisappear { scanner.stop() }
    }
}
