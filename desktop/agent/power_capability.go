package main

// power_capability.go — what "reboot" actually MEANS on THIS machine.
//
// GCP and AWS put a Reset/Reboot button on every instance card because the
// console owns the hypervisor: the button is always honourable. Yaver does not
// own the machine — it is a user-space agent on someone else's box — so the
// same button is a claim we have to earn, per machine, every time we render it.
//
// The incidents this file is written against, each stated as the false green it
// produced:
//
//   - `capabilities.hostReboot` used to be `GOOS == "darwin" || GOOS == "linux"`.
//     That is a statement about the operating system, not about us. Every box got
//     an ENABLED "Reboot host" button that could only fail when tapped, because
//     the agent runs as an ordinary user under launchd/systemd and reboot needs
//     root. `canRebootHost()` (infra_http.go) fixed the probe; this file fixes
//     the ANSWER — a bare `false` tells the user they cannot reboot without ever
//     telling them why, or what they could do instead.
//
//   - "Reboot" inside a container is not a reboot. `systemctl reboot` in a Docker
//     container either fails (no PID 1 systemd) or kills the container — and in
//     NEITHER case does the machine underneath power-cycle. A UI that offers
//     "Reboot host" there is lying about the blast radius in the direction that
//     matters: the user thinks they are clearing a wedged machine and they are
//     not. Same for WSL: rebooting the distro is not rebooting Windows.
//
//   - The user's actual goal is almost never "reboot"; it is "this box is stuck,
//     un-stick it". Reboot is the biggest hammer for that goal, and on most boxes
//     it is the one we cannot swing. So an unavailable reboot MUST hand back the
//     hammer we CAN swing — restart the agent — rather than dead-ending. A
//     capability report that only says "no" is half a product.
//
// Everything below is a PURE function of an injected facts struct. The probing
// lives in powerFactsNow(); the decisions live in PowerActionsFor() and are
// exhaustively unit-tested without touching the machine. That split is the whole
// point: we can prove what the UI will say about a Raspberry Pi, a Docker
// container and a locked-down Mac without owning any of them.

import (
	"fmt"
	"os"
	"runtime"
	"strings"
)

// PowerActionID names a power action. Wire values — surfaces switch on these.
type PowerActionID string

const (
	// ActionHostReboot power-cycles the operating system. Everything dies.
	ActionHostReboot PowerActionID = "host_reboot"
	// ActionAgentRestart restarts only the Yaver agent process via the service
	// manager that owns it. The machine stays up; tasks and dev servers die.
	ActionAgentRestart PowerActionID = "agent_restart"
	// ActionAgentShutdown stops the agent and does not bring it back.
	ActionAgentShutdown PowerActionID = "agent_shutdown"
)

// PowerScope is what the action actually restarts — the honest blast radius.
// Rendered next to the button so "Reboot" can never be read as "reboots the
// machine" on a box where it does not.
type PowerScope string

const (
	ScopeMachine PowerScope = "machine"
	ScopeAgent   PowerScope = "agent"
	ScopeNone    PowerScope = "none"
)

// PowerFacts is everything the decision depends on. Injected so the decision is
// testable; populated by powerFactsNow() on a real box.
type PowerFacts struct {
	GOOS string `json:"goos"`
	// IsRoot is euid==0.
	IsRoot bool `json:"isRoot"`
	// PasswordlessSudo is the PROBED result of `sudo -n true`, not an assumption.
	PasswordlessSudo bool `json:"passwordlessSudo"`
	// Container is "" on bare metal/VM, else the runtime we detected
	// ("docker", "podman", "lxc", "kubernetes", "container").
	Container string `json:"container,omitempty"`
	// WSLVersion is 1 or 2 inside WSL, 0 otherwise.
	WSLVersion int `json:"wslVersion,omitempty"`
	// ServiceManager is who supervises the agent: "launchd", "systemd-user",
	// "systemd-system", or "" when the agent was hand-started.
	ServiceManager string `json:"serviceManager,omitempty"`
	// AgentUser is the login name the agent runs as — named in every remedy so
	// the sudoers rule the user has to write is copy-pasteable.
	AgentUser string `json:"agentUser,omitempty"`
	// UID is used to build the launchd kickstart target.
	UID int `json:"uid"`
}

