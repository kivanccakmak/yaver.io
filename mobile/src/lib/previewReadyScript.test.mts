// previewReadyScript.test.mts — `npx tsx src/lib/previewReadyScript.test.mts`.
//
// Locks the browser-lane contract:
// - Expo's document shell with an empty #root is NOT rendered.
// - A committed SPA root remains rendered for compatibility; visible-box facts
//   are diagnostics, not a hard gate that can break working apps.

import assert from "node:assert/strict";
import {
  PREVIEW_PROBE_STATE_FUNCTION,
  PREVIEW_READY_PREDICATE,
} from "./previewReadyScript";

const makeFns = () => {
  const fn = new Function(`${PREVIEW_PROBE_STATE_FUNCTION}; ${PREVIEW_READY_PREDICATE}; return { yaverPreviewProbeState, yaverPreviewReady };`);
  return fn() as {
    yaverPreviewProbeState: (doc: any) => any;
    yaverPreviewReady: (doc: any) => boolean;
  };
};

const el = (opts: any = {}) => ({
  id: opts.id || "",
  tagName: opts.tagName || "DIV",
  children: opts.children || [],
  innerText: opts.innerText || "",
  querySelectorAll: () => opts.querySelectorAll || [],
  getBoundingClientRect: () => opts.rect || { width: 0, height: 0 },
});

const doc = (opts: any = {}) => {
  const root = opts.root === undefined ? null : opts.root;
  return {
    title: opts.title || "",
    location: { href: opts.href || "http://agent/dev-web/" },
    body: {
      children: opts.bodyChildren || [],
      innerText: opts.bodyText || "",
    },
    defaultView: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
    getElementById: (id: string) => {
      if (id === "root" || id === "app") return root;
      if (id === "splash") return opts.splash || null;
      return null;
    },
    querySelector: (selector: string) => {
      if (selector.includes("flutter-view")) return opts.flutterMarker || null;
      if (selector.includes("flutter")) return opts.flutterScript || null;
      return null;
    },
  };
};

const { yaverPreviewProbeState, yaverPreviewReady } = makeFns();

{
  const d = doc({
    root: el({ id: "root", children: [] }),
    bodyChildren: [el({ tagName: "NOSCRIPT" }), el({ id: "root" }), el({ tagName: "SCRIPT" })],
  });
  assert.equal(yaverPreviewReady(d), false, "Expo shell with empty #root must not be rendered");
  assert.equal(yaverPreviewProbeState(d).reason, "empty_mount");
}

{
  const d = doc({
    root: el({ id: "root", children: [el()] }),
    bodyChildren: [el({ tagName: "NOSCRIPT" }), el({ id: "root" }), el({ tagName: "SCRIPT" })],
  });
  assert.equal(yaverPreviewReady(d), true, "committed SPA root remains rendered for compatibility");
  assert.equal(yaverPreviewProbeState(d).reason, "mount_without_visible_content");
}

{
  const d = doc({ bodyText: '{"status":"starting"}', bodyChildren: [el()] });
  assert.equal(yaverPreviewReady(d), false, "agent starting response is not app content");
  assert.equal(yaverPreviewProbeState(d).reason, "agent_starting_response");
}

{
  const d = doc({ flutterMarker: el({ tagName: "FLUTTER-VIEW" }), bodyChildren: [el()] });
  assert.equal(yaverPreviewReady(d), true, "Flutter engine marker is rendered");
  assert.equal(yaverPreviewProbeState(d).reason, "flutter_engine_attached");
}

console.log("previewReadyScript contract ok");
