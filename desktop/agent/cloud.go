package main

import (
	"flag"
	"fmt"
	"os"
)

func runCloud(args []string) {
	if len(args) == 0 {
		printCloudUsage()
		os.Exit(0)
	}

	switch args[0] {
	case "create":
		runCloudCreate(args[1:])
	case "status":
		runCloudStatus()
	case "ssh":
		runCloudSSH()
	case "destroy":
		runCloudDestroy()
	default:
		fmt.Fprintf(os.Stderr, "Unknown cloud subcommand: %s\n\n", args[0])
		printCloudUsage()
		os.Exit(1)
	}
}

func runCloudCreate(args []string) {
	fs := flag.NewFlagSet("cloud create", flag.ExitOnError)
	fs.String("region", "eu", "Server region: eu or us")
	fs.String("tools", "", "Comma-separated tools: nodejs,python,go,flutter,docker,rust,ruby,java,dotnet")
	fs.Parse(args)

	printCloudSubscriptionRequired()
}

func runCloudStatus() {
	fmt.Println("No active cloud machine. Run 'yaver cloud create' first.")
}

func runCloudSSH() {
	fmt.Println("No active cloud machine. Run 'yaver cloud create' first.")
}

func runCloudDestroy() {
	fmt.Println("No active cloud machine. Run 'yaver cloud create' first.")
}

func printCloudSubscriptionRequired() {
	fmt.Print(`Cloud Dev Machines require an active subscription.
Subscribe at https://yaver.io/pricing

What you'll get:
  • 4 vCPU / 8 GB RAM / 80 GB NVMe (ARM64)
  • Pre-installed: Node.js, Python, Go, Docker
  • Your choice of additional tools
  • GitHub/GitLab repo auto-clone
  • Accessible via Yaver mobile app or SSH
  • Acts as your fallback dev machine

Coming soon — sign up at yaver.io to be notified.
`)
}

func printCloudUsage() {
	fmt.Print(`Usage:
  yaver cloud create   Create a cloud dev machine (subscription required)
  yaver cloud status   Show cloud machine status
  yaver cloud ssh      SSH into your cloud machine
  yaver cloud destroy  Tear down your cloud machine

Options for create:
  --region eu|us              Server region (default: eu)
  --tools nodejs,python,...   Additional tools to install
`)
}
