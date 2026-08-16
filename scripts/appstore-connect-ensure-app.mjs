#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";

const ASC_ORIGIN = "https://api.appstoreconnect.apple.com";

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function decodePrivateKey(value) {
  const source = String(value || "").trim();
  if (source.includes("BEGIN PRIVATE KEY")) return source;

  let decoded = "";
  try {
    decoded = Buffer.from(source.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    // The stable error below deliberately does not echo secret material.
  }
  if (!decoded.includes("BEGIN PRIVATE KEY")) {
    throw new Error("ASC_API_KEY must be a raw PEM .p8 key or its base64 encoding");
  }
  return decoded;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createToken({ keyId, issuerId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 15 * 60,
    aud: "appstoreconnect-v1",
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`App Store Connect returned non-JSON HTTP ${response.status}`);
  }
}

function apiError(action, response, body) {
  const details = Array.isArray(body?.errors)
    ? body.errors.map((entry) => entry?.detail || entry?.title).filter(Boolean).join("; ")
    : "";
  return new Error(`${action} failed with HTTP ${response.status}${details ? `: ${details}` : ""}`);
}

export async function ensureApp({
  fetchImpl = fetch,
  token,
  bundleId = "io.yaver.gui",
  name = "Yaver",
  primaryLocale = "en-US",
  sku = "io-yaver-gui-macos",
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const lookup = new URL("/v1/apps", ASC_ORIGIN);
  lookup.searchParams.set("filter[bundleId]", bundleId);
  lookup.searchParams.set("limit", "2");

  const findExisting = async () => {
    const response = await fetchImpl(lookup, { headers });
    const body = await responseJson(response);
    if (!response.ok) throw apiError("App lookup", response, body);
    return (body.data || []).find((entry) => entry?.attributes?.bundleId === bundleId);
  };

  const existing = await findExisting();
  if (existing) return { created: false, id: existing.id, bundleId };

  const response = await fetchImpl(new URL("/v1/apps", ASC_ORIGIN), {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: {
        type: "apps",
        attributes: { bundleId, name, primaryLocale, sku },
      },
    }),
  });
  const body = await responseJson(response);
  if (response.ok) return { created: true, id: body.data?.id, bundleId };

  // A concurrent owner run can create the same record between GET and POST.
  // Resolve a conflict by proving the desired record now exists.
  if (response.status === 409) {
    const raced = await findExisting();
    if (raced) return { created: false, id: raced.id, bundleId };
  }
  throw apiError("App creation", response, body);
}

export async function main(env = process.env) {
  const privateKey = decodePrivateKey(required(env, "ASC_API_KEY"));
  const token = createToken({
    keyId: required(env, "ASC_KEY_ID"),
    issuerId: required(env, "ASC_ISSUER_ID"),
    privateKey,
  });
  const result = await ensureApp({ token });
  console.log(result.created
    ? `Created App Store Connect app record for ${result.bundleId} (id ${result.id}).`
    : `App Store Connect app record already exists for ${result.bundleId} (id ${result.id}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
