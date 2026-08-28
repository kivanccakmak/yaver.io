import Foundation
import React
import UIKit

/**
 * Passive, capability-gated three-finger hold for Dogfood quick controls.
 *
 * The recognizer is attached to the app window with cancelsTouchesInView=false
 * and simultaneous recognition enabled, so observing the gesture does not
 * install a transparent React overlay or take ownership of ordinary app taps.
 * VoiceOver and Switch Control disable it because accessibility owns complex
 * multi-touch gestures; JS then renders the minimized draggable Y fallback.
 */
@objc(YaverDogfoodGesture)
class YaverDogfoodGesture: RCTEventEmitter, UIGestureRecognizerDelegate {
  private static let triggerEvent = "yaverDogfoodControlGesture"
  private static let capabilityEvent = "yaverDogfoodControlCapability"

  private weak var attachedWindow: UIWindow?
  private var recognizer: UILongPressGestureRecognizer?
  private var requestedEnabled = false
  private var durationMs: Double = 900
  private var hasJSListeners = false
  private var observers: [NSObjectProtocol] = []

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    [Self.triggerEvent, Self.capabilityEvent]
  }

  override func startObserving() {
    hasJSListeners = true
  }

  override func stopObserving() {
    hasJSListeners = false
  }

  override init() {
    super.init()
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in self?.reconcile() })
    observers.append(center.addObserver(
      forName: UIAccessibility.voiceOverStatusDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in self?.reconcileAndEmit() })
    observers.append(center.addObserver(
      forName: UIAccessibility.switchControlStatusDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in self?.reconcileAndEmit() })
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
    detach()
  }

  @objc func getCapability(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async { resolve(self.status()) }
  }

  @objc func setEnabled(_ enabled: Bool,
                        durationMs: Double,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.requestedEnabled = enabled
      self.durationMs = min(max(durationMs, 650), 2000)
      self.reconcile()
      resolve(self.status())
    }
  }

  private func accessibilityConflict() -> Bool {
    UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning
  }

  private func simulatorInputConflict() -> Bool {
    #if targetEnvironment(simulator)
      // Simulator's Option-key multi-touch synthesizes two pointers only.
      // Treat it as unsupported so the SDK exposes the tappable Y fallback.
      return true
    #else
      return false
    #endif
  }

  private func keyWindow() -> UIWindow? {
    if #available(iOS 13.0, *) {
      return UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
        .first(where: { $0.isKeyWindow })
    }
    return UIApplication.shared.keyWindow
  }

  private func status() -> [String: Any] {
    let accessibility = accessibilityConflict()
    let simulator = simulatorInputConflict()
    let windowAvailable = keyWindow() != nil
    return [
      "supported": !accessibility && !simulator,
      "enabled": requestedEnabled && !accessibility && !simulator && recognizer != nil,
      "reason": accessibility
        ? "accessibility-touch-exploration"
        : (simulator ? "simulator-three-finger-input-unavailable" : (windowAvailable ? "supported" : "window-unavailable")),
      "platform": "ios",
    ]
  }

  private func reconcileAndEmit() {
    reconcile()
    if hasJSListeners {
      sendEvent(withName: Self.capabilityEvent, body: status())
    }
  }

  private func reconcile() {
    guard requestedEnabled, !accessibilityConflict(), !simulatorInputConflict(), let window = keyWindow() else {
      detach()
      return
    }
    if attachedWindow === window, let recognizer = recognizer {
      recognizer.minimumPressDuration = durationMs / 1000
      recognizer.isEnabled = true
      return
    }
    detach()
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(handleHold(_:)))
    hold.minimumPressDuration = durationMs / 1000
    hold.numberOfTouchesRequired = 3
    hold.cancelsTouchesInView = false
    hold.delaysTouchesBegan = false
    hold.delaysTouchesEnded = false
    hold.delegate = self
    window.addGestureRecognizer(hold)
    attachedWindow = window
    recognizer = hold
  }

  private func detach() {
    if let recognizer = recognizer {
      attachedWindow?.removeGestureRecognizer(recognizer)
    }
    recognizer = nil
    attachedWindow = nil
  }

  @objc private func handleHold(_ sender: UILongPressGestureRecognizer) {
    guard sender.state == .began, requestedEnabled, !accessibilityConflict() else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    if hasJSListeners {
      sendEvent(withName: Self.triggerEvent, body: ["source": "three-finger-hold"])
    }
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldReceive touch: UITouch) -> Bool {
    !accessibilityConflict()
  }
}
