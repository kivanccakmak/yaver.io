"use client";

// DomInspectChip — the visible, switchable half of Yaver's DOM MODE (element
// inspect). Browse | Inspect radio + the attached-element chip.
//
// ── Why a radio, not a toggle ─────────────────────────────────────────────
//
// While Inspect is ON the probe intercepts clicks in the preview — the real
// app cannot be used. That exclusivity must be visible, so the control is a
// two-position radio (Browse | Inspect), not a button that could be mistaken
// for a badge. The mode also auto-offs after a selection (and on Escape), so
// the user returns to real app usage immediately.
//
// ── The rule this exists to satisfy ───────────────────────────────────────
//
// SILENT PROMPT MUTATION IS A DEFECT. The agent prepends a block describing
// the element the user clicked to the prompt they typed. If the user cannot
// see that happening and cannot stop it, we have built exactly the kind of
// hidden behaviour this repo treats as a bug. So the chip states the element
// BY NAME ("div.card > button.submit — İleri →"), expands to the literal facts
// being sent, and switching back to Browse DELETES what was already reported,
// so "off" means the agent is not holding your element rather than holding it
// and promising not to look.
//
// The page never talks to the agent: the probe posts to this window, and we
// forward over the authenticated agent client (the /dev/ preview route is
// unauthenticated by design). See web/lib/domInspect.ts for the trust note.

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentClient } from "@/lib/agent-client";
import {
  type DomElement,
  type DomItem,
  DOM_ITEMS_MESSAGE,
  MAX_DOM_ITEMS,
  domInspectDetail,
  domInspectModeCommand,
  domInspectSummary,
  domItemsCommand,
  parseDomInspectMessage,
  parseDomItemsMessage,
} from "@/lib/domInspect";

