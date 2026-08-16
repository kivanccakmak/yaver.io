package main

// mdns_local.go — the mDNS "*.local" LAN hostname capability.
//
// What this is: a stable, LAN-reachable name for THIS box — the thing that
// turns "open the web dashboard on 192.168.111.11:18080" into "open it on
// yaver.local:18080". Same trick as a home router's "<brand>.local", Apple
// devices ("kivancs-macbook-air.local"), or a Raspberry Pi with avahi. One
// name, remembered by humans, stable across DHCP renewals, resolvable from
// every device on the LAN (phones, TVs, the other laptop).
//
// Why it exists as a product verb (2026-08-12): the tvOS/WebRTC local-network
// trial needed the box reachable by NAME from the other PC. The manual recipe
// is three sudo commands (`scutil --set LocalHostName` + ComputerName + a DNS
// cache flush). Every manual recipe that took three commands is a missing
// verb — `dns_localname_set` is that verb, and `dns_localname_status` proves
// it worked by actually resolving `<name>.local`, not by trusting the exit
// code of `scutil` (the inventory-says-yes/operation-says-no rule: a name can
// be SET and still not be ADVERTISED on the LAN interface).
//
// Platform reality (resolved per os/arch, never claimed impossible by hand):
//   - darwin: `scutil --set LocalHostName` + `scutil --set ComputerName`
//     (root), then `dscacheutil -flushcache` + `killall -HUP mDNSResponder`.
//     Verification: `dns-sd -G v4 <name>.local` and check the LAN interface
//     (non-loopback) address appears.
//   - linux: `hostnamectl set-hostname <name>` (root). BUT the `.local`
//     ADVERTISEMENT on Linux needs avahi-daemon (`systemctl enable --now
//     avahi-daemon`) — without it the name is set but no other machine can
//     resolve it. The verb states this and offers the fix rather than lying.
//   - windows: no stable mDNS LocalHostName seam; report unsupported with the
//     honest reason (wsd/LLMNR differ) instead of pretending.
//
// Sudo strategy: reuse the same `sudo -S -k` + YAVER_LOGIN_PASSWORD pattern
// as infra_grant_reboot.go — password piped on stdin, `-k` forces a fresh
// prompt so we never ride a stale sudo timestamp. The password comes from
// ~/.yaver/local-secrets.env (never committed, chmod 600) or the
// YAVER_LOGIN_PASSWORD env var. If neither is present the command fails with
// a named reason instead of hanging on a tty prompt.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	localNameStateFile = "localname.json"
	localNameMarker    = "yaver-managed"
)

// LocalNameState records the name we set so it can be reverted, and the
// previous values so `restore` puts the box back exactly as it was.
type LocalNameState struct {
	Name         string    `json:"name"`                    // current LocalHostName set by yaver
	PrevName     string    `json:"prev_name,omitempty"`     // LocalHostName before yaver touched it
	PrevComputer string    `json:"prev_computer,omitempty"` // ComputerName before yaver touched it
	SetAt        time.Time `json:"set_at"`
	ManagedBy    string    `json:"managed_by"`
}

// LocalNameStatus is the read-model for `dns_localname_status` — what the
// name IS, and the only fact that matters: can the LAN resolve it.
type LocalNameStatus struct {
	LocalHostName  string   `json:"localHostName"`
	ComputerName   string   `json:"computerName"`
	ExpectedName   string   `json:"expectedName,omitempty"` // the <name>.local we want
	Resolvable     bool     `json:"resolvable"`             // <name>.local answered on a LAN interface
	LANAddresses   []string `json:"lanAddresses,omitempty"` // what <name>.local resolved to
	AdvertisedLAN  bool     `json:"advertisedLan"`          // at least one non-loopback A record
	ManagedByYaver bool     `json:"managedByYaver"`         // state file exists for this name
	Platform       string   `json:"platform"`
	LinuxAvahi     bool     `json:"linuxAvahi,omitempty"` // linux: avahi-daemon active?
	Note           string   `json:"note,omitempty"`
}

// LocalNameManager reads/sets the machine's mDNS .local name and persists a
// revertible state under ~/.yaver/localname.json.
type LocalNameManager struct {
	mu         sync.Mutex
	configPath string
}

// NewLocalNameManager returns a LocalNameManager with state at
// ~/.yaver/localname.json.
func NewLocalNameManager() *LocalNameManager {
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	return &LocalNameManager{
		configPath: filepath.Join(home, ".yaver", localNameStateFile),
	}
}

