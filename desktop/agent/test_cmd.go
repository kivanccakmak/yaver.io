package main

import (
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
)

func runTest(args []string) {
	if len(args) == 0 {
		printTestUsage()
		os.Exit(0)
	}

	switch args[0] {
	case "unit":
		runTestUnit(args[1:])
	case "flutter":
		runTestFramework("flutter_test", "flutter test --reporter compact", args[1:])
	case "android":
		runTestAndroid(args[1:])
	case "ios":
		runTestIOS(args[1:])
	case "e2e":
		runTestE2E(args[1:])
	case "list", "ls":
		runTestList()
	case "status":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: yaver test status <id>")
			os.Exit(1)
		}
		runTestStatus(args[1])
	default:
		fmt.Fprintf(os.Stderr, "Unknown test subcommand: %s\n\n", args[0])
		printTestUsage()
		os.Exit(1)
	}
}

func printTestUsage() {
	fmt.Print(`Usage:
  yaver test unit [--dir <path>]      Auto-detect and run unit tests
  yaver test flutter [--dir <path>]   Run Flutter tests
  yaver test android [--dir <path>]   Run Android tests (Gradle + emulator)
  yaver test ios [--dir <path>]       Run iOS tests (Xcode + simulator)
  yaver test e2e [--dir <path>]       Run E2E tests (Playwright/Cypress/Maestro)
  yaver test list                     List test sessions
  yaver test status <id>              Show test results

Auto-detects: Flutter, Jest, Vitest, pytest, Go test, Cargo test,
XCTest, Espresso, Playwright, Cypress, Maestro.
`)
}

func startTestViaAgent(framework, command, workDir, testType string) {
	body := map[string]interface{}{
		"framework": framework,
		"command":   command,
		"workDir":   workDir,
		"testType":  testType,
	}
	resp, err := localAgentRequest("POST", "/tests", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintln(os.Stderr, "Is the agent running? Start with 'yaver serve'.")
		os.Exit(1)
	}

	var ts TestSession
	remarshal(resp, &ts)
	fmt.Printf("Test started: %s (%s)\n", ts.ID, ts.Framework)
	fmt.Printf("  Command: %s\n", ts.Command)
	fmt.Printf("  Type: %s\n", ts.TestType)
	fmt.Println()
	fmt.Printf("  yaver test status %s\n", ts.ID)
}

func runTestUnit(args []string) {
	fs := flag.NewFlagSet("test unit", flag.ExitOnError)
	dir := fs.String("dir", "", "Project directory")
	fs.Parse(args)
	startTestViaAgent("", "", *dir, "unit")
}

func runTestFramework(framework, command string, args []string) {
	fs := flag.NewFlagSet("test "+framework, flag.ExitOnError)
	dir := fs.String("dir", "", "Project directory")
	fs.Parse(args)
	startTestViaAgent(framework, command, *dir, "unit")
}

func runTestAndroid(args []string) {
	fs := flag.NewFlagSet("test android", flag.ExitOnError)
	dir := fs.String("dir", "", "Project directory")
	fs.Parse(args)
	startTestViaAgent("espresso", "", *dir, "unit")
}

func runTestIOS(args []string) {
	fs := flag.NewFlagSet("test ios", flag.ExitOnError)
	dir := fs.String("dir", "", "Project directory")
	fs.Parse(args)
	startTestViaAgent("xctest", "", *dir, "unit")
}

func runTestE2E(args []string) {
	fs := flag.NewFlagSet("test e2e", flag.ExitOnError)
	dir := fs.String("dir", "", "Project directory")
	fs.Parse(args)
	// Auto-detect e2e framework
	startTestViaAgent("", "", *dir, "e2e")
}

func runTestList() {
	resp, err := localAgentRequest("GET", "/tests", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	var sessions []TestSession
	remarshal(resp, &sessions)

	if len(sessions) == 0 {
		fmt.Println("No test sessions. Run 'yaver test unit' to start.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tFRAMEWORK\tSTATUS\tPASSED\tFAILED")
	for _, s := range sessions {
		passed, failed := 0, 0
		if s.Results != nil {
			passed = s.Results.Passed
			failed = s.Results.Failed
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%d\n", s.ID, s.Framework, s.Status, passed, failed)
	}
	w.Flush()
}

func runTestStatus(id string) {
	resp, err := localAgentRequest("GET", "/tests/"+id, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	var ts TestSession
	remarshal(resp, &ts)

	fmt.Printf("Test %s\n", ts.ID)
	fmt.Printf("  Framework: %s\n", ts.Framework)
	fmt.Printf("  Type:      %s\n", ts.TestType)
	fmt.Printf("  Status:    %s\n", ts.Status)
	fmt.Printf("  Command:   %s\n", ts.Command)
	if ts.Results != nil {
		fmt.Printf("  Results:   %d passed, %d failed, %d skipped (%d total)\n",
			ts.Results.Passed, ts.Results.Failed, ts.Results.Skipped, ts.Results.Total)
		if len(ts.Results.Failures) > 0 {
			fmt.Println("  Failures:")
			for _, f := range ts.Results.Failures {
				fmt.Printf("    - %s\n", f.Name)
			}
		}
	}
}
