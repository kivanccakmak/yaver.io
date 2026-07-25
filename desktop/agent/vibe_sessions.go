package main

// vibe_sessions.go — who is working on this machine, on what, from where, and
// with what permission.
//
// ── The shape of the problem ──────────────────────────────────────────────────
//
// One good machine (Mac mini today, Mac Studio next) hosts several INDEPENDENT
// pieces of work at once, and each piece may have several people watching or
// driving it from different surfaces:
//
//   machine
//   ├── vibe session "e-mobile"      owner=kivanc   project=/Workspace/e-mobile
//   │    ├── participants: kivanc (web, owner) · batikan (mobile, driver) · guest (tv, viewer)
//   │    └── resources:    :9100 flutter · simulator 323C65E7 (iPhone 15)
//   └── vibe session "todo-rn"       owner=batikan  project=/Workspace/todo-rn
//        ├── participants: batikan (mobile, owner)
//        └── resources:    :8083 metro · emulator-5554
//
// Three things follow, and they are all the same fact viewed differently:
//
//   1. **Exclusive resources belong to a SESSION, not to the machine.** A port or
//      a simulator handed to two sessions is a correctness bug — see
//      exclusive_claims.go for the two incidents that motivated it.
//   2. **Presence must be visible.** If Batikan cannot see that Kivanç is driving
//      the same session from the web, they fight over the same simulator and each
//      thinks the other is a glitch. A roster is not decoration; silence about who
//      else is here is the same defect class as a spinner with no elapsed time.
//   3. **Roles must be enforced, not displayed.** "Read-only" that only greys out
//      a button in one client is theatre: another surface, or curl, ignores it. The
//      check belongs where the mutation happens (RequireDriver below).
//
// ── Deliberate design choices ────────────────────────────────────────────────
//
// • **Presence expires.** A participant that stops heartbeating is dropped after
//   participantTTL. A roster that only grows is a roster that lies — a phone that
//   went into a tunnel must not appear to be driving.
// • **The owner is whoever owns the machine**, not whoever joined first. Roles are
//   granted by the owner only; a driver cannot promote themselves or a friend.
// • **Default role for a non-owner is viewer.** Being able to see someone's
//   machine is not permission to type on it. Promotion is an explicit act.
// • **Sessions are ephemeral, in-memory, per-agent.** They describe live activity
//   on THIS machine; nothing here is a durable record and nothing goes to Convex
//   (the privacy contract forbids paths/project data there anyway).

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Roles, lowest to highest capability.
const (
	VibeRoleViewer = "viewer" // may watch: status, logs, video, screenshots
	VibeRoleDriver = "driver" // may also act: start/stop/reload, input, tasks
	VibeRoleOwner  = "owner"  // may also grant/revoke roles
)

// participantTTL is how long a participant survives without a heartbeat. Two
// missed 10s heartbeats — long enough to ride out a relay blip, short enough that
// a closed laptop stops looking like an active driver.
const participantTTL = 25 * time.Second

