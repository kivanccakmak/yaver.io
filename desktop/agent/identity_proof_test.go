package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"crypto/rand"

	"golang.org/x/crypto/nacl/box"
)

// The property under test is the one the LAN beacon cannot provide: proof that
// the host at an advertised address is the machine Convex says it is, obtained
// WITHOUT ever showing it a credential.

func postProve(t *testing.T, srv *HTTPServer, sealed, senderPub string) (int, identityProveResponse) {
	t.Helper()
	body, _ := json.Marshal(identityProveRequest{Sealed: sealed, SenderPublicKey: senderPub})
	r := httptest.NewRequest(http.MethodPost, "/identity/prove", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv.handleIdentityProve(rec, r)
	var out identityProveResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// The genuine machine holds the private key, so it can open the challenge and
// echo the nonce. This is the only case that may succeed.
func TestIdentityProve_RealDeviceEchoesTheNonce(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // isolate ~/.yaver so we do not touch the real key
	dk, err := LoadOrGenerateKeys()
	if err != nil {
		t.Fatalf("device keys: %v", err)
	}

	sealed, senderPub, nonce, err := sealIdentityChallenge(dk.PublicKey)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	code, out := postProve(t, &HTTPServer{}, sealed, senderPub)
	if code != http.StatusOK {
		t.Fatalf("real device failed its own challenge: HTTP %d (%s)", code, out.Error)
	}
	if !identityProofMatches(nonce, out.Nonce) {
		t.Fatal("device returned a nonce that does not match the challenge")
	}
	if out.PublicKey != dk.PublicKeyBase64() {
		t.Fatal("device echoed the wrong public key — a client cross-checking Convex would reject it")
	}
}

// THE ATTACK. An impostor on the LAN broadcasts a beacon for someone else's
// deviceId. It knows the public key (it is public) but not the private half, so
// it cannot open a challenge sealed to that key. Modelled by sealing to a
// DIFFERENT keypair than the one the responding host holds.
func TestIdentityProve_ImpostorCannotAnswer(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := LoadOrGenerateKeys(); err != nil {
		t.Fatalf("device keys: %v", err)
	}

	victimPub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("victim keys: %v", err)
	}
	// Client seals to the VICTIM's public key (what Convex records) but sends it
	// to the impostor host, which holds a different private key.
	sealed, senderPub, _, err := sealIdentityChallenge(*victimPub)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	code, out := postProve(t, &HTTPServer{}, sealed, senderPub)
	if code == http.StatusOK {
		t.Fatal("an impostor passed the identity challenge — " +
			"a spoofed LAN host would receive the user's session")
	}
	if out.Nonce != "" {
		t.Fatal("a failed challenge leaked a nonce")
	}
}

// Malformed input must be refused with one generic message: a prober must not
// learn WHICH part it got wrong.
func TestIdentityProve_MalformedInputIsRefusedUniformly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := LoadOrGenerateKeys(); err != nil {
		t.Fatalf("device keys: %v", err)
	}
	valid := base64.StdEncoding.EncodeToString(make([]byte, 32))
	for _, tc := range []struct{ name, sealed, sender string }{
		{"empty", "", ""},
		{"sealed not base64", "!!!!", valid},
		{"sealed too short", base64.StdEncoding.EncodeToString([]byte("short")), valid},
		{"sender wrong length", base64.StdEncoding.EncodeToString(make([]byte, 64)), base64.StdEncoding.EncodeToString(make([]byte, 8))},
		{"garbage box", base64.StdEncoding.EncodeToString(make([]byte, 64)), valid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out := postProve(t, &HTTPServer{}, tc.sealed, tc.sender)
			if code == http.StatusOK {
				t.Fatalf("malformed input (%s) was accepted", tc.name)
			}
			if out.Nonce != "" {
				t.Fatalf("malformed input (%s) leaked a nonce", tc.name)
			}
		})
	}
}

// A fresh nonce per attempt is what makes a captured exchange useless.
func TestSealIdentityChallenge_NonceIsFreshEveryTime(t *testing.T) {
	pub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i := 0; i < 16; i++ {
		_, _, nonce, err := sealIdentityChallenge(*pub)
		if err != nil {
			t.Fatal(err)
		}
		if len(nonce) != 32 {
			t.Fatalf("nonce is %d bytes, want 32", len(nonce))
		}
		k := base64.StdEncoding.EncodeToString(nonce)
		if seen[k] {
			t.Fatal("nonce repeated — a captured proof could be replayed")
		}
		seen[k] = true
	}
}

func TestIdentityProofMatches_RejectsWrongAndMalformed(t *testing.T) {
	expected := []byte("0123456789abcdef0123456789abcdef")
	if !identityProofMatches(expected, base64.StdEncoding.EncodeToString(expected)) {
		t.Fatal("correct nonce was rejected")
	}
	if identityProofMatches(expected, base64.StdEncoding.EncodeToString([]byte("wrong"))) {
		t.Fatal("wrong nonce accepted")
	}
	if identityProofMatches(expected, "!!not base64!!") {
		t.Fatal("malformed echo accepted")
	}
	if identityProofMatches(nil, base64.StdEncoding.EncodeToString(nil)) {
		t.Fatal("empty challenge must never match — that would accept any host")
	}
}
