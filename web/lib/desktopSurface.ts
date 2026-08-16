export type DesktopSurfaceInfo = {
  isDesktop: boolean;
  localDeviceId: string | null;
};

export const WEB_SURFACE_INFO: DesktopSurfaceInfo = Object.freeze({
  isDesktop: false,
  localDeviceId: null,
});

export function isThisDesktopDevice(
  deviceId: string | null | undefined,
  surface: DesktopSurfaceInfo,
): boolean {
  return Boolean(surface.isDesktop && surface.localDeviceId && deviceId === surface.localDeviceId);
}

export function desktopDeviceLabel(
  device: { id: string; name?: string | null; platform?: string | null },
  surface: DesktopSurfaceInfo,
): string {
  const name = device.name || device.id.slice(0, 8);
  const platform = device.platform ? ` · ${device.platform}` : "";
  return isThisDesktopDevice(device.id, surface) ? `This PC — ${name}${platform}` : `${name}${platform}`;
}