// VibeParticipant is one person on one surface inside one session.
type VibeParticipant struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Surface     string    `json:"surface"` // web | mobile | tablet | tv | watch | car | glass | cli
	Role        string    `json:"role"`
	IsGuest     bool      `json:"isGuest"`
	JoinedAt    time.Time `json:"joinedAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
}

// VibeSessionView is the serialisable form handed to every client surface. One
// shape, rendered the same way on web, mobile, TV and watch.
type VibeSessionView struct {
	ID           string             `json:"id"`
	OwnerUserID  string             `json:"ownerUserId"`
	Project      string             `json:"project"`      // basename only — never the absolute path
	Framework    string             `json:"framework"`    // "flutter" | "expo" | … when known
	Participants []VibeParticipant  `json:"participants"` // live only (TTL applied)
	Resources    []VibeResourceView `json:"resources"`    // ports + devices this session holds
	CreatedAt    time.Time          `json:"createdAt"`
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
	id           string
	ownerUserID  string
	workDir      string
	framework    string
	createdAt    time.Time
	participants map[string]*VibeParticipant
}

// VibeSessionRegistry is the machine's live view of who is doing what.
type VibeSessionRegistry struct {
	mu       sync.RWMutex
	sessions map[string]*vibeSession
	// ownerUserID is the machine's owner — the only identity that may grant roles.
	ownerUserID string
	now         func() time.Time // injectable for tests
}

func NewVibeSessionRegistry(ownerUserID string) *VibeSessionRegistry {
	return &VibeSessionRegistry{
		sessions:    map[string]*vibeSession{},
		ownerUserID: ownerUserID,
		now:         time.Now,
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
// by workDir because that is what "a piece of work" means to the user: two people
// on the same project share a session, two projects never do — which is exactly
// the boundary the exclusive resources need.
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
		id:           newVibeID(),
		ownerUserID:  ownerUserID,
		workDir:      workDir,
		framework:    framework,
		createdAt:    r.now(),
		participants: map[string]*VibeParticipant{},
	}
	r.sessions[s.id] = s
	return r.viewLocked(s)
}

// Join adds (or refreshes) a participant.
//
// Role assignment is NOT the caller's choice: the machine owner is always owner,
// everyone else starts as viewer and can only be promoted by the owner. A client
// asking to join "as driver" is asking for something it is not allowed to decide.
func (r *VibeSessionRegistry) Join(sessionID, userID, displayName, surface string, isGuest bool) (VibeParticipant, *VibeSessionView, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return VibeParticipant{}, nil, fmt.Errorf("no vibe session %s on this machine", sessionID)
	}
	id := participantID(userID, surface)
	now := r.now()
	if existing, ok := s.participants[id]; ok {
		existing.LastSeenAt = now
		if displayName != "" {
			existing.DisplayName = displayName
		}
		return *existing, r.viewLocked(s), nil
	}
	role := VibeRoleViewer
	if userID != "" && userID == r.ownerUserID {
		role = VibeRoleOwner
	}
	p := &VibeParticipant{
		ID:          id,
		UserID:      userID,
		DisplayName: strings.TrimSpace(displayName),
		Surface:     surfaceLabel(surface),
		Role:        role,
		IsGuest:     isGuest,
		JoinedAt:    now,
		LastSeenAt:  now,
	}
	s.participants[id] = p
	return *p, r.viewLocked(s), nil
}

// Heartbeat keeps a participant alive. Returns false when the participant has
// already been reaped, so the client can re-join rather than silently believing
// it is still present.
func (r *VibeSessionRegistry) Heartbeat(sessionID, participantID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return false
	}
	p, ok := s.participants[participantID]
	if !ok {
		return false
	}
	p.LastSeenAt = r.now()
	return true
}

func (r *VibeSessionRegistry) Leave(sessionID, participantID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.sessions[sessionID]; ok {
		delete(s.participants, participantID)
	}
}

// SetRole grants or revokes drive permission. Only the machine owner may call it
// (grantedByUserID is taken from the authenticated request, never from a body
// field), and the owner's own role is not demotable — a machine whose owner has
// locked themselves out is a support ticket, not a feature.
func (r *VibeSessionRegistry) SetRole(grantedByUserID, sessionID, participantID, role string) error {
	role = strings.TrimSpace(strings.ToLower(role))
	if role != VibeRoleViewer && role != VibeRoleDriver {
		return fmt.Errorf("role must be %q or %q", VibeRoleViewer, VibeRoleDriver)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if grantedByUserID == "" || grantedByUserID != r.ownerUserID {
		return fmt.Errorf("only the machine owner can change who may vibe in this session")
	}
	s, ok := r.sessions[sessionID]
	if !ok {
		return fmt.Errorf("no vibe session %s on this machine", sessionID)
	}
	p, ok := s.participants[participantID]
	if !ok {
		return fmt.Errorf("no participant %s in that session", participantID)
	}
	if p.Role == VibeRoleOwner {
		return fmt.Errorf("the machine owner's role cannot be changed")
	}
	p.Role = role
	return nil
}

// RoleOf returns the effective role for a user on a surface, and whether they are
// present at all. The machine owner is always owner, even before joining — the
// enforcement path must never depend on a roster entry existing.
func (r *VibeSessionRegistry) RoleOf(sessionID, userID, surface string) (role string, present bool) {
	if userID != "" && userID == r.ownerUserID {
		return VibeRoleOwner, true
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sessions[sessionID]
	if !ok {
		return "", false
	}
	p, ok := s.participants[participantID(userID, surface)]
	if !ok || r.now().Sub(p.LastSeenAt) > participantTTL {
		return "", false
	}
	return p.Role, true
}

// CanDrive is the enforcement predicate: may this identity mutate this session?
//
// Fails CLOSED for an unknown participant in a known session — someone who never
// joined has not been granted anything. The machine owner always passes.
func (r *VibeSessionRegistry) CanDrive(sessionID, userID, surface string) bool {
	role, present := r.RoleOf(sessionID, userID, surface)
	if !present {
		return false
	}
	return role == VibeRoleOwner || role == VibeRoleDriver
}

// Sessions returns every live session with expired participants reaped.
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

// PruneEmpty drops sessions with no live participants and no held resources, so
// the roster reflects now rather than history.
func (r *VibeSessionRegistry) PruneEmpty() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, s := range r.sessions {
		live := 0
		for pid, p := range s.participants {
			if r.now().Sub(p.LastSeenAt) > participantTTL {
				delete(s.participants, pid)
				continue
			}
			live++
		}
		if live == 0 && len(resourcesForOwner(vibeOwnerTag(s.id))) == 0 {
			delete(r.sessions, id)
		}
	}
}

// viewLocked builds the client-facing view. Caller holds the lock.
func (r *VibeSessionRegistry) viewLocked(s *vibeSession) *VibeSessionView {
	participants := make([]VibeParticipant, 0, len(s.participants))
	for _, p := range s.participants {
		if r.now().Sub(p.LastSeenAt) > participantTTL {
			continue // expired: never present a stale participant as live
		}
		participants = append(participants, *p)
	}
	sort.Slice(participants, func(i, j int) bool {
		if participants[i].Role != participants[j].Role {
			return vibeRoleRank(participants[i].Role) > vibeRoleRank(participants[j].Role)
		}
		return participants[i].JoinedAt.Before(participants[j].JoinedAt)
	})
	return &VibeSessionView{
		ID:          s.id,
		OwnerUserID: s.ownerUserID,
		// Basename only. An absolute path leaks the box's username to every
		// participant (and matches the Convex privacy rule about paths).
		Project:      filepath.Base(s.workDir),
		Framework:    s.framework,
		Participants: participants,
		Resources:    resourcesForOwner(vibeOwnerTag(s.id)),
		CreatedAt:    s.createdAt,
	}
}

func vibeRoleRank(role string) int {
	switch role {
	case VibeRoleOwner:
		return 3
	case VibeRoleDriver:
		return 2
	default:
		return 1
	}
}

// participantID keys a participant by identity AND surface, so the same person on
// a phone and on the web shows up as two seats — which is what the user sees, and
// what lets the owner grant drive rights to one and not the other.
func participantID(userID, surface string) string {
	uid := strings.TrimSpace(userID)
	if uid == "" {
		uid = "anon"
	}
	return uid + "@" + surfaceLabel(surface)
}

// surfaceLabel reuses surface.go's canonical normalizer — the agent already has
// ONE definition of what a client surface is (X-Yaver-Surface), and a second one
// here would drift the moment a surface is added.
func surfaceLabel(raw string) string { return string(normalizeSurface(raw)) }

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
// resources people fight over most (simulators).
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
