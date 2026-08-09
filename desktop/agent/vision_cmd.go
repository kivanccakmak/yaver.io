package main

// vision_cmd.go — `yaver vision` CLI verb. The headless entrypoint to the SAME
// image→text pipeline the MCP tools use (mcp_vision.go): dims → free on-device
// OCR (macOS Vision framework) → optional vision-LLM verdict. The opencode
// yaver-vision plugin shells out here for pasted images, so a text-only model
// (deepseek-v4-flash) can "see" without any opencode-side vision wiring.
//
// Usage:
//
//	yaver vision describe <image> [--question "..."] [--tier free|fast|quality]
//	                          [--provider mistral|openai|anthropic] [--model ...] [--json]
//
// No subcommand → prints the usage block.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func runVision(args []string) {
	if len(args) == 0 {
		fmt.Print(`Yaver vision — local image→text analysis (free-first, on-device)

Usage:
  yaver vision describe <image> [options]
      Analyze an image and print TEXT: on-device OCR (macOS Vision framework,
      $0) plus a semantic verdict when a vision provider is configured.
      <image> = file path, base64:..., data:image/...;base64,..., or URL.
  yaver vision status
      Show which vision capabilities are configured (keys never printed).
  yaver vision extract-pdf <file.pdf>
      Extract text from a PDF via PDFKit.

Options:
  --question "<q>"     What to look for (default: UI/error-text inspection)
  --tier free|fast|quality
                       free = OCR only ($0). fast/quality = OCR + vision LLM.
  --provider <p>       mistral | openai | anthropic (override auto-detect)
  --model <m>          Vision model override (e.g. pixtral-12b-2409, gpt-4o-mini)
  --json               Emit {dims, ocr, verdict, issues, provider, model} as JSON
  --pdf                Treat the input as a PDF and extract its text (PDFKit)

Vision LLM providers are enabled by setting MISTRAL_API_KEY / OPENAI_API_KEY /
ANTHROPIC_API_KEY (optionally YAVER_VISION_PROVIDER / YAVER_VISION_MODEL).
Free OCR works with no key at all on macOS.
`)
		return
	}

	switch args[0] {
	case "describe":
		runVisionDescribe(args[1:])
	case "extract-pdf":
		runVisionPDF(args[1:])
	case "status":
		runVisionStatus()
	default:
		fmt.Fprintf(os.Stderr, "unknown vision verb: %s\n", args[0])
		os.Exit(2)
	}
}

// runVisionStatus reports which vision capabilities are configured — key
// presence only, never the key material itself.
func runVisionStatus() {
	keys := visionKeysFromConfig()
	providers := []string{}
	if os.Getenv("MISTRAL_API_KEY") != "" || keys["mistral"] != "" {
		providers = append(providers, "mistral")
	}
	if os.Getenv("OPENAI_API_KEY") != "" || keys["openai"] != "" {
		providers = append(providers, "openai")
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" || keys["anthropic"] != "" {
		providers = append(providers, "anthropic")
	}
	model := os.Getenv("YAVER_VISION_MODEL")
	if model == "" {
		model = "(default per provider)"
	}
	provider := os.Getenv("YAVER_VISION_PROVIDER")
	if provider == "" && len(providers) > 0 {
		provider = providers[0]
	}

	ocr := "unavailable"
	switch {
	case runtime.GOOS == "darwin":
		ocr = "available (macOS Vision framework, $0)"
	case exec.LookPath("tesseract") == nil:
		ocr = "available (tesseract, $0 — apt install tesseract-ocr)"
	default:
		ocr = "unavailable on this OS — install tesseract-ocr (Linux) or use a vision provider"
	}
	fmt.Printf("Vision status:\n")
	fmt.Printf("  On-device OCR (free): %s\n", ocr)
	if len(providers) > 0 {
		fmt.Printf("  Vision LLM providers configured: %s\n", strings.Join(providers, ", "))
	} else {
		fmt.Printf("  Vision LLM providers configured: none\n")
		fmt.Printf("    Set one with `yaver set vision-key <provider> <key>` (mistral | openai | anthropic)\n")
		fmt.Printf("    or export MISTRAL_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY.\n")
	}
	fmt.Printf("  Active provider: %s\n", defaultString(provider, "none"))
	fmt.Printf("  Model override: %s\n", model)
	fmt.Printf("  Screenshot surfaces: browser (%v), selenium (%v), android (%v), simulator (%v), mac (%v)\n",
		browserMgrAvailable(), seleniumAvailable(), adbAvailable(), simctlAvailable(), runtime.GOOS == "darwin")
}

func browserMgrAvailable() bool {
	return true // BrowserManager is lazy; browser_open starts it.
}

func seleniumAvailable() bool {
	return true
}

func adbAvailable() bool {
	_, err := exec.LookPath("adb")
	return err == nil
}

func simctlAvailable() bool {
	return runtime.GOOS == "darwin"
}

func runVisionDescribe(args []string) {
	var source, question, tier, provider, model string
	asJSON := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
			asJSON = true
		case a == "--question" && i+1 < len(args):
			i++
			question = args[i]
		case a == "--tier" && i+1 < len(args):
			i++
			tier = args[i]
		case a == "--provider" && i+1 < len(args):
			i++
			provider = args[i]
		case a == "--model" && i+1 < len(args):
			i++
			model = args[i]
		case strings.HasPrefix(a, "-"):
			fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
			os.Exit(2)
		default:
			if source == "" {
				source = a
			}
		}
	}
	if source == "" {
		fmt.Fprintln(os.Stderr, "usage: yaver vision describe <image> [--question ...] [--tier free|fast|quality] [--provider ...] [--model ...] [--json]")
		os.Exit(2)
	}

	srv := &HTTPServer{} // only resolveFilePath is used; workdir-less is fine for absolute/URL sources
	path, err := srv.visionSourceToFile(source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yaver vision: %v\n", err)
		os.Exit(1)
	}
	defer os.Remove(path)

	if question == "" {
		question = "Describe what is visible in this image. Include visible text (especially error messages, crash logs, and UI labels), layout, and anything broken or unexpected."
	}
	if tier == "" {
		tier = "fast"
	}

	out := map[string]interface{}{"ok": true}
	if w, h, err := imageDims(path); err == nil {
		out["width"], out["height"] = w, h
	}
	if ocr, err := freeOCR(path); err == nil {
		out["ocr"] = ocr
	} else {
		out["ocr_error"] = err.Error()
	}
	if strings.ToLower(tier) != "free" {
		if cfg, ok := resolvedVisionConfig(provider, model); ok {
			res := inspectWithTimeout(cfg, path, question)
			if res != nil {
				out["provider"] = string(res.Provider)
				out["model"] = res.Model
				out["verdict"] = res.Verdict
				out["issues"] = res.Issues
			}
		} else {
			out["verdict"] = "no_provider"
			out["issues"] = []string{visionProviderHelp}
		}
	}

	if asJSON {
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return
	}
	fmt.Println(describeImageFile(path, question))
}

func runVisionPDF(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: yaver vision extract-pdf <file.pdf>")
		os.Exit(2)
	}
	srv := &HTTPServer{}
	path, err := srv.visionSourceToFile(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "yaver vision: %v\n", err)
		os.Exit(1)
	}
	defer os.Remove(path)
	text, err := macPDFText(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "yaver vision extract-pdf: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(text)
}
