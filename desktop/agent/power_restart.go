package main

// power_restart.go — restarting the agent, which is what the user usually
// actually wanted.
//
// "Reboot the box" is rarely the goal; "this thing is stuck, un-stick it" is.
// And on most machines the stuck thing is the agent or one of its children, not
// the kernel — while on most machines a real reboot is also the one action we
// are NOT permitted to perform. So the escape hatch that is almost always
// available is the one we did not have: there was an `agent_shutdown` verb that
// stops the agent and leaves the machine offline forever, and no way to bring it
// back from anywhere except physically touching the box.
//
// Shipping a stop with no start is how a remote device ends up stuck. This is
// the missing half.
//
// The safety rule that shapes the whole file: NEVER stop the agent unless
// something will start it again. `agentRestartAction()` refuses when no service
// manager owns us, and this executor re-checks that refusal rather than trusting
// the caller — a phone that is one version behind must not be able to strand a
// machine.

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// infraAgentRestart restarts the agent through whatever supervisor owns it.
//
// Returns the command it ran. The restart itself is asynchronous by nature —
// the supervisor kills this process — so the caller must write its HTTP response
// BEFORE this takes effect, exactly as `agent_shutdown` does.
func infraAgentRestart() (string, error) {
	facts := powerFactsNow()
	action, ok := PowerActionByID(facts, ActionAgentRestart)
	if !ok {
		return "", fmt.Errorf("agent restart is not available on this machine")
	}
	// Re-check the refusal here rather than trusting whoever called us. An older
	// surface that does not know about `available:false` must not be able to
	// stop an unsupervised agent and take the box offline permanently.
	if !action.Available {
		return "", fmt.Errorf("%s %s", action.Reason, action.Remedy)
	}

	parts := strings.Fields(action.Command)
	if len(parts) == 0 {
		return "", fmt.Errorf("no restart command resolved for service manager %q", facts.ServiceManager)
	}

	// Bounded: a wedged systemd or launchd must not hang the handler. The
	// command normally kills us before it returns, so a timeout here is the
	// abnormal path, not the normal one.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("restarting the agent via %s failed: %s", facts.ServiceManager, msg)
	}
	return action.Command, nil
}

// scheduleAgentRestart runs the restart after a short delay, so the HTTP
// response reaches the caller first. Without this the caller only ever sees a
// dropped connection and cannot tell "restarted" from "crashed" — the same
// reason `agent_shutdown` answers before it dies.
func scheduleAgentRestart() {
	go func() {
		time.Sleep(500 * time.Millisecond)
		if _, err := infraAgentRestart(); err != nil {
			// Nothing to report to — the caller is long gone. Make it visible in
			// the log the operator will actually read.
			fmt.Printf("[power] agent restart failed: %v\n", err)
		}
	}()
}