// PowerAction is one row in the capability report: an offer we can honour, or a
// refusal that names its cause and its remedy.
type PowerAction struct {
	ID    PowerActionID `json:"id"`
	Label string        `json:"label"`
	// Available is the ONLY field a surface may use to enable a control.
	Available bool `json:"available"`
	// Destructive marks actions that need an explicit typed confirmation.
	Destructive bool `json:"destructive"`
	// Scope is the honest blast radius.
	Scope PowerScope `json:"scope"`
	// Means is one plain sentence: what happens to THIS machine if you do it.
	Means string `json:"means"`
	// Loses enumerates what dies. Shown in the confirm dialog — a destructive
	// action that does not state its cost is a trap.
	Loses []string `json:"loses,omitempty"`
	// Reason is why it is unavailable. Empty when Available.
	Reason string `json:"reason,omitempty"`
	// Remedy is the specific fix — a command or a named flow, never
	// "check your configuration".
	Remedy string `json:"remedy,omitempty"`
	// Command is what we WOULD run. This is the dry-run answer: a caller can ask
	// the capability report what a reboot would do without rebooting anything.
	Command string `json:"command,omitempty"`
	// ETASeconds is the bounded expectation the UI narrates ("expect ~60s").
	// 0 when the action is not available or has no wait.
	ETASeconds int `json:"etaSeconds,omitempty"`
	// Alternative names the achievable action to offer instead when this one is
	// unavailable. Empty when there is nothing better to suggest.
	Alternative PowerActionID `json:"alternative,omitempty"`
}

// Reboot recovery is not instant and the box goes silent while it happens, so
// every surface narrates against the same clock. Values are deliberate:
// systemd boxes come back in well under a minute; macOS with FileVault takes
// noticeably longer, and calling a Mac "overdue" at 60s would train the user to
// ignore the warning.
const (
	rebootETALinuxSeconds  = 60
	rebootETADarwinSeconds = 120
)

// PowerActionsFor is the decision. Pure: same facts in, same answer out, no
// syscalls. Order is stable — surfaces render it top to bottom.
func PowerActionsFor(f PowerFacts) []PowerAction {
	return []PowerAction{
		hostRebootAction(f),
		agentRestartAction(f),
		agentShutdownAction(f),
	}
}

// PowerActionByID returns one action from the report, and whether it exists.
func PowerActionByID(f PowerFacts, id PowerActionID) (PowerAction, bool) {
	for _, a := range PowerActionsFor(f) {
		if a.ID == id {
			return a, true
		}
	}
	return PowerAction{}, false
}

// rebootLoses is what a host reboot costs, stated the same way everywhere.
func rebootLoses() []string {
	return []string{
		"every running task and AI runner session",
		"every dev server (Metro, Vite, Next, Flutter) and its compiled state",
		"every terminal / PTY session attached to this machine",
		"anything unsaved in a process that does not flush on SIGTERM",
	}
}

func agentRestartLoses() []string {
	return []string{
		"every running task and AI runner session",
		"every dev server the agent started",
		"every terminal / PTY session attached to this machine",
	}
}

