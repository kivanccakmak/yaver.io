"use strict";

// Chromium network failures that are commonly temporary while a local web
// server starts, DNS reconnects, or a machine changes networks. Keep this
// policy separate from Electron wiring so it can be proved headlessly.
const TRANSIENT_MAIN_FRAME_ERRORS = new Set([
  -2,   // ERR_FAILED
  -6,   // ERR_FILE_NOT_FOUND (local dev asset/server race)
  -7,   // ERR_TIMED_OUT
  -21,  // ERR_NETWORK_CHANGED
  -102, // ERR_CONNECTION_REFUSED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -118, // ERR_CONNECTION_TIMED_OUT
  -137, // ERR_NAME_RESOLUTION_FAILED
]);

const MAX_TRANSIENT_LOAD_RETRIES = 4;

function rendererLoadRetryDelay(attempt) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  return Math.min(4_000, 500 * (2 ** (normalizedAttempt - 1)));
}

function shouldRetryRendererLoad({ code, attempts, maxAttempts = MAX_TRANSIENT_LOAD_RETRIES }) {
  return TRANSIENT_MAIN_FRAME_ERRORS.has(Number(code)) && attempts < maxAttempts;
}

module.exports = {
  MAX_TRANSIENT_LOAD_RETRIES,
  rendererLoadRetryDelay,
  shouldRetryRendererLoad,
};
