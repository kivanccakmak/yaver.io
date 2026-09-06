package main

import (
	"fmt"
	"testing"
	"time"
)

func TestExposeRouteQuotaSupportsProjectShortcutsAndStaysBounded(t *testing.T) {
	routes := map[string]*exposeRoute{}
	for i := 0; i < maxExposeSubdomainsPerDevice; i++ {
		subdomain := fmt.Sprintf("project-%02d", i)
		if exposeRouteLimitReached(routes, "device-a", subdomain) {
			t.Fatalf("route %d was refused before the bounded catalog was full", i+1)
		}
		routes[subdomain] = &exposeRoute{deviceID: "device-a", port: 18080, createdAt: time.Now()}
	}
	if !exposeRouteLimitReached(routes, "device-a", "one-too-many") {
		t.Fatal("device route catalog exceeded its bounded quota")
	}
	if exposeRouteLimitReached(routes, "device-a", "project-00") {
		t.Fatal("idempotent re-registration should remain possible at the quota")
	}
	if exposeRouteLimitReached(routes, "device-b", "another-device-project") {
		t.Fatal("one tenant/device quota must not consume another device's allowance")
	}
}
