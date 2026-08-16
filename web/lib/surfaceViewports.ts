/**
 * surfaceViewports — the viewport/device profile each Yaver surface must be
 * driven at in a closed-loop test.
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 *
 * A closed loop that drives the RIGHT app at the WRONG size tests a layout no
 * user ever sees, and reports green about it. That is not hypothetical: the
 * first mobile arc in this suite simply narrowed a desktop Chrome window and
 * called itself "mobile RN-web".
 *
 * Narrowing is not emulation. RN-web branches on touch capability, device
 * pixel ratio and user agent — not just width — so a 390px-wide desktop Chrome
 * renders a DIFFERENT component tree than a phone does. Tablet vs phone splits
 * again inside the app (`isTablet`, `isTabletLandscape` gate real layout
 * decisions in login.tsx), and TV/watch are different apps entirely.
 *
 * So the surface→profile mapping lives here, once, unit-tested, instead of
 * being a magic number pasted into each spec.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A loop states which SURFACE it drives. The surface decides the profile. A
 * spec that hard-codes a width is stating a fact it has no authority over.
 */

export type YaverSurface =
  | "web"
  | "mobile"
  | "tablet"
  | "tv"
  | "vision"
  | "watch";

export interface SurfaceProfile {
  /** Playwright device descriptor name, when one fits. Null = custom only. */
  playwrightDevice: string | null;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** Why this profile — so a reader can check it rather than trust it. */
  why: string;
}

/**
 * The profiles.
 *
 * Phone/tablet use real device geometry rather than round numbers: the app's
 * own breakpoints were written against these, and a 400x800 "close enough"
 * viewport can land on the wrong side of one.
 */
export const SURFACE_PROFILES: Record<YaverSurface, SurfaceProfile> = {
  web: {
    playwrightDevice: "Desktop Chrome",
    width: 1600, height: 1100, deviceScaleFactor: 1,
    isMobile: false, hasTouch: false,
    why: "The dashboard's three-pane Vibing layout needs real width; below ~1280 the preview and chat stack and the loop drives a different UI.",
  },
  mobile: {
    playwrightDevice: "iPhone 15",
    // 659, not 852. Playwright's iPhone descriptors carry the VISIBLE viewport
    // (Safari's chrome excluded), not the physical screen height — and the
    // visible viewport is what window.innerHeight reports and what the app
    // actually lays out against. 852 was a plausible-looking guess taken from
    // the device spec sheet; the descriptor is the source of truth, and the
    // guard caught the difference on its first real run.
    width: 393, height: 659, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    why: "RN-web branches on touch + DPR + UA, not width alone. A narrowed desktop Chrome renders a tree no phone user ever sees.",
  },
  tablet: {
    playwrightDevice: "iPad (gen 7)",
    width: 810, height: 1080, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
    why: "login.tsx gates real layout on isTablet / isTabletPortrait; a phone profile silently skips that whole branch.",
  },
  tv: {
    playwrightDevice: null,
    width: 1920, height: 1080, deviceScaleFactor: 1,
    isMobile: false, hasTouch: false,
    why: "tvOS is a separate native app; 1080p is the surface it is designed against and it is focus-driven, never touch.",
  },
  vision: {
    playwrightDevice: null,
    // visionOS opens an app window at 1280x720 points by default (Safari and
    // SwiftUI windows alike). The headset renders it at a much higher physical
    // resolution, but layout happens in points, so 1280x720 is the geometry the
    // app is laid out against and therefore the one to capture at.
    width: 1280, height: 720, deviceScaleFactor: 2,
    // Deliberately false, and it is not an oversight: visionOS input is gaze +
    // indirect pinch, delivered as POINTER events, not touch. A profile that
    // claims touch would push RN-web down the phone branch — the same
    // "narrowed desktop = mobile" mistake this module exists to prevent, just
    // pointed the other way.
    isMobile: false, hasTouch: false,
    why: "AR/VR (visionOS) windows lay out at 1280x720 points and are pointer-driven, not touch. Its verdict comes from a captured FRAME, not a DOM — see e2e/native-headless-vibe.mjs.",
  },
  watch: {
    playwrightDevice: null,
    width: 396, height: 484, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
    why: "Apple Watch Ultra logical size. Narrow AND short — a phone profile hides the vertical crowding that is the watch's main failure mode.",
  },
};

export function profileFor(surface: YaverSurface): SurfaceProfile {
  return SURFACE_PROFILES[surface];
}

/**
 * Does an observed viewport actually match the surface it claims?
 *
 * The guard against "narrowed desktop = mobile". Width alone is not enough:
 * touch and mobile flags are what the RN app branches on, so they are checked
 * too. Tolerance is for browser chrome, not for a different device class.
 */
export function viewportMatchesSurface(
  surface: YaverSurface,
  observed: { width: number; height: number; isMobile?: boolean; hasTouch?: boolean },
  tolerancePx = 40,
): { ok: boolean; reason: string } {
  const p = profileFor(surface);
  if (Math.abs(observed.width - p.width) > tolerancePx) {
    return { ok: false, reason: `width ${observed.width} is not ${surface} (${p.width}±${tolerancePx})` };
  }
  if (Math.abs(observed.height - p.height) > tolerancePx) {
    return { ok: false, reason: `height ${observed.height} is not ${surface} (${p.height}±${tolerancePx})` };
  }
  if (p.isMobile && observed.isMobile === false) {
    return { ok: false, reason: `${surface} requires mobile emulation — a narrowed desktop browser is not a phone` };
  }
  if (p.hasTouch && observed.hasTouch === false) {
    return { ok: false, reason: `${surface} requires touch; RN-web renders a different tree without it` };
  }
  return { ok: true, reason: `${surface} profile matched` };
}
