package main

// tenant_isolation.go — operator-fleet per-tenant isolation primitives used by
// tenant_runtime.go and runner-auth id prefixing.
//
// These were relocated here from the removed shared-infra "beta" files. They
// are not a consumer-product account-sharing mechanism. The remaining consumer
// is the explicit operator-fleet tenant runtime, which confines jobs as
// unprivileged OS users. Kept minimal and dependency-free.

import (
	"os/exec"
	"strings"
)

// tenantPartitionRoot is the on-box base for tenant partitions. A tenant's
// workspace is tenantPartitionRoot/<userId>/.
const tenantPartitionRoot = "/srv/yaver/tenants"

// sanitizeTenantRef makes a git-ref- and filesystem-safe slug: lowercase,
// [a-z0-9-], other runs collapse to a single '-', trimmed. Empty → "anon".
func sanitizeTenantRef(s string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(s) {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if ok {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "anon"
	}
	return out
}

// tenantPartitionUser returns the unprivileged OS user name for a tenant
// partition ("yv-<≤12>").
func tenantPartitionUser(userID string) string {
	slug := sanitizeTenantRef(userID)
	if len(slug) > 12 {
		slug = slug[:12]
	}
	return "yv-" + slug
}

// tenantSysRunner shells out as root (box-only). Injectable for tests.
type tenantSysRunner interface {
	run(name string, args ...string) (string, error)
}

type execTenantSysRunner struct{}

func (execTenantSysRunner) run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return string(out), err
}
