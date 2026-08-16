// dom_inspect_probe.js — the in-page half of Yaver's DOM MODE (element
// inspect, Orca-Design-Mode style: click any element in the preview to send
// its HTML, CSS and a cropped screenshot into the agent).
//
// The agent injects this into every HTML document it serves for a preview
// (dom_inspect_inject.go), exactly like screen_context_probe.js. The web
// dashboard's iframe and the mobile WebView both load the agent-proxied
// document, so both get this same file.
//
// Unlike the screen probe — which is ALWAYS on and silently observes — this
// probe is OFF until the host surface explicitly asks for it. The surface
// posts { source:"yaver-dom", t:"yaver-dom-mode", enabled:true } into the
// frame; while enabled the probe draws a hover-highlight outline, and a click
// captures the clicked element (outerHTML + computed CSS + rect + a cropped
// canvas screenshot) and posts it back up. The mode then turns itself off
// until the surface asks again.
//
// Constraints this file must keep (same as screen_context_probe.js):
//   * ES5 only. It runs inside whatever the guest app's bundle targets, and a
//     syntax error here would break the PREVIEW, not just the probe.
//   * Never throw. Every entry point is wrapped; a probe that can break a
//     customer's app is worse than no probe.
//   * Never touch the network. It posts to its host surface, which forwards it
//     over the surface's own authenticated channel. An unauthenticated write
//     straight into the agent would let anyone on the LAN dictate text into
//     somebody else's AI prompt.
//   * NEVER read .value. The captured element may be a text input the user is
//     typing into; user-entered text must never leave the page.
(function () {
  if (window.__yaverDomProbe) return;
  window.__yaverDomProbe = true;

  var MAX_HTML = 24000;   // outerHTML cap (chars, approximate)
  var MAX_CSS = 16000;    // computed-style subset cap (chars)
  var MAX_TEXT = 400;     // visible text cap
  var MAX_SHOT = 16000;   // screenshot dataURL cap (chars, base64)
  var MAX_SELECTOR = 200; // css-path cap
  var SHOT_MAX_DIM = 240; // screenshot long-edge cap, px
  var SHOT_QUALITY = 0.72;

  var enabled = false;
  var overlay = null;

  // ── small helpers (all wrapped, all ES5) ─────────────────────────────

  function clamp(s, n) {
    try {
      if (!s) return "";
      s = String(s).replace(/\s+/g, " ").replace(/^ | $/g, "");
      if (s.length > n) s = s.slice(0, n - 1) + "…";
      return s;
    } catch (e) {
      return "";
    }
  }

  function elText(el) {
    try {
      var t = el.innerText || el.textContent || "";
      return t.replace(/\s+/g, " ").replace(/^ | $/g, "");
    } catch (e) {
      return "";
    }
  }

  function visible(el) {
    try {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || r.width < 1 || r.height < 1) return false;
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // A bounded css-path for locating the element in the source later. Stops at
  // 5 steps; each step is tag + #id + first class. The runner greps for it, so
  // brevity beats completeness — a 200-char path is not a path.
  function selectorPath(el) {
    try {
      var parts = [];
      var node = el;
      var guard = 0;
      while (node && node.nodeType === 1 && guard < 6) {
        var step = String(node.tagName || "").toLowerCase();
        if (!step) break;
        if (node.id) step += "#" + node.id;
        else if (node.className && typeof node.className === "string") {
          var first = node.className.split(/\s+/)[0];
          if (first) step += "." + first;
        }
        parts.unshift(step);
        if (node.id) break; // an id is a stable anchor; stop climbing
        node = node.parentNode;
        guard++;
      }
      return clamp(parts.join(" > "), MAX_SELECTOR);
    } catch (e) {
      return "";
    }
  }

  // The visual subset of the element's computed style. Full style dumps are
  // mostly inert default values; the runner wants the props that make this
  // element LOOK the way it does.
  var CSS_PROPS = ("display,position,float,top,right,bottom,left,zIndex,width,minWidth,maxWidth,height,minHeight,maxHeight," +
    "marginTop,marginRight,marginBottom,marginLeft,paddingTop,paddingRight,paddingBottom,paddingLeft," +
    "flex,flexDirection,flexWrap,alignItems,alignContent,justifyContent,gap,rowGap,columnGap,order,flexGrow,flexShrink," +
    "backgroundColor,backgroundImage,backgroundSize,backgroundPosition,backgroundRepeat,color,opacity," +
    "borderTopWidth,borderRightWidth,borderBottomWidth,borderLeftWidth,borderTopStyle,borderTopColor,borderRadius," +
    "boxShadow,outline,outlineOffset,fontFamily,fontSize,fontWeight,fontStyle,lineHeight,letterSpacing,textAlign," +
    "textDecoration,textTransform,whiteSpace,wordBreak,overflow,overflowX,overflowY,visibility,transform," +
    "transition,animation,boxSizing,cursor,pointerEvents,userSelect,aspectRatio,objectFit").split(",");

  function computedCss(el) {
    try {
      var cs = window.getComputedStyle(el);
      if (!cs) return "";
      var out = [];
      var len = 0;
      for (var i = 0; i < CSS_PROPS.length; i++) {
        try {
          var v = cs.getPropertyValue(CSS_PROPS[i]);
          if (v && v !== "auto" && v !== "none" && v !== "0px" && v !== "normal" && v !== "0") {
            var bit = CSS_PROPS[i] + ": " + v;
            len += bit.length + 2;
            if (len > MAX_CSS) break;
            out.push(bit);
          }
        } catch (e) {}
      }
      return clamp(out.join("; "), MAX_CSS);
    } catch (e) {
      return "";
    }
  }

  // ── cropped screenshot (best-effort, asynchronous) ────────────────────
  //
  // Renders the element into a canvas via an SVG foreignObject clone with
  // computed styles inlined, then calls cb with a JPEG dataURL. Any hiccup — a
  // cross-origin image tainting the canvas, a browser without foreignObject,
  // an async load — degrades to cb("") rather than failing the whole capture.
  // The HTML + CSS text is the payload; the screenshot is garnish.
  function captureShot(el, rect, cb) {
    var finished = false;
    function finish(data) {
      if (finished) return;
      finished = true;
      cb(data || "");
    }
    try {
      if (!window.document.createElementNS || !window.btoa || !window.XMLSerializer) return finish("");
      var w = Math.max(1, Math.round(rect.width));
      var h = Math.max(1, Math.round(rect.height));
      var scale = 1;
      if (w > SHOT_MAX_DIM || h > SHOT_MAX_DIM) scale = SHOT_MAX_DIM / Math.max(w, h);
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));

      var clone = el.cloneNode(true);
      var live = [el];
      var nodes = clone.getElementsByTagName("*");
      var all = [];
      for (var i = 0; i < nodes.length && i < 400; i++) all.push(nodes[i]);
      var guard = 0;
      while (live.length && guard < all.length) {
        var src = live.shift();
        var dst = all[guard];
        guard++;
        try {
          var cs = window.getComputedStyle(src);
          for (var p = 0; p < cs.length && p < 300; p++) {
            var prop = cs[p];
            var val = cs.getPropertyValue(prop);
            if (val) dst.style.setProperty(prop, val);
          }
          // Same-origin images become dataURLs so the canvas is not tainted.
          if (dst.tagName === "IMG" && dst.src && !/^data:/.test(dst.src)) {
            try {
              var imgCanvas = document.createElement("canvas");
              var img = new Image();
              img.crossOrigin = "anonymous";
              img.src = dst.src;
              if (img.naturalWidth > 0) {
                imgCanvas.width = img.naturalWidth;
                imgCanvas.height = img.naturalHeight;
                var g = imgCanvas.getContext("2d");
                if (g) {
                  g.drawImage(img, 0, 0);
                  dst.src = imgCanvas.toDataURL("image/png");
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      }

      var svgNS = "http://www.w3.org/2000/svg";
      var xhtmlNS = "http://www.w3.org/1999/xhtml";
      var wrap = document.createElementNS(xhtmlNS, "div");
      wrap.appendChild(clone);
      var xml = new XMLSerializer().serializeToString(wrap);
      var svg = '<svg xmlns="' + svgNS + '" width="' + cw + '" height="' + ch + '">' +
        '<foreignObject width="100%" height="100%">' + xml + "</foreignObject></svg>";

      var canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext("2d");
      if (!ctx) return finish("");

      var img2 = new Image();
      img2.onload = function () {
        try {
          ctx.clearRect(0, 0, cw, ch);
          ctx.drawImage(img2, 0, 0, cw, ch);
          var url = canvas.toDataURL("image/jpeg", SHOT_QUALITY);
          finish(url.length > MAX_SHOT ? "" : url);
        } catch (e) {
          finish("");
        }
      };
      img2.onerror = function () { finish(""); };
      img2.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch (e) {
      finish("");
    }
  }

  // ── overlay + hit-testing ─────────────────────────────────────────────

  function overlayEl() {
    try {
      if (overlay) return overlay;
      overlay = document.createElement("div");
      overlay.setAttribute("data-yaver-dom-overlay", "1");
      overlay.style.cssText =
        "position:fixed;display:none;pointer-events:none;z-index:2147483647;" +
        "box-sizing:border-box;border:2px solid #7c5cff;background:rgba(124,92,255,0.12);" +
        "box-shadow:0 0 0 9999px rgba(0,0,0,0.25);";
      document.documentElement.appendChild(overlay);
      return overlay;
    } catch (e) {
      return null;
    }
  }

  function showOverlay(el) {
    try {
      var o = overlayEl();
      if (!o) return;
      var r = el.getBoundingClientRect();
      o.style.display = "block";
      o.style.left = r.left + "px";
      o.style.top = r.top + "px";
      o.style.width = r.width + "px";
      o.style.height = r.height + "px";
    } catch (e) {}
  }

  function hideOverlay() {
    try {
      if (overlay) overlay.style.display = "none";
    } catch (e) {}
  }

  function pickTarget(t) {
    try {
      while (t && t.nodeType === 1) {
        if (t.getAttribute && t.getAttribute("data-yaver-dom-overlay") === "1") return null;
        if (t === document.documentElement || t === document.body) return null;
        t = t.parentNode;
      }
    } catch (e) {}
    return null;
  }

  // ── capture + post ────────────────────────────────────────────────────

  function capture(el) {
    try {
      var rect = el.getBoundingClientRect();
      var elData = {
        selector: selectorPath(el),
        tag: String(el.tagName || "").toLowerCase(),
        id: clamp(el.id || "", 120),
        classes: clamp(typeof el.className === "string" ? el.className : "", 240),
        text: clamp(elText(el), MAX_TEXT),
        html: clamp(el.outerHTML || "", MAX_HTML),
        css: computedCss(el),
        rect: "x:" + Math.round(rect.x || rect.left) + " y:" + Math.round(rect.y || rect.top) +
          " w:" + Math.round(rect.width) + " h:" + Math.round(rect.height),
        shot: "",
        lane: window.ReactNativeWebView ? "webview" : "browser"
      };
      var posted = false;
      function post(shot) {
        if (posted) return;
        posted = true;
        elData.shot = shot || "";
        sendUp({ source: "yaver-dom", t: "yaver-dom-element", v: 1, el: elData });
      }
      // The shot must never stall the capture: if it has not resolved in 600ms
      // we post without it. The payload without a screenshot is still complete.
      captureShot(el, rect, post);
      setTimeout(function () { post(""); }, 600);
    } catch (e) {}
  }

  // sendUp delivers one message to every host that could be listening:
  //   * window.parent — the embedding surface (web dashboard iframe).
  //   * ReactNativeWebView — the mobile WebView.
  //   * THIS window — Electron <webview> guests run top-level
  //     (window.parent === window), so the parent-branch above never fires;
  //     the desktop app's webview preload listens on this window and relays
  //     the message to the host. The probe's own command listener ignores
  //     non-command messages, so the self-post is inert on every other lane.
  function sendUp(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, "*");
      } else {
        window.postMessage(msg, "*");
      }
    } catch (e) {}
  }

  // ── interactive-items inventory (on demand) ───────────────────────────
  //
  // The surface may ask for a bounded list of visible interactive elements
  // ({ source:"yaver-dom", t:"yaver-dom-items", max: n }) instead of (or before)
  // hovering. The probe answers with the list so the surface can render a
  // picker — and forwards it to the agent, which holds it keyed by workDir so
  // ANY client surface (phone included, where hovering is hard) can fetch the
  // same inventory. Never input VALUES, same rule as everything else here.
  function collectItems(maxItems) {
    var out = [];
    try {
      var sel =
        'button,a[href],summary,select,[role="button"],[role="tab"],[role="link"],' +
        '[role="menuitem"],[role="switch"],[role="checkbox"],[role="radio"],input,textarea';
      var nodes = document.querySelectorAll(sel);
      var cands = [];
      for (var i = 0; i < nodes.length && i < 400; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var ty = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
        if (ty === "hidden" || ty === "submit") continue;
        var r = el.getBoundingClientRect();
        var label = clamp(elText(el), 120) || clamp(el.getAttribute("aria-label") || "", 120) ||
          clamp(el.getAttribute("placeholder") || "", 120) || "";
        cands.push({
          el: el,
          selector: selectorPath(el),
          tag: String(el.tagName || "").toLowerCase(),
          id: clamp(el.id || "", 120),
          classes: clamp(typeof el.className === "string" ? el.className : "", 240),
          text: label,
          rect: "x:" + Math.round(r.x || r.left) + " y:" + Math.round(r.y || r.top) +
            " w:" + Math.round(r.width) + " h:" + Math.round(r.height)
        });
      }
      // Innermost wins (a button inside a [role=button] wrapper is the real
      // control): drop any candidate that CONTAINS another candidate. Then
      // dedupe by selector so a repeated button in a list appears once.
      var seen = {};
      for (var a = 0; a < cands.length && out.length < maxItems; a++) {
        var swallows = false;
        for (var b = 0; b < cands.length; b++) {
          if (a === b) continue;
          if (cands[a].el.contains && cands[a].el.contains(cands[b].el)) {
            swallows = true;
            break;
          }
        }
        if (swallows) continue;
        var key = cands[a].selector;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({
          selector: cands[a].selector,
          tag: cands[a].tag,
          id: cands[a].id,
          classes: cands[a].classes,
          text: cands[a].text,
          rect: cands[a].rect
        });
      }
    } catch (e) {}
    return out;
  }

  function select(el) {
    try {
      hideOverlay();
      capture(el);
      setMode(false);
    } catch (e) {}
  }

  function onMouseOver(ev) {
    if (!enabled) return;
    try {
      var t = pickTarget(ev.target);
      if (!t || !visible(t)) {
        hideOverlay();
        return;
      }
      showOverlay(t);
    } catch (e) {}
  }

  function onClick(ev) {
    if (!enabled) return;
    try {
      var t = pickTarget(ev.target);
      if (!t) return;
      ev.preventDefault();
      ev.stopPropagation();
      select(t);
    } catch (e) {}
  }

  function onKey(ev) {
    if (!enabled) return;
    try {
      if (ev.keyCode === 27) setMode(false); // Escape cancels
    } catch (e) {}
  }

  function setMode(on) {
    try {
      if (on === enabled) return;
      enabled = on;
      if (on) {
        overlayEl();
        document.addEventListener("mouseover", onMouseOver, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKey, true);
        document.documentElement.style.cursor = "crosshair";
      } else {
        document.removeEventListener("mouseover", onMouseOver, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        hideOverlay();
        document.documentElement.style.cursor = "";
      }
    } catch (e) {}
  }

  function onCommand(ev) {
    try {
      var data = ev.data;
      if (!data || typeof data !== "object") return;
      if (data.source !== "yaver-dom") return;
      if (data.t === "yaver-dom-mode") {
        setMode(data.enabled === true);
      } else if (data.t === "yaver-dom-items") {
        var max = typeof data.max === "number" ? Math.min(Math.max(Math.round(data.max), 1), 40) : 25;
        sendUp({ source: "yaver-dom", t: "yaver-dom-items-list", v: 1, items: collectItems(max) });
      }
    } catch (e) {}
  }

  try {
    window.addEventListener("message", onCommand, false);
  } catch (e) {}
})();
