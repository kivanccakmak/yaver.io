import XCTest
@testable import YaverTV

final class DeviceCodeDeliveryTests: XCTestCase {
    func testOneTimeTokenWinsWhileOtherLaneClaims() {
        XCTAssertEqual(
            DeviceCodeDeliveryDecision.decide(
                status: .authorized,
                token: "one-time-bearer",
                claimInFlight: true
            ),
            .signIn("one-time-bearer")
        )
    }

    func testOnlyOneLaneClaims() {
        XCTAssertEqual(
            DeviceCodeDeliveryDecision.decide(status: .authorized, token: nil, claimInFlight: false),
            .claim
        )
        XCTAssertEqual(
            DeviceCodeDeliveryDecision.decide(status: .authorized, token: nil, claimInFlight: true),
            .wait
        )
    }

    func testPendingWaitsAndExpiredRotates() {
        XCTAssertEqual(
            DeviceCodeDeliveryDecision.decide(status: .pending, token: nil, claimInFlight: false),
            .wait
        )
        XCTAssertEqual(
            DeviceCodeDeliveryDecision.decide(status: .expired, token: nil, claimInFlight: false),
            .rotate
        )
    }
}
