#!/usr/bin/env bash
set -euo pipefail

# Yaver's native clients do not embed third-party payment SDKs. Payments for
# Yaver itself are handled outside the mobile/desktop binaries; the project
# wizard may still describe payment providers for apps the user is building.
# Check package manifests and resolved native graphs so an unused dependency
# cannot silently autolink into an App Store or Play Store artifact again.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scope="${1:-source}"

source_files=(
  "$ROOT/mobile/package.json"
  "$ROOT/mobile/package-lock.json"
  "$ROOT/mobile/sdk-manifest.json"
  "$ROOT/mobile/runtime-families/family-a/sdk-manifest.json"
  "$ROOT/electron/package.json"
)

for file in "${source_files[@]}"; do
  [ -f "$file" ] || continue
  if grep -Eiq '"(@stripe/stripe-react-native|stripe-ios|lemonsqueezy|lemon-squeezy|paddle-js|paddle-react-native|react-native-iap|react-native-purchases|react-native-purchases-ui)"[[:space:]]*:' "$file"; then
    echo "ERROR: native payment SDK dependency found in $file." >&2
    echo "Yaver native artifacts must not embed Stripe, Lemon Squeezy, Paddle, or another third-party payment SDK." >&2
    exit 1
  fi
done

case "$scope" in
  source) ;;
  ios)
    if [ -f "$ROOT/mobile/ios/Podfile.lock" ] && grep -Eiq '^  - (Stripe|StripeApplePay|StripeCore|StripePayments|StripePaymentsUI|StripeUICore|RNIap|RNPurchases|RevenueCat|PurchasesHybridCommon)([ (]|$)' "$ROOT/mobile/ios/Podfile.lock"; then
      echo "ERROR: a payment SDK remains in mobile/ios/Podfile.lock; regenerate Pods before releasing." >&2
      exit 1
    fi
    ;;
  android)
    report="${2:-}"
    if [ -z "$report" ] || [ ! -f "$report" ]; then
      echo "ERROR: Android payment-SDK verification requires a Gradle dependency report path." >&2
      exit 1
    fi
    if grep -Eiq '(^|[[:space:]:/])(stripe|lemonsqueezy|lemon-squeezy|paddle|revenuecat|react-native-purchases|react-native-iap|billingclient)([[:space:]:/.-]|$)' "$report"; then
      echo "ERROR: third-party payment SDK found in the Android release dependency graph." >&2
      exit 1
    fi
    ;;
  *)
    echo "ERROR: unknown native payment SDK check scope: $scope" >&2
    exit 2
    ;;
esac

echo "Native payment SDK guard passed ($scope)."