// hostRebootAction decides whether we may offer a real reboot.
//
// The order of the refusals matters and is not arbitrary: container and WSL are
// checked BEFORE privilege, because on those hosts the answer is "no such thing
// from in here" and granting sudo would not change it. Telling a container user
// to configure passwordless sudo would send them off to fix a problem they do
// not have, and leave them believing a reboot is one sudoers line away.
func hostRebootAction(f PowerFacts) PowerAction {
	a := PowerAction{
		ID:          ActionHostReboot,
		Label:       "Reboot machine",
		Destructive: true,
		Scope:       ScopeMachine,
		Loses:       rebootLoses(),
		Alternative: ActionAgentRestart,
	}
	user := strings.TrimSpace(f.AgentUser)
	if user == "" {
		user = "the agent user"
	}

	if f.GOOS != "darwin" && f.GOOS != "linux" {
		a.Scope = ScopeNone
		a.Means = fmt.Sprintf("Yaver cannot reboot a %s host.", f.GOOS)
		a.Reason = fmt.Sprintf("Host reboot is implemented for macOS and Linux only; this agent reports GOOS=%s.", f.GOOS)
		a.Remedy = "Reboot it from the operating system, or restart just the Yaver agent from here."
		return a
	}

	// A container has no host to reboot. Saying anything else misstates the
	// blast radius in the dangerous direction: the user believes they are
	// clearing a wedged machine and the machine never moves.
	//
	// This check runs BEFORE the privilege check and the ordering is load-bearing:
	// disable it and TestContainerNeverClaimsHostReboot fails on all four
	// runtimes (verified by breaking it), because a root container passes the
	// privilege gate and would advertise a reboot it cannot perform.
	if c := strings.TrimSpace(f.Container); c != "" {
		a.Scope = ScopeNone
		a.Means = fmt.Sprintf(
			"This agent runs inside a %s container. There is no host to reboot from in here — a reboot command would at best stop this container, and cannot power-cycle the machine underneath it.", c)
		a.Reason = fmt.Sprintf("Detected a %s container. Rebooting a container is not rebooting its host.", c)
		a.Remedy = fmt.Sprintf(
			"Restart the container from whatever runs it (e.g. `docker restart <name>`), or reboot the host itself. If this is a managed Yaver cloud machine, use pause/wake on the machine — that is VM lifecycle and is a different control from OS reboot.")
		return a
	}

	// WSL: rebooting the distro is not rebooting Windows, and `wsl.exe
	// --shutdown` has to be run from the Windows side, so we cannot do it here.
	if f.WSLVersion > 0 {
		a.Scope = ScopeNone
		a.Means = fmt.Sprintf(
			"This is a WSL%d distribution, not the Windows host. A reboot command here would at best restart the distribution, and would never reboot Windows.", f.WSLVersion)
		a.Reason = fmt.Sprintf("Detected WSL%d. Yaver will not present a WSL distro restart as a machine reboot.", f.WSLVersion)
		a.Remedy = "From Windows (PowerShell or cmd): `wsl.exe --shutdown`, then start the distro again. Or restart just the Yaver agent from here."
		return a
	}

	// Privilege. This is the common case on a real user's Mac or a
	// non-root Linux install, and it is the one that is FIXABLE from here.
	if !f.IsRoot && !f.PasswordlessSudo {
		a.Reason = fmt.Sprintf(
			"The Yaver agent runs as %s without passwordless sudo, so every reboot command it can issue will be refused.", user)
		a.Means = "Would power-cycle this machine — but this agent does not have permission to do it."
		a.Remedy = fmt.Sprintf(
			"Grant reboot permission from Yaver (you supply your sudo password once and Yaver installs a minimal %s rule for the reboot binaries only), or run this on the box:\n%s",
			rebootSudoersPath, sudoersRule(user))
		return a
	}

	a.Available = true
	a.Means = "Power-cycles this machine. It drops off the network and comes back on its own."
	switch f.GOOS {
	case "darwin":
		a.Command = "sudo -n shutdown -r now"
		a.ETASeconds = rebootETADarwinSeconds
	default:
		a.Command = "sudo -n systemctl reboot"
		a.ETASeconds = rebootETALinuxSeconds
	}
	if f.IsRoot {
		a.Command = strings.TrimPrefix(a.Command, "sudo -n ")
	}
	return a
}

// agentRestartAction is the achievable escape hatch. It is what we offer when a
// real reboot is impossible, and it clears the large majority of "my box is
// stuck" states, because the thing that is stuck is usually the agent or one of
// its children — not the kernel.
func agentRestartAction(f PowerFacts) PowerAction {
	a := PowerAction{
		ID:          ActionAgentRestart,
		Label:       "Restart Yaver agent",
		Destructive: true,
		Scope:       ScopeAgent,
		Loses:       agentRestartLoses(),
		ETASeconds:  15,
	}
	switch f.ServiceManager {
	case "launchd":
		a.Available = true
		a.Command = fmt.Sprintf("launchctl kickstart -k gui/%d/io.yaver.agent", f.UID)
		a.Means = "Restarts the Yaver agent through launchd. The machine stays up; everything the agent was running dies and the agent comes straight back."
	case "systemd-user":
		a.Available = true
		a.Command = "systemctl --user restart yaver"
		a.Means = "Restarts the Yaver agent through systemd. The machine stays up; everything the agent was running dies and the agent comes straight back."
	case "systemd-system":
		a.Available = true
		a.Command = "sudo -n systemctl restart yaver"
		if f.IsRoot {
			a.Command = "systemctl restart yaver"
		}
		a.Means = "Restarts the Yaver agent through systemd. The machine stays up; everything the agent was running dies and the agent comes straight back."
	default:
		// No supervisor means nothing will bring the agent back. Stopping it
		// here would take the box offline with no way in — exactly the stuck
		// state this feature exists to prevent. Refuse, and say so.
		a.Means = "Cannot restart the agent: nothing is supervising it, so stopping it would leave this machine unreachable."
		a.Reason = "The agent was not started by launchd or systemd (it looks hand-started, e.g. `yaver serve` in a shell), so no service manager would bring it back."
		a.Remedy = "Install the service unit by running `yaver serve` once on the box (it installs a launchd/systemd unit), then this becomes available."
		a.ETASeconds = 0
	}
	return a
}

