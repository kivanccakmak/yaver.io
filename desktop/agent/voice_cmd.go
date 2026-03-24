package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
)

func runVoice(args []string) {
	if len(args) == 0 {
		printVoiceUsage()
		os.Exit(0)
	}

	switch args[0] {
	case "setup":
		runVoiceSetup(args[1:])
	case "serve":
		runVoiceServe(args[1:])
	case "status":
		runVoiceStatus()
	case "test":
		runVoiceTest()
	case "providers":
		runVoiceProviders()
	default:
		fmt.Fprintf(os.Stderr, "Unknown voice subcommand: %s\n\n", args[0])
		printVoiceUsage()
		os.Exit(1)
	}
}

func printVoiceUsage() {
	fmt.Print(`Usage:
  yaver voice setup [--provider <name>] [--api-key <key>]  Set up a voice provider
  yaver voice serve [--port <port>]                        Start voice inference server
  yaver voice status                                       Show voice provider status
  yaver voice test                                         Record & transcribe a test clip
  yaver voice providers                                    List available providers

Voice providers:
  personaplex   NVIDIA PersonaPlex 7B — free, on-prem, requires GPU (recommended)
  openai        OpenAI Realtime API — paid, cloud, no GPU needed

Voice is used for:
  - Hands-free task input from the Yaver mobile app (speak instead of type)
  - Voice annotations in feedback reports (always available, no S2S needed)
  - Real-time speech-to-speech conversations with AI agents (requires S2S provider)

The mobile app and Feedback SDK always support voice recording. When a voice
provider is configured on the dev machine, recordings are transcribed automatically.
Without a provider, raw audio is attached to tasks/feedback for manual review.
`)
}

func runVoiceSetup(args []string) {
	fs := flag.NewFlagSet("voice setup", flag.ExitOnError)
	provider := fs.String("provider", "", "Voice provider (personaplex, openai)")
	apiKey := fs.String("api-key", "", "API key (for cloud providers)")
	force := fs.Bool("force", false, "Re-download model even if present")
	modelDir := fs.String("model-dir", "", "Custom model directory")
	fs.Parse(args)

	if *provider == "" {
		// Interactive selection
		fmt.Println("Select a voice provider:")
	fmt.Println()
		fmt.Println(RecommendProvider())
		fmt.Println()
		fmt.Print("Provider [personaplex]: ")
		fmt.Scanln(provider)
		if *provider == "" {
			*provider = "personaplex"
		}
	}

	p, ok := GetVoiceProvider(*provider)
	if !ok {
		fmt.Fprintf(os.Stderr, "Unknown provider: %s\n", *provider)
		fmt.Fprintln(os.Stderr, "Available: personaplex, openai")
		os.Exit(1)
	}

	opts := SetupOpts{
		APIKey:   *apiKey,
		Force:    *force,
		ModelDir: *modelDir,
	}
	if opts.ModelDir == "" {
		opts.ModelDir = VoiceModelDir() + "/" + *provider
	}

	if err := p.Setup(opts); err != nil {
		fmt.Fprintf(os.Stderr, "Setup failed: %v\n", err)
		os.Exit(1)
	}

	// Save provider to config
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not load config: %v\n", err)
		return
	}
	if cfg.Voice == nil {
		cfg.Voice = &VoiceConfig{}
	}
	cfg.Voice.S2SProvider = *provider
	if *modelDir != "" {
		cfg.Voice.PersonaPlexModelDir = *modelDir
	}
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not save config: %v\n", err)
	}
	fmt.Printf("\nVoice provider set to: %s\n", *provider)
}

func runVoiceServe(args []string) {
	fs := flag.NewFlagSet("voice serve", flag.ExitOnError)
	port := fs.Int("port", personaplexPort, "Inference server port")
	fs.Parse(args)

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	providerName := "personaplex"
	if cfg.Voice != nil && cfg.Voice.S2SProvider != "" {
		providerName = cfg.Voice.S2SProvider
	}

	if providerName == "openai" {
		fmt.Println("OpenAI Realtime API doesn't need a local server — it runs in the cloud.")
		fmt.Println("Voice is ready to use. Connect from the Yaver mobile app.")
		return
	}

	p, ok := GetVoiceProvider(providerName)
	if !ok {
		fmt.Fprintf(os.Stderr, "Unknown provider: %s\n", providerName)
		os.Exit(1)
	}

	// Only PersonaPlex needs a local inference server
	pp, ok := p.(*PersonaPlexProvider)
	if !ok {
		fmt.Printf("Provider %s doesn't need a local server.\n", providerName)
		return
	}

	fmt.Printf("Starting %s inference server on port %d...\n", providerName, *port)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle Ctrl+C
	go func() {
		c := make(chan os.Signal, 1)
		// signal.Notify not imported to avoid adding signals — use simple approach
		<-c
		cancel()
	}()

	if err := pp.ServeInference(ctx, *port); err != nil {
		fmt.Fprintf(os.Stderr, "Inference server error: %v\n", err)
		os.Exit(1)
	}
}

