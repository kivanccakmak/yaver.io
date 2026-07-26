package main

import (
	"testing"
	"time"
)

// The owner-dev plan is exempt from bandwidth caps entirely. The entitlement
// is CONVEX-DRIVEN and tamper-proof by construction: it derives from the
// owner allowlist (Convex env vars, settable only via the dashboard/CLI —
// no public mutation writes it) and the subscriptions table, and reaches the
// relay only inside an authenticated /relay/validate or /relay/resolve-sig
// verdict. Nothing client-sent can flip it: a hostile client can claim any
// header it likes, but the relay only honors what Convex said about the
// AUTHENTICATED identity.

// An unmetered device must never be blocked, no matter how far past the free
// or paid ceiling it is.
func TestUnmeteredDeviceNeverCapped(t *testing.T) {
	bm := newTestBandwidthManager()
	bm.SetDeviceTier("owner-box", false, true)
	// 100 GB — far beyond free (500MB) and paid (20GB) allowances.
	bm.RecordBytes("owner-box", 0, 100*1024*1024*1024, false)

	if err := bm.CheckAllowed("owner-box", 50*1024*1024); err != nil {
		t.Fatalf("unmetered device was capped: %v", err)
	}
}

// The streaming budget must read "unmetered" (0) for an unmetered device —
// RemainingBytes' 0 already means exactly that (see remaining_bytes_test.go).
func TestUnmeteredRemainingBytesIsUnmetered(t *testing.T) {
	bm := newTestBandwidthManager()
	bm.SetDeviceTier("owner-box", false, true)
	bm.RecordBytes("owner-box", 0, 100*1024*1024*1024, false)

	if got := bm.RemainingBytes("owner-box"); got != 0 {
		t.Fatalf("RemainingBytes = %d, want 0 (unmetered)", got)
	}
}

// RecordBytes runs on every response and must not silently strip the
// unmetered flag a SetDeviceTier granted — otherwise the exemption lasts
// exactly one request.
func TestRecordBytesPreservesUnmetered(t *testing.T) {
	bm := newTestBandwidthManager()
	bm.SetDeviceTier("owner-box", false, true)
	bm.RecordBytes("owner-box", 1024, 1024, false)

	if err := bm.CheckAllowed("owner-box", 100*1024*1024*1024); err != nil {
		t.Fatalf("RecordBytes cleared the unmetered flag: %v", err)
	}
}

// SetDevicePaid is the legacy call — it must keep meaning "paid, metered" so
// existing call sites and tests keep their semantics.
func TestSetDevicePaidStaysMetered(t *testing.T) {
	bm := newTestBandwidthManager()
	bm.SetDevicePaid("paid-box", true)
	over := int64(bm.config.PaidDeviceLimitMB)*1024*1024*int64(bm.config.RelaxMultiplier) + 1
	bm.RecordBytes("paid-box", 0, over, true)

	if err := bm.CheckAllowed("paid-box", 1); err == nil {
		t.Fatal("a paid (not unmetered) device over its allowance must still be capped")
	}
}

// Only the owner-dev plan is exempt. Free and the PAID tiers stay metered —
// Relay Pro buys a bigger allowance, not the absence of one.
func TestPlanBandwidthExemption(t *testing.T) {
	cases := map[string]bool{
		"owner-dev":       true,
		"free":            false,
		"":                false,
		"relay-pro":       false,
		"cloud-workspace": false,
	}
	for plan, want := range cases {
		if got := planBandwidthExempt(plan); got != want {
			t.Errorf("planBandwidthExempt(%q) = %v, want %v", plan, got, want)
		}
	}
}

// The password path caches (isPaid, plan) per access key; the entitlement
// accessor must surface BOTH so the proxy handler can grant the exemption
// without a second Convex round-trip.
func TestRelayAccessEntitlementReadsPlanFromCache(t *testing.T) {
	s := &RelayServer{
		validatedPw:         map[string]time.Time{},
		validatedAccessMeta: map[string]validatedAccessMeta{},
	}
	key := relayAccessCacheKey("proxy", "dev-1", "pw-1", "")
	s.validatedAccessMeta[key] = validatedAccessMeta{
		UserID: "user-1",
		IsPaid: true,
		Plan:   "owner-dev",
		Expiry: time.Now().Add(time.Minute),
	}

	isPaid, plan := s.relayAccessEntitlement("proxy", "dev-1", "pw-1", "")
	if !isPaid || plan != "owner-dev" {
		t.Fatalf("relayAccessEntitlement = (%v, %q), want (true, owner-dev)", isPaid, plan)
	}

	// Expired entry must read as unentitled — fail closed.
	s.validatedAccessMeta[key] = validatedAccessMeta{
		UserID: "user-1", IsPaid: true, Plan: "owner-dev",
		Expiry: time.Now().Add(-time.Minute),
	}
	isPaid, plan = s.relayAccessEntitlement("proxy", "dev-1", "pw-1", "")
	if isPaid || plan != "" {
		t.Fatalf("expired entitlement = (%v, %q), want (false, \"\")", isPaid, plan)
	}
}
