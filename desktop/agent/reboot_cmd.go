package main

// `yaver reboot [--machine=<alias|deviceId>] [--check] [--restart-agent] [--yes]`
//
// Reboot is the one machine action you could do from the phone and the web
// dashboard but not from the terminal. It routes through the `infra_power` ops
// verb, so a remote reboot uses the same transport (and the same owner-only
// authorization) as every other remote verb — no SSH hop required.
//
// `--check` is the dry run, and it is the flag to reach for first. It asks the
// TARGET what it could actually do — which is not the same question as "does
// this OS have a reboot command". A Docker container, a WSL distro and a Mac
// running the agent as an ordinary user all answer "no" for three different
// reasons, and only one of them is fixable.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func runReboot(args []string) {
	machine := "local"
	assumeYes := false
	checkOnly := false
	restartAgent := false
	for _, a := range args {
		switch {
		case strings.HasPrefix(a, "--machine="):
			machine = strings.TrimPrefix(a, "--machine=")
		case a == "--yes" || a == "-y":
			assumeYes = true
		case a == "--check" || a == "--dry-run":
			checkOnly = true
		case a == "--restart-agent":
			restartAgent = true
		case a == "--help" || a == "-h":
			printRebootUsage()
			return
		}
	}

	target := machine
	if target == "local" {
		host, _ := os.Hostname()
		target = fmt.Sprintf("this machine (%s)", host)
	}

	token, err := opsLoadToken()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// --check: ask, never act.
	if checkOnly {
		res, err := rebootOpsCall(token, machine, `{"action":"report"}`)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		printPowerReport(target, res)
		return
	}

	action := "host_reboot"
	verb := "Reboot"
	if restartAgent {
		action = "agent_restart"
		verb = "Restart the Yaver agent on"
	}

	// A reboot kills every task, build and runner on the box. Never do that off
	// a bare command with no second look.
	if !assumeYes {
		fmt.Printf("%s %s? Every running task, build and runner on it dies. [y/N] ", verb, target)
		reader := bufio.NewReader(os.Stdin)
		answer, _ := reader.ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
			fmt.Println("Cancelled.")
			return
		}
	}

	res, err := rebootOpsCall(token, machine, fmt.Sprintf(`{"action":%q,"confirm":true}`, action))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if !res.OK {
		fmt.Fprintf(os.Stderr, "%s failed: %s\n", verb, res.Error)
		// The agent refuses with the reason AND the remedy, but a user who hit
		// this deserves the one command that tells them the whole story.
		if res.Code == "reboot_unavailable" || res.Code == "restart_unavailable" {
			fmt.Fprintf(os.Stderr, "\nRun `yaver reboot --machine=%s --check` for the full capability report.\n", machine)
		}
		os.Exit(1)
	}

	// Narrate the wait rather than exiting into silence. The box is about to
	// stop answering, and a user who does not know that reads it as a crash.
	initial, _ := res.Initial.(map[string]interface{})
	note, _ := initial["note"].(string)
	if note == "" {
		note = "Done."
	}
	fmt.Printf("%s\n", note)
	if cmd, ok := initial["command"].(string); ok && cmd != "" {
		fmt.Printf("  ran: %s\n", cmd)
	}
	if machine != "local" {
		fmt.Printf("  watch it come back: yaver ping %s\n", machine)
	}
}

func printRebootUsage() {
	fmt.Println("usage: yaver reboot [--machine=<alias|deviceId>] [--check] [--restart-agent] [--yes]")
	fmt.Println()
	fmt.Println("Reboot a machine. Without --machine, targets THIS machine.")
	fmt.Println()
	fmt.Println("  --check           Dry run: report what power actions the target can ACTUALLY")
	fmt.Println("                    perform, and why not when it cannot. Changes nothing.")
	fmt.Println("  --restart-agent   Restart just the Yaver agent instead of the machine. Works")
	fmt.Println("                    on boxes where a host reboot is impossible (containers, WSL,")
	fmt.Println("                    unprivileged agents) and clears most stuck states.")
	fmt.Println("  --yes, -y         Skip the confirmation prompt.")
	fmt.Println()
	fmt.Println("A host reboot needs root or passwordless sudo on the target. When it does not")
	fmt.Println("have that, --check prints the exact sudoers rule that would grant it.")
}

// rebootOpsCall posts one infra_power payload and decodes the result.
func rebootOpsCall(token, machine, payload string) (*OpsResult, error) {
	req := OpsRequest{
		Verb:    "infra_power",
		Machine: machine,
		Payload: json.RawMessage(payload),
	}
	buf, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	body, status := opsLocalRequest(context.Background(), "POST", "/ops", token, buf)
	if status >= 500 {
		return nil, fmt.Errorf("HTTP %d\n%s", status, string(body))
	}
	var res OpsResult
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, fmt.Errorf("unexpected response: %s", string(body))
	}
	return &res, nil
}

// printPowerReport renders the dry run. Availability first, because that is the
// question the user asked; the reason and the remedy follow, because "no" on its
// own is what made this feature necessary.
func printPowerReport(target string, res *OpsResult) {
	if !res.OK {
		fmt.Fprintf(os.Stderr, "Could not read the power report: %s\n", res.Error)
		os.Exit(1)
	}
	fmt.Printf("Power actions on %s:\n\n", target)

	initial, _ := res.Initial.(map[string]interface{})
	raw, err := json.Marshal(initial["actions"])
	if err != nil {
		fmt.Println("  (no actions reported)")
		return
	}
	var actions []PowerAction
	if err := json.Unmarshal(raw, &actions); err != nil {
		fmt.Println("  (could not decode the action list)")
		return
	}
	for _, a := range actions {
		mark := "not available"
		if a.Available {
			mark = "available"
		}
		fmt.Printf("  %-16s %s\n", a.ID, mark)
		if a.Label != "" {
			fmt.Printf("      %s\n", a.Label)
		}
		if a.Means != "" {
			fmt.Printf("      %s\n", a.Means)
		}
		if a.Available {
			if a.Command != "" {
				fmt.Printf("      would run: %s\n", a.Command)
			}
			if a.ETASeconds > 0 {
				fmt.Printf("      back in:   ~%s\n", humanizeRebootSeconds(a.ETASeconds))
			}
		} else {
			if a.Reason != "" {
				fmt.Printf("      why:    %s\n", a.Reason)
			}
			if a.Remedy != "" {
				fmt.Printf("      fix:    %s\n", strings.ReplaceAll(a.Remedy, "\n", "\n              "))
			}
			if a.Alternative != "" {
				fmt.Printf("      instead: %s\n", a.Alternative)
			}
		}
		fmt.Println()
	}
}
