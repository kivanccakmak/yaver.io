export type LayoutClass = "phone" | "tablet-portrait" | "tablet-landscape";
export const TABLET_SHORT_EDGE = 600;

/**
 * Classify the active app WINDOW, not the hardware model.
 *
 * Width is deliberately not allowed to override orientation. A 12.9-inch iPad
 * is 1024pt wide in portrait; the former `width >= 900` shortcut therefore
 * rendered the landscape rail and split panes while the device was vertical.
 * Short-edge still decides phone vs tablet so a rotated phone never becomes a
 * tablet merely because its long edge is wide.
 */
export function classifyResponsiveLayout(width: number, height: number): {
  isLandscape: boolean;
  isTablet: boolean;
  layoutClass: LayoutClass;
} {
  const isLandscape = width > height;
  const isTablet = Math.min(width, height) >= TABLET_SHORT_EDGE;
  return {
    isLandscape,
    isTablet,
    layoutClass: !isTablet
      ? "phone"
      : isLandscape
        ? "tablet-landscape"
        : "tablet-portrait",
  };
}
