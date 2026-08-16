// swift-tools-version:5.7
import PackageDescription

// Yaver Feedback SDK for Swift / iOS.
//
// ZERO DEPENDENCIES on purpose. This drops into third-party apps, and every
// transitive dependency is one their build might already have at a conflicting
// version — a feedback SDK is never worth a dependency conflict.
let package = Package(
    name: "YaverFeedback",
    // macOS is listed alongside iOS so `swift test` runs the PURE decision
    // seam (ReloadActions) on a developer's Mac without a simulator. Every
    // UIKit surface in the target is already behind `#if canImport(UIKit)`,
    // so nothing iOS-only is claimed to work on macOS — a test you cannot run
    // is a guard you have never seen fail.
    platforms: [.iOS(.v13), .macOS(.v10_15)],
    products: [
        .library(name: "YaverFeedback", targets: ["YaverFeedback"]),
    ],
    targets: [
        .target(name: "YaverFeedback", path: "Sources/YaverFeedback"),
        .testTarget(
            name: "YaverFeedbackTests",
            dependencies: ["YaverFeedback"],
            path: "Tests/YaverFeedbackTests"
        ),
    ]
)