// Status reports the current mDNS name state. It never requires root.
func (m *LocalNameManager) Status() LocalNameStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	st := LocalNameStatus{
		LocalHostName: localHostName(),
		ComputerName:  computerName(),
		Platform:      runtime.GOOS,
	}

	state, err := m.loadState()
	if err == nil && state.Name != "" {
		st.ManagedByYaver = true
		st.ExpectedName = state.Name + ".local"
	}

	// Verify by ACTUALLY resolving the name, not by trusting scutil.
	if st.ExpectedName != "" {
		addrs := resolveLocalName(st.ExpectedName)
		st.LANAddresses = addrs
		for _, a := range addrs {
			ip := net.ParseIP(a)
			if ip != nil && !ip.IsLoopback() {
				st.Resolvable = true
				st.AdvertisedLAN = true
				break
			}
		}
		// A loopback-only answer means mDNSResponder is advertising the name
		// but only on lo0 — the LAN can't see it. That's a false green.
		if len(addrs) > 0 && !st.AdvertisedLAN {
			st.Note = "name resolves only to loopback — the LAN cannot see it yet"
		}
	}

	if runtime.GOOS == "linux" {
		st.LinuxAvahi = avahiActive()
		if !st.LinuxAvahi {
			st.Note = "avahi-daemon not running — the .local name is set but not advertised on the LAN. Fix: sudo systemctl enable --now avahi-daemon"
		}
	}
	return st
}

// trimLocalSuffix strips a trailing ".local" from a user-typed name so both
// "yaver" and "yaver.local" are accepted (the .local suffix is implied).
func trimLocalSuffix(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > 6 && strings.EqualFold(name[len(name)-6:], ".local") {
		name = name[:len(name)-6]
	}
	return strings.TrimSpace(name)
}

