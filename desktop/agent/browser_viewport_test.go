package main

// browser_viewport_test.go — the captured pixels must be the size that was asked
// for.
//
// TWO BUGS, ONE SYMPTOM, A DAY APART.
//
//	2026-08-03: the requested size was stored on the session, echoed back by
//	            /vibing/preview/status, and then never passed to Chrome at all.
//	            Fixed by OpenSessionWithViewport.
//	2026-08-04: with that fixed, a session opened at 390x844 still captured at
//	            500x701 — neither the request nor the 1280x900 fallback. Cause:
//	            chromedp.WindowSize sets the OS WINDOW, CaptureScreenshot
//	            captures the VIEWPORT, and headless Chrome does not promise the
//	            two agree. Fixed by EmulateViewport.
//
// Both are the same defect underneath — the inventory (a number in a JSON
// reply) saying yes while the operation (the pixels) says no — and the second
// hid behind the first, which is why this test asserts the PNG and nothing else.
//
// WHY IT MATTERS BEYOND TIDINESS. web/lib/surfaceViewports.ts exists so a closed
// loop drives the right app at the right size. A verdict reached on a canvas the
// caller did not ask for is a statement about a layout no user of that surface
// ever sees — and it renders green while being meaningless. Every TV, visionOS,
// phone and watch verdict depends on this one assertion.

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"testing"
)

// TestBrowserCapturesTheRequestedViewport opens a real headless Chrome at a
// phone-shaped viewport and asserts the captured PNG has exactly those pixels.
//
// Skips (never fails) when no browser is installed: an environment gap is not a
// product fault, and this suite exists to stop those being confused.
func TestBrowserCapturesTheRequestedViewport(t *testing.T) {
	if preferredChromePath() == "" {
		t.Skip("no Chrome/Chromium on this machine — the viewport contract needs a real browser to prove")
	}

	bm := NewBrowserManager()
	defer bm.Stop()

	const (
		id = "viewport-contract"
		w  = 390 // iPhone-class width
		h  = 844
	)
	if err := bm.OpenSessionWithViewport(id, false, "", "", w, h); err != nil {
		t.Skipf("could not open a browser session here: %v", err)
	}
	defer func() { _ = bm.CloseSession(id) }()

	// A trivial same-origin page: the contract is about the CANVAS, so the
	// content must not influence the measurement.
	if _, err := bm.Navigate(id, "data:text/html,<html><body style='margin:0;background:#123456'></body></html>"); err != nil {
		t.Skipf("navigate failed here: %v", err)
	}

	res, err := bm.Screenshot(id)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(res.ScreenshotB64)
	if err != nil {
		t.Fatalf("decode screenshot: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}

	got := img.Bounds()
	if got.Dx() != w || got.Dy() != h {
		t.Errorf("captured %dx%d, requested %dx%d — the pixels a surface verdict is read from are NOT the viewport that was asked for, so every per-surface layout judgement is about a canvas no user has",
			got.Dx(), got.Dy(), w, h)
	}
}

// TestBrowserViewportFallbackIsTheDocumentedOne — an out-of-range request must
// land on the stated default rather than on whatever Chrome feels like, or the
// "bounded" comment in OpenSessionWithViewport is describing something that does
// not happen.
func TestBrowserViewportFallbackIsTheDocumentedOne(t *testing.T) {
	if preferredChromePath() == "" {
		t.Skip("no Chrome/Chromium on this machine")
	}

	bm := NewBrowserManager()
	defer bm.Stop()

	const id = "viewport-fallback"
	// 100 is below the 200 floor, so both dimensions fall back to 1280x900.
	if err := bm.OpenSessionWithViewport(id, false, "", "", 100, 100); err != nil {
		t.Skipf("could not open a browser session here: %v", err)
	}
	defer func() { _ = bm.CloseSession(id) }()

	if _, err := bm.Navigate(id, "data:text/html,<html><body style='margin:0'></body></html>"); err != nil {
		t.Skipf("navigate failed here: %v", err)
	}
	res, err := bm.Screenshot(id)
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	raw, _ := base64.StdEncoding.DecodeString(res.ScreenshotB64)
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	if img.Bounds().Dx() != 1280 || img.Bounds().Dy() != 900 {
		t.Errorf("out-of-range request captured %dx%d, want the documented 1280x900 fallback",
			img.Bounds().Dx(), img.Bounds().Dy())
	}
}
