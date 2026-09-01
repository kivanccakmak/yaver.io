/**
 * Checkout paths are machine-local. The MacBook and an Ubuntu runner can both
 * be selected from one phone but cannot share an absolute filesystem path.
 */
const DOGFOOD_CHECKOUT_PREFIX = "@yaver/dogfood_checkout/v2";

export function dogfoodCheckoutPreferenceKey(deviceId: string): string {
  return `${DOGFOOD_CHECKOUT_PREFIX}/${encodeURIComponent(deviceId.trim())}`;
}
