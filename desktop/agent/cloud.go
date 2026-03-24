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
	fs.String("plan", "cpu", "Machine plan: cpu ($29/mo), pro_cpu ($49/mo), gpu ($299/mo)")
	fs.String("tools", "", "Comma-separated tools: nodejs,python,go,flutter,docker,rust,ruby,java,dotnet,eas")
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

Plans:

  CPU Machine — $29/mo
  • 4 vCPU / 8 GB RAM / 80 GB NVMe — dedicated to you
  • Pre-installed: Node.js, Python, Go, Rust, Docker, Expo CLI, EAS CLI
  • EAS Build: build iOS without a Mac (yaver expo build ios --eas)
  • GitHub/GitLab repo auto-clone
  • Built-in relay server

  Pro CPU Machine — $49/mo
  • 8 vCPU / 16 GB RAM / 160 GB NVMe — dedicated to you
  • Everything in CPU, with double the resources

  GPU Machine — $299/mo
  • Dedicated NVIDIA RTX 4000 (20 GB VRAM)
  • Ollama + Qwen 2.5 Coder 32B pre-loaded — GPT-4o-class coding LLM
  • PersonaPlex 7B pre-loaded — voice AI for hands-free mobile coding
  • Full local AI stack: coding LLM + voice AI + Whisper STT — no API keys, no cost
  • Run additional models (vLLM, Stable Diffusion, any HuggingFace model)

All machines are dedicated — no sharing, no noisy neighbors.
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