func agentShutdownAction(f PowerFacts) PowerAction {
	a := PowerAction{
		ID:          ActionAgentShutdown,
		Label:       "Stop Yaver agent",
		Available:   true,
		Destructive: true,
		Scope:       ScopeAgent,
		Loses:       agentRestartLoses(),
		Means:       "Stops the Yaver agent. This machine goes offline in Yaver and does NOT come back until someone starts it again.",
	}
	if f.ServiceManager == "" {
		a.Remedy = "Nothing is supervising this agent, so it will stay down until someone runs `yaver serve` on the box in person."
	}
	return a
}

// ---------------------------------------------------------------------------
// Probes. Everything below touches the machine; everything above is pure.
// ---------------------------------------------------------------------------

// powerFactsNow probes the real machine. Each probe is bounded or filesystem-
// only — nothing here may hang a headless box.
func powerFactsNow() PowerFacts {
	f := PowerFacts{
		GOOS:      runtime.GOOS,
		IsRoot:    os.Geteuid() == 0,
		AgentUser: currentUsername(),
		UID:       os.Getuid(),
		Container: detectContainerRuntime(),
	}
	// canRebootHost() already probes `sudo -n true` with a 3s timeout and
	// returns true for root. Reuse it rather than growing a second probe that
	// can disagree with the first.
	f.PasswordlessSudo = f.IsRoot || canRebootHost()
	if w := DetectWSL(); w.IsWSL {
		f.WSLVersion = w.Version
		if f.WSLVersion == 0 {
			f.WSLVersion = 1
		}
	}
	f.ServiceManager = detectAgentServiceManager()
	return f
}

// detectContainerRuntime reports which container runtime we are inside, or "".
//
// Filesystem-only on purpose: this is consulted while rendering a device card,
// and shelling out to `docker`/`systemd-detect-virt` on every render would be
// both slow and wrong (a container often has no docker CLI in it).
func detectContainerRuntime() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	// Docker's own marker file. Present in essentially every docker container.
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker"
	}
	// Podman writes /run/.containerenv.
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return "podman"
	}
	// Kubernetes injects the service host into the environment of every pod.
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		return "kubernetes"
	}
	// systemd sets this for anything it launched inside a container, and
	// LXC/LXD set it for the init process.
	if v := strings.TrimSpace(os.Getenv("container")); v != "" {
		return v
	}
	// cgroup paths still name the runtime on cgroup v1 hosts.
	if data, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		s := string(data)
		switch {
		case strings.Contains(s, "/docker/"), strings.Contains(s, "docker-"):
			return "docker"
		case strings.Contains(s, "/lxc/"):
			return "lxc"
		case strings.Contains(s, "kubepods"):
			return "kubernetes"
		}
	}
	return ""
}

// detectAgentServiceManager reports who would bring the agent back if it died.
//
// It checks for the UNIT FILE rather than asking the service manager whether we
// are "active", because the answer has to be the same whether this call happens
// during startup, during a restart, or from a `yaver` CLI invocation that is not
// the daemon at all.
func detectAgentServiceManager() string {
	home, err := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		if err == nil {
			if _, statErr := os.Stat(home + "/Library/LaunchAgents/io.yaver.agent.plist"); statErr == nil {
				return "launchd"
			}
		}
		if _, statErr := os.Stat("/Library/LaunchDaemons/io.yaver.agent.plist"); statErr == nil {
			return "launchd"
		}
		return ""
	}
	if runtime.GOOS != "linux" {
		return ""
	}
	if err == nil {
		for _, unit := range []string{
			home + "/.config/systemd/user/yaver.service",
			home + "/.config/systemd/user/yaver-agent.service",
		} {
			if _, statErr := os.Stat(unit); statErr == nil {
				return "systemd-user"
			}
		}
	}
	for _, unit := range []string{
		"/etc/systemd/system/yaver.service",
		"/etc/systemd/system/yaver-agent.service",
	} {
		if _, statErr := os.Stat(unit); statErr == nil {
			return "systemd-system"
		}
	}
	return ""
}
