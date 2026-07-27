package main

import (
	"strings"
	"testing"
)

func TestParseUserHostPort(t *testing.T) {
	cases := []struct {
		in         string
		user, host string
		port       int
	}{
		{"kivi@10.0.0.45", "kivi", "10.0.0.45", 0},
		{"kivi@10.0.0.45:2222", "kivi", "10.0.0.45", 2222},
		{"10.0.0.45", "", "10.0.0.45", 0},
		{"host:22", "", "host", 22},
		{"root@box", "root", "box", 0},
	}
	for _, c := range cases {
		u, h, p := parseUserHostPort(c.in)
		if u != c.user || h != c.host || p != c.port {
			t.Errorf("%q → (%q,%q,%d), want (%q,%q,%d)", c.in, u, h, p, c.user, c.host, c.port)
		}
	}
}

func TestLookupUpsertSSHTarget(t *testing.T) {
	cfg := &Config{}
	upsertSSHTarget(cfg, SSHTarget{Name: "magara", Host: "10.0.0.45", User: "kivi"})
	if t1 := lookupSSHTarget(cfg, "MAGARA"); t1 == nil || t1.User != "kivi" {
		t.Fatalf("case-insensitive lookup failed: %+v", t1)
	}
	// Upsert replaces, doesn't duplicate.
	upsertSSHTarget(cfg, SSHTarget{Name: "magara", Host: "10.0.0.99", User: "kivi"})
	if len(cfg.SSHTargets) != 1 {
		t.Fatalf("upsert duplicated: %d entries", len(cfg.SSHTargets))
	}
	if cfg.SSHTargets[0].Host != "10.0.0.99" {
		t.Fatalf("upsert didn't replace host: %q", cfg.SSHTargets[0].Host)
	}
}

func TestSSHArgsForBuildsIdentityPortUserHost(t *testing.T) {
	tg := &SSHTarget{Name: "magara", Host: "10.0.0.45", User: "kivi", Port: 2222, IdentityFile: "/k/id"}
	argv := sshArgsFor(tg, "/usr/bin/ssh", []string{"-L", "5432:localhost:5432"})
	got := strings.Join(argv, " ")
	for _, want := range []string{"/usr/bin/ssh", "-i /k/id", "-p 2222", "kivi@10.0.0.45", "-L 5432:localhost:5432"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv missing %q: %s", want, got)
		}
	}
	// user@host must come before the passthrough.
	if strings.Index(got, "kivi@10.0.0.45") > strings.Index(got, "-L") {
		t.Errorf("dest must precede passthrough: %s", got)
	}
}

func TestRememberSSHHostNoClobber(t *testing.T) {
	cfg := &Config{}
	upsertSSHTarget(cfg, SSHTarget{Name: "magara", Host: "10.0.0.45", User: "kivi"})
	rememberSSHHost(cfg, "magara", "10.0.0.99") // should NOT clobber existing host/user
	if cfg.SSHTargets[0].Host != "10.0.0.45" || cfg.SSHTargets[0].User != "kivi" {
		t.Fatalf("rememberSSHHost clobbered an existing entry: %+v", cfg.SSHTargets[0])
	}
	rememberSSHHost(cfg, "newbox", "1.2.3.4") // new entry, host only
	if lookupSSHTarget(cfg, "newbox") == nil {
		t.Fatalf("rememberSSHHost didn't add new entry")
	}
}

func TestSSHArgsWithSurvivabilityAcceptsNewHostKeys(t *testing.T) {
	args := strings.Join(sshArgsWithSurvivability("kivi@100.64.0.5", []string{"true"}), " ")
	if !strings.Contains(args, "StrictHostKeyChecking=accept-new") {
		t.Fatalf("watchdog ssh must learn first-contact host keys non-interactively, got %s", args)
	}
	// IdentitiesOnly is watchdog-scoped, NOT default: for an interactive
	// `yaver ssh` it would silently drop agent-held keys (1Password, hardware
	// tokens) that plain ssh offers — a user whose key exists only in an
	// agent would get Permission denied where ssh works.
	if strings.Contains(args, "IdentitiesOnly=yes") {
		t.Fatalf("interactive ssh must keep agent-held identities, got %s", args)
	}
	if strings.Contains(args, "StrictHostKeyChecking=no") || strings.Contains(args, "UserKnownHostsFile=/dev/null") {
		t.Fatalf("watchdog ssh must still refuse changed host keys, got %s", args)
	}

	// The unattended watchdog leg (attemptPeerRecovery sets this env) DOES
	// pin identities so a keyring full of agent keys can't trip MaxAuthTries.
	t.Setenv("YAVER_SSH_IDENTITIES_ONLY", "1")
	watchdogArgs := strings.Join(sshArgsWithSurvivability("kivi@100.64.0.5", []string{"true"}), " ")
	if !strings.Contains(watchdogArgs, "IdentitiesOnly=yes") {
		t.Fatalf("watchdog ssh must not fail after offering unrelated agent keys, got %s", watchdogArgs)
	}
}