export function DomInspectChip({
  agentClient,
  workDir,
  iframeRef,
  className = "",
}: {
  agentClient: AgentClient | null;
  /** Project root the preview belongs to. The agent keys the element by it. */
  workDir?: string | null;
  /** The preview iframe the probe lives in. Required to post the mode commands. */
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
  className?: string;
}) {
  const [el, setEl] = useState<DomElement | null>(null);
  const [mode, setMode] = useState<"browse" | "inspect">("browse");
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<DomItem[] | null>(null);
  const [itemsOpen, setItemsOpen] = useState(false);

  const post = useCallback(
    (msg: unknown) => {
      // The iframe may not be mounted yet (or the ref may live in a parent
      // that renders the frame later) — a dropped enable command just means
      // the probe stays off until the next toggle, never a crash.
      try {
        const frame = iframeRef?.current;
        if (frame?.contentWindow) {
          frame.contentWindow.postMessage(msg, "*");
          return true;
        }
      } catch {
        /* cross-origin frame closed mid-toggle — ignore */
      }
      return false;
    },
    [iframeRef],
  );

  const forward = useCallback(
    (next: DomElement) => {
      if (!agentClient || !workDir) return;
      void agentClient.reportDomInspect({ ...next, workDir });
    },
    [agentClient, workDir],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMessage = (ev: MessageEvent) => {
      // No origin check, on purpose and safely: the preview frame is a
      // different origin by construction, so pinning an origin here would
      // reject the only sender we want. The defence is the validating parser
      // (unknown shapes return null, every string is clamped, `lane` is an
      // allowlist) plus the agent re-normalising on receipt.
      const parsed = parseDomInspectMessage(ev.data);
      if (parsed) {
        setEl(parsed);
        setMode("browse"); // the probe auto-offs after selection
        forward(parsed);
        return;
      }
      const itemsParsed = parseDomItemsMessage(ev.data);
      if (itemsParsed?.items?.length) {
        setItems(itemsParsed.items);
        setItemsOpen(true);
        if (agentClient && workDir) {
          void agentClient.reportDomItems({ workDir, items: itemsParsed.items });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [forward, agentClient, workDir]);

  // Switching projects must not carry the previous project's element along.
  useEffect(() => {
    setEl(null);
    setItems(null);
    setItemsOpen(false);
    setMode("browse");
  }, [workDir]);

  const selectMode = useCallback(
    (next: "browse" | "inspect") => {
      if (next === mode) return;
      setMode(next);
      if (next === "inspect") {
        post(domInspectModeCommand(true));
      } else {
        post(domInspectModeCommand(false));
        // Off means the agent is not holding the element. Same delete-semantics
        // as ScreenContextChip.
        setEl(null);
        if (agentClient && workDir) void agentClient.clearDomInspect(workDir);
      }
    },
    [mode, post, agentClient, workDir],
  );

  const requestItems = useCallback(() => {
    post(domItemsCommand(MAX_DOM_ITEMS));
    // Best-effort read-back of whatever the agent already holds for this
    // project — a picker backed by a stale inventory is better than none.
    if (agentClient && workDir) {
      void agentClient.domItems(workDir).then((got) => {
        if (got?.items?.length) setItems(got.items);
      });
    }
  }, [post, agentClient, workDir]);

  // Items picker selection: the probe's mode-select is click-driven, so a
  // programmatic postMessage cannot select an item. The honest behaviour is to
  // report the item's fields as the selected element (items are lightweight —
  // no shot/html/css, which only the hover capture has).
  const pickItem = useCallback(
    (item: DomItem) => {
      const asEl: DomElement = {
        selector: item.selector,
        tag: item.tag,
        id: item.id,
        classes: item.classes,
        text: item.text,
        rect: item.rect,
        lane: "browser",
      };
      setEl(asEl);
      setItemsOpen(false);
      setMode("browse");
      forward(asEl);
    },
    [forward],
  );

  const detail = expanded ? domInspectDetail(el) : [];

  return (
    <div className={`flex flex-col gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] leading-4 ${className}`}>
      {/* Browse | Inspect radio */}
      <div
        role="radiogroup"
        aria-label="Preview interaction mode"
        className="flex items-center gap-1"
        title={
          mode === "inspect"
            ? "Inspect is on — clicks in the preview select an element instead of reaching the app. Click an element or press Escape."
            : "Browse is on — clicks in the preview reach the app normally"
        }
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "browse"}
          onClick={() => selectMode("browse")}
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            mode === "browse" ? "bg-surface-700 text-surface-100" : "text-surface-400 hover:text-surface-200"
          }`}
        >
          Browse
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "inspect"}
          onClick={() => selectMode("inspect")}
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            mode === "inspect"
              ? "bg-indigo-500/80 text-white"
              : "text-surface-400 hover:text-surface-200"
          }`}
        >
          Inspect
        </button>
        {mode === "inspect" && <span className="ml-1 text-[10px] text-indigo-300">click an element in the preview · Esc cancels</span>}
      </div>

      {/* Attached element */}
      {el && (
        <div className="flex flex-col gap-1 rounded-md border border-indigo-500/25 bg-indigo-500/10 p-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title="Click to see exactly what is sent with your prompt"
              aria-expanded={expanded}
            >
              <span aria-hidden className="shrink-0 opacity-70">
                ⤷
              </span>
              <span className="truncate">
                <span className="opacity-70">element: </span>
                {domInspectSummary(el)}
              </span>
              <span aria-hidden className="shrink-0 opacity-50">
                {expanded ? "▾" : "▸"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => selectMode("browse")}
              className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider opacity-80 hover:opacity-100"
              title="Stop attaching this element and delete it from the agent"
            >
              off
            </button>
          </div>

          {expanded && (
            <div className="border-t border-current/15 pt-1">
              <div className="mb-0.5 opacity-70">Sent with your prompt, so the agent audits the right element:</div>
              <ul className="space-y-0.5 font-mono text-[10px] opacity-90">
                {detail.map((line) => (
                  <li key={line} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
              {el.shot && (
                <img
                  src={el.shot}
                  alt="Cropped preview of the selected element"
                  className="mt-1 max-h-24 rounded border border-current/15"
                />
              )}
              <div className="mt-1 opacity-60">
                Markup, styles and screenshot only — never what you type into a field. Stays on your machine; never synced.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Items picker */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (itemsOpen) {
              setItemsOpen(false);
            } else {
              setItemsOpen(true);
              requestItems();
            }
          }}
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-surface-400 hover:text-surface-200"
          title="List the preview's interactive elements and pick one to audit (handy where hovering is hard)"
        >
          Items ▾
        </button>
      </div>
      {itemsOpen && items && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-current/15 p-1 font-mono text-[10px]">
          {items.map((item) => (
            <li key={`${item.selector}\u0000${item.tag}`}>
              <button
                type="button"
                onClick={() => pickItem(item)}
                className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-surface-700/50"
                title={`${item.selector}${item.text ? ` — ${item.text}` : ""}`}
              >
                {item.selector || item.tag}
                {item.text ? ` — ${item.text}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
