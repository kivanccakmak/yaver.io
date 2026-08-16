package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/nacl/box"
)

// identity_proof.go — POST /identity/prove: "prove you are the machine Convex
// says you are, before I send you anything."
//
// WHY
// ---
// LAN discovery is unauthenticated by construction. The UDP beacon is unsigned,
// its `th` tag is a short unsalted hash any listener can replay, and a bootstrap
// beacon deliberately bypasses even that. So a beacon tells you an address; it
// never tells you WHO is at that address.
//
// The client used to resolve that by connecting and attaching its bearer token:
// probe http://<beacon-ip>/health WITH credentials, and on 200 move the whole
// session there. That trusts an unauthenticated UDP packet with an authenticated
// session — anyone on the LAN could broadcast a beacon for a device id, receive
// the user's token, and become the machine (audit 2026-07-28).
//
// THE HANDSHAKE (challenge-response proof of possession)
// -----------------------------------------------------
// Standard shape, and deliberately built only from primitives already in this
// codebase — no new crypto, nothing hand-rolled:
//
//  1. Client generates a random 32-byte nonce and an ephemeral X25519 keypair.
//  2. Client seals the nonce to the device public key CONVEX holds for the
//     device it is trying to reach (NaCl box — the same construction the
//     encrypted-pair path already uses).
//  3. Client POSTs {sealed, senderPublicKey} here. NO credentials: an unproven
//     host must never see a token, which is the entire point.
//  4. Only the machine holding that device private key can open the box. It
//     echoes the nonce back.
//  5. Client compares. Match ⇒ this host provably holds the private key for the
//     Convex-recorded identity ⇒ it is safe to move the session and attach
//     credentials. Mismatch or silence ⇒ walk away.
//
// PROPERTIES
//   - Mutual: the client already proves itself with its bearer AFTER this
//     succeeds; this leg is the server proving itself FIRST, which is the leg
//     that was missing.
//   - No credential is exposed to an unverified party at any point.
//   - An impostor cannot pass without the private key. Reading the beacon,
//     replaying `th`, or answering /health does not help.
//   - Replay-safe: the nonce is fresh per attempt and the client only accepts
//     the value it just generated.
//   - Unauthenticated by design, and safe to be: it reveals nothing. Decrypting
//     an attacker's own nonce and echoing it tells them only that we hold a key
//     they already knew the public half of.
//
// Deliberately NOT reused for authorization: this proves machine IDENTITY, not
// user permission. Every existing auth check still runs afterwards.

const identityProofMaxSealed = 4096 // a sealed 32-byte nonce is ~72 bytes

type identityProveRequest struct {
	Sealed          string `json:"sealed"`          // base64: 24-byte nonce || box ciphertext
	SenderPublicKey string `json:"senderPublicKey"` // base64: client's ephemeral X25519 public key
}

type identityProveResponse struct {
	OK        string `json:"ok,omitempty"`
	Nonce     string `json:"nonce,omitempty"` // base64 of the decrypted challenge
	PublicKey string `json:"publicKey,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (s *HTTPServer) handleIdentityProve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req identityProveRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, identityProofMaxSealed)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	sealed, err := base64.StdEncoding.DecodeString(req.Sealed)
	if err != nil || len(sealed) < 24 {
		jsonError(w, http.StatusBadRequest, "sealed must be base64 of nonce||ciphertext")
		return
	}
	senderRaw, err := base64.StdEncoding.DecodeString(req.SenderPublicKey)
	if err != nil || len(senderRaw) != 32 {
		jsonError(w, http.StatusBadRequest, "senderPublicKey must be base64 of 32 bytes")
		return
	}
	var senderPub [32]byte
	copy(senderPub[:], senderRaw)

	dk, err := LoadOrGenerateKeys()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "device key unavailable")
		return
	}
	plain, err := dk.DecryptPairPayload(sealed, senderPub)
	if err != nil {
		// A single generic failure for every rejection: never tell a prober
		// which part it got wrong.
		jsonError(w, http.StatusForbidden, "challenge could not be opened")
		return
	}
	writeJSON(w, http.StatusOK, identityProveResponse{
		OK:    "true",
		Nonce: base64.StdEncoding.EncodeToString(plain),
		// Echo our public key so a client can cross-check it against Convex
		// without a second round trip. Public keys are safe to publish.
		PublicKey: dk.PublicKeyBase64(),
	})
}

// sealIdentityChallenge is the client half, kept beside the server half so the
// two cannot drift. Used by the Go CLI and by tests; the mobile client mirrors
// it with tweetnacl.
//
// Returns the sealed blob, the ephemeral public key to send alongside it, and
// the nonce the caller must require back.
func sealIdentityChallenge(deviceRecipientPub [32]byte) (sealedB64, senderPubB64 string, nonce []byte, err error) {
	nonce = make([]byte, 32)
	if _, err = rand.Read(nonce); err != nil {
		return "", "", nil, err
	}
	ephPub, ephPriv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", nil, err
	}
	var boxNonce [24]byte
	if _, err = rand.Read(boxNonce[:]); err != nil {
		return "", "", nil, err
	}
	ct := box.Seal(boxNonce[:], nonce, &boxNonce, &deviceRecipientPub, ephPriv)
	return base64.StdEncoding.EncodeToString(ct),
		base64.StdEncoding.EncodeToString(ephPub[:]),
		nonce, nil
}

// identityProofMatches compares an echoed nonce against the expected one in
// constant time. A byte-wise early-exit compare here would leak the challenge
// one byte at a time to a host that can be probed repeatedly.
func identityProofMatches(expected []byte, echoedB64 string) bool {
	got, err := base64.StdEncoding.DecodeString(echoedB64)
	if err != nil || len(got) != len(expected) || len(expected) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare(got, expected) == 1
}
