// sseClient.ts — ONE way this app consumes Server-Sent Events.
//
// ── Why this file exists (the bug it fixes) ──────────────────────────────────
//
// React Native's `fetch` does NOT implement a streaming response body. It is the
// whatwg-fetch polyfill: `response.body` is **undefined**, so
//
//     const res = await fetch(url);
//     const reader = res.body?.getReader();   // undefined in RN
//     if (!reader) return;                    // ← silently gives up, forever
//
// never reads one byte. That exact code shipped in app/(tabs)/apps.tsx and
// src/components/DevPreview.tsx for the /dev/events stream, which is how the
// preview overlay learns (a) the dev server's log lines and (b) the `ready` event
// that clears the spinner.
//
// The user-visible result, reproduced on video on 2026-07-25 against a Mac mini:
// "Starting flutter dev server… 0:04 → 0:50 elapsed · waiting for the first output
// from the box" — for the whole session, while the agent was demonstrably emitting
// log frames every second (captured on the box: 5 `log`, 3 `phase`, 7 `snapshot`,
// 1 `ready` in the first 35s). The phone was never listening. Rendering fixes for
// WHICH frames to show could not help: the socket was never read.
//
// The app already knew this. src/lib/quic.ts::streamTaskOutput and
// app/(tabs)/settings.tsx both use XMLHttpRequest + onprogress, with a comment
// explaining that RN's fetch can't stream. That knowledge simply never reached the
// dev-events consumers — which is the drift this module ends by being the only
// implementation.
//
// ── Contract ────────────────────────────────────────────────────────────────
//
// XHR's `onprogress` fires with the response accumulated SO FAR, so we track how
// much has been parsed and only handle the new tail. Frames are separated by a
// blank line and may split across progress events, so an incomplete tail is
// carried forward.

/** One parsed SSE frame's payload plus its (rare) event name. */
export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Split an SSE buffer into complete frames plus the unparsed remainder.
 *
 * Pure and exported so the framing rules are testable without a socket — the
 * chunk-boundary bug that dropped log lines over the relay was invisible until
 * exactly this was tested.
 */
export function parseSseBuffer(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;

  for (;;) {
    // Accept both \n\n and \r\n\r\n separators.
    const lf = rest.indexOf("\n\n");
    const crlf = rest.indexOf("\r\n\r\n");
    let idx = -1;
    let sepLen = 2;
    if (lf >= 0 && (crlf < 0 || lf <= crlf)) {
      idx = lf;
      sepLen = 2;
    } else if (crlf >= 0) {
      idx = crlf;
      sepLen = 4;
    }
    if (idx < 0) break;

    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + sepLen);

    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // comment / keep-alive (":hello 1784…")
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        // Per spec a single leading space after the colon is stripped.
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }

  return { frames, rest };
}

export interface SseSubscription {
  /** Abort the stream. Idempotent. */
  close(): void;
}

export interface SseOptions {
  url: string;
  headers?: Record<string, string>;
  /** Default GET. Some agent streams are POST (e.g. /tasks/<id>/output). */
  method?: "GET" | "POST";
  body?: string;
  /** Called once per JSON-decodable frame. Non-JSON frames go to onRawFrame. */
  onEvent?: (event: any) => void;
  onRawFrame?: (frame: SseFrame) => void;
  /** Fired when headers arrive — proof the stream actually opened. */
  onOpen?: (status: number) => void;
  /** Network failure or a non-2xx status. */
  onError?: (reason: string) => void;
  /** Server closed the stream (or we did). */
  onClose?: () => void;
}

/**
 * Subscribe to an SSE endpoint. Works on iOS and Android because it never
 * touches `response.body`.
 *
 * Returns a handle whose close() aborts the request. Callers are expected to call
 * it from their effect cleanup — an abandoned XHR keeps a connection slot, and iOS
 * caps those per host.
 */
export function subscribeSse(opts: SseOptions): SseSubscription {
  const xhr = new XMLHttpRequest();
  let parsedUpTo = 0;
  let carry = "";
  let closed = false;
  let opened = false;

  const finish = (reason?: string) => {
    if (closed) return;
    closed = true;
    if (reason && opts.onError) opts.onError(reason);
    if (opts.onClose) opts.onClose();
  };

  const consume = () => {
    if (closed) return;
    const text = xhr.responseText || "";
    if (text.length <= parsedUpTo) return;
    carry += text.slice(parsedUpTo);
    parsedUpTo = text.length;

    const { frames, rest } = parseSseBuffer(carry);
    carry = rest;
    for (const frame of frames) {
      if (opts.onRawFrame) opts.onRawFrame(frame);
      if (!opts.onEvent) continue;
      try {
        opts.onEvent(JSON.parse(frame.data));
      } catch {
        // A non-JSON frame is not an error worth surfacing — some endpoints send
        // plain-text keep-alives.
      }
    }
  };

  xhr.open(opts.method ?? "GET", opts.url, true);
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    try {
      xhr.setRequestHeader(k, v);
    } catch {
      // RN rejects a few restricted headers; the rest still apply.
    }
  }
  try {
    xhr.setRequestHeader("Accept", "text/event-stream");
  } catch {
    /* ignore */
  }

  xhr.onreadystatechange = () => {
    if (xhr.readyState === 2 /* HEADERS_RECEIVED */ && !opened) {
      opened = true;
      if (opts.onOpen) opts.onOpen(xhr.status);
      // A non-2xx SSE response is a failure that used to look identical to
      // "the box is quiet" — 401 on a missing relay password being the common one.
      if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
        finish(`stream rejected with HTTP ${xhr.status}`);
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
      }
    }
  };
  xhr.onprogress = consume;
  xhr.onload = () => {
    consume();
    finish();
  };
  xhr.onerror = () => finish("stream connection failed");
  xhr.ontimeout = () => finish("stream timed out");
  xhr.onabort = () => finish();

  try {
    xhr.send(opts.body ?? null);
  } catch (e) {
    finish(e instanceof Error ? e.message : "could not start the stream");
  }

  return {
    close() {
      if (closed) return;
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
