package main

// runner_auth_callback_port.go — find the localhost port a runner CLI is waiting
// on for its OAuth callback.
//
// ── Why this is the piece that unlocks remote sign-in ───────────────────────
//
// Every one of these CLIs completes OAuth the same way: it binds a LOOPBACK
// port, sends the user to an authorize URL whose redirect_uri is
// http://localhost:<thatPort>/..., and waits for the browser to come back with
// a code. The redirect_uri is covered by PKCE, so it cannot be rewritten to
// point anywhere else — which is exactly why "just open the URL on your phone"
// fails: the phone's browser redirects to the PHONE's localhost, and the CLI on
// the Mac mini never hears anything.
//
// But `localhost:<port>` is a valid address on BOTH machines. So if the client
// device binds the same port locally and forwards it to the agent, the user can
// sign in in their OWN browser, on their OWN machine, and the redirect lands in
// the CLI that is waiting. No browser on the remote box, no screen streaming,
// no automation, no bot-detection question — and the token minted is the normal
// subscription one, because nothing about the CLI's flow was altered.
//
// This file answers the only question that stands in the way: WHICH port.
//
// ── Why it probes rather than parses ────────────────────────────────────────
//
// Measured 2026-07-26: claude prints nothing at all (verified across pipes, a
// PTY, a real tmux TTY, BROWSER=echo, and the agent's own launchd session), and
// codex login --device-auth is likewise silent. There is no output to read the
// port from. The listening socket, however, is a fact about the process, and
// facts about a process are observable.

import (
	"context"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// loopbackListenRe matches the address column of `lsof -nP -iTCP -sTCP:LISTEN`
// for a loopback bind: 127.0.0.1:54321 or [::1]:54321.
var loopbackListenRe = regexp.MustCompile(`(?:127\.0\.0\.1|\[::1\]):(\d+)`)

// findRunnerCallbackPort returns the loopback port PID (or any of its
// descendants) is listening on, or 0.
//
// Ports are returned highest-first: OAuth helpers take an ephemeral port, and
// when a CLI holds several sockets the ephemeral one is the callback. A stable
// low port is far more likely to be something else the process happens to run.
func findRunnerCallbackPort(ctx context.Context, pid int) int {
	if pid <= 0 {
		return 0
	}
	pids := append([]int{pid}, descendantPIDs(ctx, pid)...)
	var ports []int
	for _, p := range pids {
		ports = append(ports, loopbackListenPorts(ctx, p)...)
	}
	if len(ports) == 0 {
		return 0
	}
	sort.Sort(sort.Reverse(sort.IntSlice(ports)))
	return ports[0]
}

// waitForRunnerCallbackPort polls until the CLI binds its callback socket.
//
// The bind happens AFTER the process starts and often after a keychain probe or
// a network round-trip, so a single check right after spawn reliably finds
// nothing. Returns 0 on timeout — an honest "not found", never a guess, because
// forwarding the wrong port would send the user's browser somewhere silent.
func waitForRunnerCallbackPort(ctx context.Context, pid int, budget time.Duration) int {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return 0
		}
		if port := findRunnerCallbackPort(ctx, pid); port > 0 {
			return port
		}
		time.Sleep(700 * time.Millisecond)
	}
	return 0
}

// loopbackListenPorts lists loopback TCP ports a single PID is listening on.
func loopbackListenPorts(ctx context.Context, pid int) []int {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "lsof", "-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP", "-sTCP:LISTEN")
	// WaitDelay so a wedged lsof cannot hold this goroutine open: a probe that
	// blocks forever is worse than one that returns nothing.
	cmd.WaitDelay = 3 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var ports []int
	seen := map[int]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		for _, m := range loopbackListenRe.FindAllStringSubmatch(line, -1) {
			if p, cerr := strconv.Atoi(m[1]); cerr == nil && p > 0 && !seen[p] {
				seen[p] = true
				ports = append(ports, p)
			}
		}
	}
	return ports
}

// descendantPIDs returns the transitive children of pid.
//
// Needed because a CLI often spawns the listener in a helper: node wrapping a
// binary, or a login subcommand forking. Checking only the direct PID finds
// nothing in exactly the cases that matter.
func descendantPIDs(ctx context.Context, pid int) []int {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "ps", "-Ao", "pid=,ppid=")
	cmd.WaitDelay = 3 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		child, err1 := strconv.Atoi(fields[0])
		parent, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		children[parent] = append(children[parent], child)
	}
	var out2 []int
	queue := []int{pid}
	seen := map[int]bool{pid: true}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, c := range children[cur] {
			if seen[c] {
				continue // a cycle here would hang the agent; ps output is not trusted
			}
			seen[c] = true
			out2 = append(out2, c)
			queue = append(queue, c)
		}
	}
	return out2
}
