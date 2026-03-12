import { getConvexSiteUrl } from "./auth";

const CONVEX_SITE_URL = getConvexSiteUrl();

export interface SubscriptionStatus {
  plan: string;
  status: "active" | "trialing" | "past_due" | "cancelled" | "expired" | "none";
  renewalDate?: string;
  customerPortalUrl?: string;
  variantId?: string;
}

/**
 * Fetch the current user's subscription status from the Convex backend.
 */
export async function getSubscriptionStatus(
  token: string
): Promise<SubscriptionStatus> {
  try {
    const response = await fetch(`${CONVEX_SITE_URL}/subscriptions/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      // If endpoint doesn't exist yet or user has no subscription, return early access
      return {
        plan: "Early Access",
        status: "active",
      };
    }

    const data = await response.json();
    return data as SubscriptionStatus;
  } catch {
    // Network error or endpoint not available — default to early access
    return {
      plan: "Early Access",
      status: "active",
    };
  }
}

/**
 * Create a checkout session for a given subscription variant.
 * Returns a checkout URL to open in the browser.
 */
export async function createCheckout(
  token: string,
  variantId: string
): Promise<string | null> {
  try {
    const response = await fetch(`${CONVEX_SITE_URL}/subscriptions/checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ variantId }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data.checkoutUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the LemonSqueezy customer portal URL for managing subscriptions.
 * Returns a portal URL to open in the browser.
 */
export async function getCustomerPortal(
  token: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${CONVEX_SITE_URL}/subscriptions/customer-portal`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) return null;

    const data = await response.json();
    return data.portalUrl ?? null;
  } catch {
    return null;
  }
}
