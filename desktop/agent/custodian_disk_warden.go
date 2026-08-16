package main

// custodian_disk_warden.go — the disk guard finally gets a consumer.
//
// ops_diskguard.go has existed since 2026-07-16 with an allowlist, a threshold
// and three verbs — and NOTHING called it on a schedule. On 2026-07-27
// ubuntu-4gb-hel1-1 sat at 95% (3.7G free of 75G) with the guard's own target
// classes accounting for over a gigabyte: nine superseded agent versions under
// ~/.yaver/bin and hundreds of MB of stranded yaver-* scratch in /tmp. A
// reclaimer that only runs when an operator remembers the verb is a
// consumer-less signal — the exact defect class CLAUDE.md forbids shipping.
//
// This warden IS the consumer. It reuses the sweep semantics verbatim (below
// threshold: hold the FIFO cap on always-enforce classes; at/above threshold:
// run every allowlisted class) and narrates what it did through the custodian
// feed every surface can already see. It also re-runs the diag log age prune,
// which previously only happened once at process start.

import (
	"fmt"
	"time"
)

type diskHygieneWarden struct{}

func (diskHygieneWarden) Name() string { return "disk-hygiene" }

// Every: the fastest allowlisted leak observed (opencode's /tmp .so, ~2GB/day)
// accumulates ~500MB in 6h — small enough that the FIFO cap keeps a tight box
// out of trouble between sweeps, rare enough to cost nothing.
func (diskHygieneWarden) Every() time.Duration { return 6 * time.Hour }

func (diskHygieneWarden) Sweep(now time.Time) []CustodianFinding {
	// The rotated-generation age prune used to run only at first open; on a
	// long-lived agent that is "once per deploy", not "weekly".
	diag().pruneAged()

	fs, err := diskGuardStat("")
	if err != nil {
		return nil
	}
	enforceOnly := fs.UsedPercent < diskGuardDefaultThreshold
	clear := diskGuardRunClear("", nil, false, diskGuardDefaultMinAge, enforceOnly)

	var findings []CustodianFinding
	if clear.DeletedFiles > 0 {
		problem := fmt.Sprintf("allowlisted regenerable artifacts were accumulating with the disk at %d%%", fs.UsedPercent)
		if enforceOnly {
			problem = fmt.Sprintf("always-enforce artifact rings were over their FIFO cap (disk at %d%%)", fs.UsedPercent)
		}
		findings = append(findings, CustodianFinding{
			Warden: "disk-hygiene", Subject: fmt.Sprintf("disk %d%% used", fs.UsedPercent),
			Outcome: OutcomeFixed, At: now,
			Problem: problem,
			Action:  fmt.Sprintf("reclaimed %s across %d artifacts via the disk-guard allowlist", clear.FreedHuman, clear.DeletedFiles),
		})
	}

	// A disk the guard cannot save is a finding the user must SEE — the
	// alternative is npm/gradle/xcodebuild dying with nospc an hour later,
	// each wearing a different costume.
	if after, err := diskGuardStat(""); err == nil && after.UsedPercent >= 90 {
		findings = append(findings, CustodianFinding{
			Warden: "disk-hygiene", Subject: fmt.Sprintf("disk %d%% used", after.UsedPercent),
			Outcome: OutcomeNeedsHuman, At: now,
			Problem: fmt.Sprintf("the disk is %d%% full (%s free) and everything the allowlist can safely regenerate is already gone — builds, updates and dev servers will start failing with no-space errors that will not name this cause", after.UsedPercent, humanBytesDG(after.FreeBytes)),
			Remedy:  "run diskguard_scan for the safe classes, then find_large_files to choose what else goes — nothing outside the allowlist is ever deleted automatically",
		})
	}
	return findings
}
