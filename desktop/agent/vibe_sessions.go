package main

// vibe_sessions.go attributes ports and runtime devices to concurrent owner
// workloads. The former participant/join/role model was part of removed account
// sharing and deliberately does not survive as a dormant internal API.

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// VibeSessionView is the serialisable form handed to every client surface. One
// shape, rendered the same way on web, mobile, TV and watch.
type VibeSessionView struct {
	ID          string             `json:"id"`
	OwnerUserID string             `json:"ownerUserId"`
	Project     string             `json:"project"`   // basename only — never the absolute path
	Framework   string             `json:"framework"` // "flutter" | "expo" | … when known
	Resources   []VibeResourceView `json:"resources"` // ports + devices this session holds
	CreatedAt   time.Time          `json:"createdAt"`
}

// VibeResourceView is a port or a device attributed to a session.
type VibeResourceView struct {
	Type  string `json:"type"`  // "port" | "device"
	Kind  string `json:"kind"`  // "metro" | "flutter" | "ios-simulator" | …
	Value string `json:"value"` // "8083" | "323C65E7-…"
	Label string `json:"label"` // human: "Metro on :8083", "iPhone 15"
	Since string `json:"since"` // RFC3339
}

type vibeSession struct {
	id          string
	ownerUserID string
	workDir     string
	framework   string
	createdAt   time.Time
}

// VibeSessionRegistry is the machine's live view of owner workloads.
type VibeSessionRegistry struct {
	mu       sync.RWMutex
	sessions map[string]*vibeSession
	now      func() time.Time // injectable for tests
}

func NewVibeSessionRegistry(_ string) *VibeSessionRegistry {
	return &VibeSessionRegistry{
		sessions: map[string]*vibeSession{},
		now:      time.Now,
	}
}

func newVibeID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("vs%d", time.Now().UnixNano())
	}
	return "vs_" + hex.EncodeToString(b)
}

// EnsureSession returns the session for a workDir, creating it if needed. Keyed
// by workDir because that is what "a piece of work" means to the user: repeated
// work on one project shares a session, while two projects never do. That is the
// boundary exclusive resources need.
func (r *VibeSessionRegistry) EnsureSession(ownerUserID, workDir, framework string) *VibeSessionView {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.sessions {
		if s.workDir == workDir {
			if framework != "" {
				s.framework = framework
			}
			return r.viewLocked(s)
		}
	}
	s := &vibeSession{
		id:          newVibeID(),
		ownerUserID: ownerUserID,
		workDir:     workDir,
		framework:   framework,
		createdAt:   r.now(),
	}
	r.sessions[s.id] = s
	return r.viewLocked(s)
}

// Sessions returns every tracked owner workload.
func (r *VibeSessionRegistry) Sessions() []VibeSessionView {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]VibeSessionView, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, *r.viewLocked(s))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// PruneEmpty drops sessions that no longer hold resources.
func (r *VibeSessionRegistry) PruneEmpty() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, s := range r.sessions {
		if len(resourcesForOwner(vibeOwnerTag(s.id))) == 0 {
			delete(r.sessions, id)
		}
	}
}

// viewLocked builds the client-facing view. Caller holds the lock.
func (r *VibeSessionRegistry) viewLocked(s *vibeSession) *VibeSessionView {
	return &VibeSessionView{
		ID:          s.id,
		OwnerUserID: s.ownerUserID,
		// Basename only. An absolute path leaks the box's username.
		Project:   filepath.Base(s.workDir),
		Framework: s.framework,
		Resources: resourcesForOwner(vibeOwnerTag(s.id)),
		CreatedAt: s.createdAt,
	}
}

// vibeOwnerTag is the string a session writes into its resource claims, so the
// port broker and the device broker can be joined back to the session without
// either of them knowing what a session is.
func vibeOwnerTag(sessionID string) string { return "sess:" + sessionID }

// activeVibeRegistry lets components that are NOT wired to the HTTP server (the
// remote-runtime/WebRTC manager) attribute their claims to the right session.
//
// A package-level pointer rather than plumbing the registry through five
// constructors: the registry is a machine-wide fact, exactly like the port space
// it describes, and the alternative was every claim from the WebRTC lane landing
// as "unattributed" — which would make the roster wrong precisely for the
// resources most prone to collision (simulators).
var activeVibeRegistry atomic.Pointer[VibeSessionRegistry]

func registerVibeRegistry(r *VibeSessionRegistry) { activeVibeRegistry.Store(r) }

// VibeOwnerForWorkDir returns the claim-owner tag for a project directory: the
// session tag when a session exists, else a path-derived label so a stray claim is
// still attributable to something a human recognises.
func VibeOwnerForWorkDir(workDir string) string {
	if reg := activeVibeRegistry.Load(); reg != nil {
		reg.mu.RLock()
		for _, s := range reg.sessions {
			if s.workDir == workDir {
				id := s.id
				reg.mu.RUnlock()
				return vibeOwnerTag(id)
			}
		}
		reg.mu.RUnlock()
	}
	return devPortOwner("", workDir)
}