// Set changes the machine's mDNS name to <name>.local. Requires root
// (via YAVER_LOGIN_PASSWORD / local-secrets.env on darwin; hostnamectl on
// linux). Returns a human-readable confirmation. The previous name is
// persisted for revert.
func (m *LocalNameManager) Set(ctx context.Context, name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	name = trimLocalSuffix(name)
	if name == "" {
		return "", fmt.Errorf("name must not be empty")
	}
	if strings.ContainsAny(name, " .") {
		return "", fmt.Errorf("name %q must be a single token without spaces or dots (mDNS names are flat)", name)
	}

	prevHost := localHostName()
	prevComputer := computerName()

	var out []string
	var err error
	switch runtime.GOOS {
	case "darwin":
		out, err = m.setDarwin(name)
	case "linux":
		out, err = m.setLinux(name)
	default:
		return "", fmt.Errorf("%s has no stable mDNS LocalHostName seam (only macOS/linux advertise *.local names); the name would be set but unresolvable on the LAN", runtime.GOOS)
	}
	if err != nil {
		return "", err
	}

	// Persist state for revert.
	state := LocalNameState{
		Name:         name,
		PrevName:     prevHost,
		PrevComputer: prevComputer,
		SetAt:        time.Now().UTC(),
		ManagedBy:    localNameMarker,
	}
	if err := m.saveState(&state); err != nil {
		return "", fmt.Errorf("set ok but could not persist revert state: %w", err)
	}

	msg := fmt.Sprintf("Local name set to %s.local.\n%s", name, strings.Join(out, "\n"))

	// Prove it: resolve the new name on a LAN interface. A name that is SET
	// but not ADVERTISED is the recurring false green — say so loudly.
	deadline := time.Now().Add(6 * time.Second)
	for {
		addrs := resolveLocalName(name + ".local")
		lan := false
		for _, a := range addrs {
			ip := net.ParseIP(a)
			if ip != nil && !ip.IsLoopback() {
				lan = true
				break
			}
		}
		if lan {
			msg += fmt.Sprintf("\nVerified: %s.local resolves on the LAN (%s).", name, strings.Join(addrs, ", "))
			return msg, nil
		}
		if time.Now().After(deadline) {
			msg += fmt.Sprintf("\nWARNING: %s.local does not yet resolve on the LAN (loopback only). mDNS propagation can take a few seconds; re-run dns_localname_status. If it stays loopback-only, check the firewall/mDNSResponder.", name)
			return msg, nil
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// Restore reverts to the pre-yaver LocalHostName/ComputerName recorded when
// Set last ran. No-op (with a clear message) when yaver never set a name.
func (m *LocalNameManager) Restore(ctx context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	state, err := m.loadState()
	if err != nil {
		return "", fmt.Errorf("no yaver-managed local name to restore (state read failed: %v)", err)
	}
	if state.Name == "" {
		return "", fmt.Errorf("no yaver-managed local name to restore")
	}

	if runtime.GOOS == "darwin" {
		if state.PrevName != "" {
			if err := scutilSet("LocalHostName", state.PrevName); err != nil {
				return "", fmt.Errorf("restore LocalHostName: %w", err)
			}
		}
		if state.PrevComputer != "" {
			if err := scutilSet("ComputerName", state.PrevComputer); err != nil {
				return "", fmt.Errorf("restore ComputerName: %w", err)
			}
		}
		flushDNSCacheQuiet()
	} else if runtime.GOOS == "linux" {
		if state.PrevName != "" {
			if err := hostnamectlSet(state.PrevName); err != nil {
				return "", fmt.Errorf("restore hostname: %w", err)
			}
		}
	}

	if err := os.Remove(m.configPath); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("restore ok but could not clear state: %w", err)
	}
	return fmt.Sprintf("Restored LocalHostName to %q, ComputerName to %q.", state.PrevName, state.PrevComputer), nil
}

// --- darwin implementation ------------------------------------------------

func (m *LocalNameManager) setDarwin(name string) ([]string, error) {
	var out []string
	// ComputerName is what Finder/other Macs show; LocalHostName is the
	// *.local mDNS name. Set both so the box is consistent everywhere.
	if err := scutilSet("LocalHostName", name); err != nil {
		return nil, fmt.Errorf("scutil LocalHostName: %w", err)
	}
	out = append(out, fmt.Sprintf("LocalHostName -> %s", name))
	if err := scutilSet("ComputerName", name); err != nil {
		// Non-fatal: the .local name is the part that matters for LAN dev.
		out = append(out, fmt.Sprintf("note: ComputerName not updated (%v)", err))
	} else {
		out = append(out, fmt.Sprintf("ComputerName -> %s", name))
	}
	flushDNSCacheQuiet()
	return out, nil
}

// scutilSet runs `sudo -S -k scutil --set <key> <value>` with the owner
// password piped to stdin (same pattern as infra_grant_reboot.go).
func scutilSet(key, value string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("scutil only exists on macOS")
	}
	password := loginPassword()
	if password == "" {
		return fmt.Errorf("scutil needs root but YAVER_LOGIN_PASSWORD is not set in ~/.yaver/local-secrets.env — add it (chmod 600) or run the equivalent command by hand")
	}
	cmd := exec.Command("sudo", "-S", "-k", "scutil", "--set", key, value)
	cmd.Stdin = strings.NewReader(password + "\n")
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		if strings.Contains(strings.ToLower(msg), "incorrect password") || strings.Contains(msg, "Sorry, try again") {
			return fmt.Errorf("sudo password rejected — YAVER_LOGIN_PASSWORD in ~/.yaver/local-secrets.env is stale")
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// --- linux implementation --------------------------------------------------

func (m *LocalNameManager) setLinux(name string) ([]string, error) {
	if err := hostnamectlSet(name); err != nil {
		return nil, err
	}
	var out []string
	out = append(out, fmt.Sprintf("hostname -> %s", name))
	if !avahiActive() {
		out = append(out, "WARNING: avahi-daemon is not running — other machines cannot resolve "+name+".local yet. Fix: sudo systemctl enable --now avahi-daemon")
	}
	return out, nil
}

// hostnamectlSet runs hostnamectl set-hostname with sudo -S.
func hostnamectlSet(name string) error {
	password := loginPassword()
	if password == "" {
		// Try without a password first (root user / passwordless sudo).
		if out, err := exec.Command("hostnamectl", "set-hostname", name).CombinedOutput(); err == nil {
			return nil
		} else {
			return fmt.Errorf("hostnamectl set-hostname needs root: %s", strings.TrimSpace(string(out)))
		}
	}
	cmd := exec.Command("sudo", "-S", "-k", "hostnamectl", "set-hostname", name)
	cmd.Stdin = strings.NewReader(password + "\n")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("hostnamectl set-hostname: %w %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// --- shared helpers --------------------------------------------------------

// loginPassword returns the owner password used for sudo -S, preferring the
// env var, then ~/.yaver/local-secrets.env (the documented local store).
func loginPassword() string {
	if v := os.Getenv("YAVER_LOGIN_PASSWORD"); v != "" {
		return v
	}
	return localSecretsEnv()["YAVER_LOGIN_PASSWORD"]
}

func localHostName() string {
	if runtime.GOOS != "darwin" {
		if v := os.Getenv("HOSTNAME"); v != "" {
			return v
		}
		if v := os.Getenv("HOST"); v != "" {
			return v
		}
	}
	out, err := exec.Command("scutil", "--get", "LocalHostName").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func computerName() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	out, err := exec.Command("scutil", "--get", "ComputerName").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// resolveLocalName resolves <name>.local via the OS resolver and returns
// every A/AAAA address, deduped.
func resolveLocalName(name string) []string {
	ips, err := net.LookupIP(name)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, ip := range ips {
		s := ip.String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func flushDNSCacheQuiet() {
	switch runtime.GOOS {
	case "darwin":
		// Best-effort: if sudo fails here the name still propagates within
		// mDNS's TTL; do not fail the whole operation on cache flush.
		password := loginPassword()
		cmd := exec.Command("sudo", "-S", "-k", "dscacheutil", "-flushcache")
		cmd.Stdin = strings.NewReader(password + "\n")
		_ = cmd.Run()
		cmd = exec.Command("sudo", "-S", "-k", "killall", "-HUP", "mDNSResponder")
		cmd.Stdin = strings.NewReader(password + "\n")
		_ = cmd.Run()
	case "linux":
		_ = exec.Command("systemd-resolve", "--flush-caches").Run()
	}
}

func avahiActive() bool {
	out, err := exec.Command("systemctl", "is-active", "avahi-daemon").Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "active"
}

// --- state persistence -----------------------------------------------------

func (m *LocalNameManager) loadState() (*LocalNameState, error) {
	data, err := os.ReadFile(m.configPath)
	if os.IsNotExist(err) {
		return &LocalNameState{}, nil
	}
	if err != nil {
		return nil, err
	}
	var st LocalNameState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (m *LocalNameManager) saveState(st *LocalNameState) error {
	dir := filepath.Dir(m.configPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.configPath, data, 0o600)
}
