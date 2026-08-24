import { afterAll, describe, expect, test } from "bun:test";
import { MobileClient } from "../src/mobile-client";

let seenURL = "";
let seenPassword = "";
let seenAuthorization = "";
let seenCookie = "";

const server = Bun.serve({
  port: 0,
  fetch(request) {
    seenURL = request.url;
    seenPassword = request.headers.get("X-Relay-Password") ?? "";
    seenAuthorization = request.headers.get("Authorization") ?? "";
    seenCookie = request.headers.get("Cookie") ?? "";
    const path = new URL(request.url).pathname;
    if (path.endsWith("/dev/")) {
      return new Response("preview", {
        headers: {
          "Set-Cookie": "yaver_rp=opaque-cookie-under-test; Path=/d/device-under-test/; HttpOnly; SameSite=Lax",
        },
      });
    }
    if (path.endsWith("/dev-web/app.js")) {
      return seenCookie === "yaver_rp=opaque-cookie-under-test"
        ? new Response("bundle")
        : new Response("unauthorized", { status: 401 });
    }
    return Response.json({ ok: true });
  },
});

afterAll(() => server.stop(true));

describe("relay authentication", () => {
  test("uses the relay header and never leaks the password into the URL", async () => {
    const client = new MobileClient({
      agentBaseUrl: `http://127.0.0.1:${server.port}/d/device-under-test`,
      agentRelayPassword: "relay-secret-under-test",
      authToken: "owner-token-under-test",
    });

    const response = await client.raw.get("/info");

    expect(response.status).toBe(200);
    expect(seenPassword).toBe("relay-secret-under-test");
    expect(seenURL).not.toContain("relay-secret-under-test");
    expect(seenURL).not.toContain("__rp");
  });

  test("HEAD uses the same secure relay authentication path", async () => {
    const client = new MobileClient({
      agentBaseUrl: `http://127.0.0.1:${server.port}/d/device-under-test`,
      agentRelayPassword: "head-relay-secret-under-test",
    });

    const response = await client.raw.head("/dev/");

    expect(response.status).toBe(200);
    expect(seenPassword).toBe("head-relay-secret-under-test");
    expect(seenURL).not.toContain("head-relay-secret-under-test");
  });

  test("preview assets use only the scoped cookie after an authenticated document request", async () => {
    const client = new MobileClient({
      agentBaseUrl: `http://127.0.0.1:${server.port}/d/device-under-test`,
      agentRelayPassword: "preview-relay-secret-under-test",
      authToken: "preview-owner-token-under-test",
    });

    const result = await client.probeRelayPreviewCookie("/dev-web/app.js");

    expect(result).toEqual({
      ok: true,
      code: "PREVIEW_COOKIE_READY",
      documentStatus: 200,
      assetStatus: 200,
      cookie: {
        present: true,
        httpOnly: true,
        sameSiteLax: true,
        secure: false,
        pathScoped: true,
      },
    });
    expect(seenCookie).toBe("yaver_rp=opaque-cookie-under-test");
    expect(seenAuthorization).toBe("");
    expect(seenPassword).toBe("");
    expect(JSON.stringify(result)).not.toContain("opaque-cookie-under-test");
  });
});
