import crypto from "crypto";

export const SESSION_COOKIE_NAME = "yaver_session";

const SESSION_TTL_DAYS = 30;

export const createSessionToken = (): string =>
  crypto.randomBytes(32).toString("hex");

export const hashSessionToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

export const sessionMaxAgeSeconds = (): number =>
  SESSION_TTL_DAYS * 24 * 60 * 60;

export const sessionExpiresAtMs = (): number =>
  Date.now() + sessionMaxAgeSeconds() * 1000;