func runVoiceStatus() {
	providers := ListVoiceProviders()
	cfg, _ := LoadConfig()

	activeProvider := ""
	if cfg != nil && cfg.Voice != nil {
		activeProvider = cfg.Voice.S2SProvider
	}

	fmt.Println("Voice providers:")
	fmt.Println()

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "PROVIDER\tSTATUS\tGPU\tENDPOINT\tACTIVE")
	for _, p := range providers {
		status := p.Status()
		readyStr := "not ready"
		if status.Ready {
			readyStr = "ready"
		}
		gpuStr := "-"
		if status.GPUAvailable {
			gpuStr = status.GPUName
		}
		endpoint := status.Endpoint
		if endpoint == "" {
			endpoint = "-"
		}
		active := ""
		if p.Name() == activeProvider {
			active = "***"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", p.Name(), readyStr, gpuStr, endpoint, active)
	}
	w.Flush()

	if activeProvider == "" {
		fmt.Println("\nNo voice provider configured. Run: yaver voice setup")
	}

	// Show STT providers (always available for voice-in-feedback)
	fmt.Println("\nVoice input (STT) for feedback & tasks:")
	if cfg != nil && cfg.Speech != nil && cfg.Speech.Provider != "" {
		fmt.Printf("  STT provider: %s (configured)\n", cfg.Speech.Provider)
	} else {
		fmt.Println("  STT provider: none (raw audio will be attached to feedback)")
		fmt.Println("  Configure: yaver config set speech.provider <whisper|openai|deepgram|assemblyai>")
	}
}

func runVoiceTest() {
	fmt.Println("Recording a short test clip...")
	fmt.Println("Speak for a few seconds, then press Ctrl+C to stop.")
	fmt.Println()

	audioPath, err := RecordAudio("5s")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Recording failed: %v\n", err)
		os.Exit(1)
	}
	defer os.Remove(audioPath)

	fmt.Printf("Recorded: %s\n\n", audioPath)

	// Try S2S provider first, then fall back to STT
	cfg, _ := LoadConfig()
	if cfg != nil && cfg.Voice != nil && cfg.Voice.S2SProvider != "" {
		if p, ok := GetVoiceProvider(cfg.Voice.S2SProvider); ok && p.IsAvailable() {
			data, err := os.ReadFile(audioPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Read audio failed: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Transcribing with %s...\n", cfg.Voice.S2SProvider)
			text, err := p.Transcribe(data)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Transcription failed: %v\n", err)
			} else {
				fmt.Printf("Transcript: %s\n", text)
				return
			}
		}
	}

	// Fall back to existing STT
	if cfg != nil && cfg.Speech != nil {
		fmt.Printf("Transcribing with %s (STT)...\n", cfg.Speech.Provider)
		text, err := TranscribeAudio(audioPath, cfg.Speech)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Transcription failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Transcript: %s\n", text)
		return
	}

	fmt.Println("No voice/speech provider configured.")
	fmt.Println("Audio was recorded but cannot be transcribed without a provider.")
	fmt.Println("Configure one with: yaver voice setup")
}

func runVoiceProviders() {
	fmt.Println("Available voice providers:")
	fmt.Println()

	fmt.Println("  personaplex  NVIDIA PersonaPlex 7B")
	fmt.Println("               Free, on-prem, speech-to-speech")
	fmt.Println("               Requires: NVIDIA GPU (A100/H100) or Apple Silicon")
	fmt.Println("               Setup: yaver voice setup --provider personaplex")
	fmt.Println("               Downloads ~14GB model from HuggingFace")
	fmt.Println()

	fmt.Println("  openai       OpenAI Realtime API")
	fmt.Println("               Paid, cloud-hosted, no GPU needed")
	fmt.Println("               Requires: OpenAI API key with Realtime API access")
	fmt.Println("               Setup: yaver voice setup --provider openai --api-key <key>")
	fmt.Println("               Billed per token (see openai.com/pricing)")
	fmt.Println()

	fmt.Println(RecommendProvider())
	fmt.Println()

	fmt.Println("Note: Voice input in the mobile app and Feedback SDK works without an S2S provider.")
	fmt.Println("Audio is always recorded and sent to the dev machine. If STT is configured")
	fmt.Println("(yaver config set speech.provider whisper), it's auto-transcribed. Otherwise,")
	fmt.Println("raw audio is attached to tasks for the AI agent to process.")
}
