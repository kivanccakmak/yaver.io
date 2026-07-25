/**
 * A browser must never be told to wait for a transport it cannot perform.
 *
 * Guards the 2026-07-25 defect: RN-web sat on "Transport pending" forever while
 * the same account on a real iPhone showed "Relay · 301ms". The browser was
 * waiting on QUIC, which it cannot speak at all.
 */
// react-native is not transformable under this jest config, and the module only
// needs Platform.OS. Mocking it keeps the test a pure check of the capability
// table rather than a test of the RN runtime.
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { TRANSPORT_CAPABILITIES, explainNoTransport, usableTransports, type TransportKind } from "./platformTransport";

describe("platform transport capabilities", () => {
  it("declares support for every transport kind (a new lane must not default to usable)", () => {
    const kinds: TransportKind[] = ["lan-beacon", "direct-http", "quic-relay", "quic-direct"];
    for (const k of kinds) {
      expect(TRANSPORT_CAPABILITIES[k]).toBeDefined();
      expect(typeof TRANSPORT_CAPABILITIES[k].supported).toBe("boolean");
    }
    expect(Object.keys(TRANSPORT_CAPABILITIES).sort()).toEqual([...kinds].sort());
  });

  it("every unsupported transport carries a plain-language reason", () => {
    for (const cap of Object.values(TRANSPORT_CAPABILITIES)) {
      if (!cap.supported) expect(cap.reason && cap.reason.length > 10).toBe(true);
    }
  });

  it("direct HTTP is always available — it is the browser's only lane", () => {
    expect(TRANSPORT_CAPABILITIES["direct-http"].supported).toBe(true);
    expect(usableTransports()).toContain("direct-http");
  });

  it("explainNoTransport stays silent while something is still possible", () => {
    expect(explainNoTransport(["direct-http"])).toBeNull();
    expect(explainNoTransport(["quic-relay", "direct-http"])).toBeNull();
  });

  it("under native, QUIC lanes are usable and produce no dead-end message", () => {
    // jest runs with Platform.OS === "ios" by default in this preset.
    expect(TRANSPORT_CAPABILITIES["quic-relay"].supported).toBe(true);
    expect(explainNoTransport(["quic-relay"])).toBeNull();
  });
});
