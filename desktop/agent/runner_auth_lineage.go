package main

// runner_auth_lineage.go — who is allowed to renew a rotating credential.
//
// THE PROBLEM IN ONE PARAGRAPH. A Codex refresh token rotates: every renewal consumes
// the old one and issues a new one. That makes the credential a LINEAGE, not a secret
// — and a lineage has exactly one valid holder at a time. Yaver's mirror/import
// feature copies auth.json verbatim between machines and calls itself "the preferred
// path", which creates a second holder. From that moment the two boxes are in a race
// neither can win: whoever renews first invalidates the other, which gets
// `invalid_grant` and reports itself signed out. Fix that one, and it kills the first.
// That is the "signed out AGAIN" oscillation from the 2026-08-02 audit, and under
// RFC 9700's reuse-detection guidance a replay can revoke the entire family — every
// machine at once.
//
// THE RULE. A machine may renew a Codex credential only if it OWNS the lineage —
// meaning the credential was established here, by this machine's own sign-in. A
// credential that arrived as a copy is a bootstrap: it works until it expires, and
// then it needs its own sign-in (or a fresh copy). It must never be renewed here,
// because renewing is the destructive act.
//
// This is deliberately conservative. The alternative — renew and hope the other box
// re-auths — trades a silent, confusing, cross-machine failure for a loud, local,
// fixable one. Loud and local wins: the box that needs attention is the box the user
// is looking at.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// codexLineageMarker records that this machine's credential is a COPY.
//
// Stored beside the credential rather than inside it: auth.json belongs to Codex, and
// a stray Yaver key in a file another program owns and rewrites is a schema fight we
// would lose. The marker carries NO token material — only a hash, so we can tell
// "still the copy we were given" from "this machine has since signed in for itself".
type codexLineageMarker struct {
	SourceHost string `json:"sourceHost"`
	SeededAt   string `json:"seededAt"`
	// TokenHash is sha256 of the refresh token AS SEEDED. Comparing it to the
	// current file answers the only question that matters: is this still somebody
	// else's lineage, or has this box established its own?
	TokenHash string `json:"tokenHash"`
}

func codexLineageMarkerPath(credentialPath string) string {
	return credentialPath + ".yaver-lineage.json"
}

// hashRefreshTokenForLineage hashes the refresh token inside a credential blob.
// Returns "" when there is nothing to hash. The hash is one-way and never leaves the
// box; it exists only to compare a credential against itself over time.
func hashRefreshTokenForLineage(data []byte) string {
	var probe map[string]any
	if err := json.Unmarshal(data, &probe); err != nil {
		return ""
	}
	tokens, _ := probe["tokens"].(map[string]any)
	if tokens == nil {
		return ""
	}
	rt, _ := tokens["refresh_token"].(string)
	rt = strings.TrimSpace(rt)
	if rt == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(rt))
	return hex.EncodeToString(sum[:])
}

// writeCodexLineageMarker records a mirrored credential's provenance.
func writeCodexLineageMarker(credentialPath, sourceHost string, data []byte) {
	marker := codexLineageMarker{
		SourceHost: strings.TrimSpace(sourceHost),
		SeededAt:   time.Now().UTC().Format(time.RFC3339),
		TokenHash:  hashRefreshTokenForLineage(data),
	}
	blob, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(codexLineageMarkerPath(credentialPath), append(blob, '\n'), 0o600); err != nil {
		log.Printf("[codex-lineage] could not record credential provenance: %v", err)
	}
}

// clearCodexLineageMarker is called when this machine establishes its OWN credential
// (a real sign-in here). From that point it owns the lineage and may renew.
func clearCodexLineageMarker(credentialPath string) {
	_ = os.Remove(codexLineageMarkerPath(credentialPath))
}

// codexCredentialIsForeignCopy reports whether the credential at credentialPath is
// still the copy some other machine gave us — i.e. whether renewing it here would
// consume a token that machine also holds.
//
// Answers false (safe to renew) when: there is no marker, the marker is unreadable,
// or the refresh token no longer matches the one that was seeded. That last case
// means this box has since signed in for itself, so the copy is history.
func codexCredentialIsForeignCopy(credentialPath string) (bool, string) {
	blob, err := os.ReadFile(codexLineageMarkerPath(credentialPath))
	if err != nil {
		return false, ""
	}
	var marker codexLineageMarker
	if err := json.Unmarshal(blob, &marker); err != nil {
		return false, ""
	}
	if strings.TrimSpace(marker.TokenHash) == "" {
		return false, ""
	}
	current, err := os.ReadFile(credentialPath)
	if err != nil {
		return false, ""
	}
	if hashRefreshTokenForLineage(current) != marker.TokenHash {
		// Diverged — this machine signed in for itself since the copy landed.
		clearCodexLineageMarker(credentialPath)
		return false, ""
	}
	src := marker.SourceHost
	if strings.TrimSpace(src) == "" {
		src = "another machine"
	}
	return true, "This machine's Codex credential is a copy taken from " + src +
		". Renewing it here would consume the refresh token that machine is still using and sign it out, so Yaver will not renew it automatically. " +
		"Sign in on this machine with `codex login --device-auth` to give it its own credential."
}

// guardCodexMirrorOverwrite implements conditional seeding: refuse to overwrite a
// healthy credential that belongs to a different lineage.
//
// Returns nil for every case where writing is safe or clearly intended:
//   - not codex (claude/opencode have their own semantics),
//   - no existing credential (this is a bootstrap — the whole point of mirroring),
//   - an existing credential that is expired or unreadable (nothing to protect),
//   - the same lineage (a genuine refresh of the same token family),
//   - force (the caller has said, explicitly, that they mean it).
func guardCodexMirrorOverwrite(runner, dest string, incoming []byte, force bool) error {
	if normalizeRunnerAuthName(runner) != "codex" || force {
		return nil
	}
	existing, err := readCodexCredentialDoc(dest)
	if err != nil {
		// Missing, empty or corrupt — nothing worth protecting. Seed away.
		return nil
	}
	fresh := codexCredentialFreshnessOf(existing, time.Now())
	if fresh.Known && fresh.Expired {
		return nil
	}
	if !fresh.HasRefreshToken {
		return nil
	}
	// Same lineage? Then this is a legitimate hand-off of the same family.
	existingRaw, rerr := os.ReadFile(dest)
	if rerr == nil && hashRefreshTokenForLineage(existingRaw) == hashRefreshTokenForLineage(incoming) {
		return nil
	}
	return fmt.Errorf(
		"refusing to overwrite this machine's working Codex credential (%s) with a copy from another machine. "+
			"Codex refresh tokens rotate, so two machines holding one credential invalidate each other — that is what makes it look like Codex 'signs out again' every few days. "+
			"If this box needs its own long-lived login, run `codex login --device-auth` here. "+
			"To overwrite anyway, resend with force=true",
		fresh.describe(time.Now()))
}
