package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

func runPipeline(args []string) {
	fs := flag.NewFlagSet("pipeline", flag.ExitOnError)
	dir := fs.String("dir", "", "Project directory")
	test := fs.Bool("test", false, "Run tests before deploying")
	deploy := fs.String("deploy", "", "Deploy target: p2p, testflight, playstore, github")
	platform := fs.String("platform", "", "Build platform (auto-detected if not set)")
	workflow := fs.String("workflow", "", "GitHub Actions workflow (for --deploy github)")
	fs.Parse(args)

	if *deploy == "" && !*test {
		printPipelineUsage()
		os.Exit(0)
	}

	workDir := *dir
	if workDir == "" {
		wd, _ := os.Getwd()
		workDir = wd
	}

	// Auto-detect platform
	buildPlatform := *platform
	if buildPlatform == "" {
		buildPlatform = detectBuildPlatform(workDir)
		if buildPlatform == "" {
			fmt.Fprintln(os.Stderr, "Could not auto-detect build platform. Use --platform.")
			os.Exit(1)
		}
		fmt.Printf("Detected platform: %s\n", buildPlatform)
	}

	// Step 1: Build
	fmt.Println("\n=== Step 1: Build ===")
	body := map[string]interface{}{
		"platform": buildPlatform,
		"workDir":  workDir,
		"args":     []string{},
	}
	resp, err := localAgentRequest("POST", "/builds", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Build failed: %v\n", err)
		os.Exit(1)
	}

	var build Build
	remarshal(resp, &build)
	fmt.Printf("Build started: %s (%s)\n", build.ID, build.Platform)

	// Wait for build to complete
	if err := waitForBuild(build.ID); err != nil {
		fmt.Fprintf(os.Stderr, "Build failed: %v\n", err)
		os.Exit(1)
	}

	// Step 2: Test (if --test)
	if *test {
		fmt.Println("\n=== Step 2: Test ===")
		testResp, err := localAgentRequest("POST", "/tests", map[string]interface{}{
			"workDir":  workDir,
			"testType": "unit",
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "Test failed to start: %v\n", err)
			os.Exit(1)
		}

		var ts TestSession
		remarshal(testResp, &ts)
		fmt.Printf("Tests started: %s (%s)\n", ts.ID, ts.Framework)

		if err := waitForTest(ts.ID); err != nil {
			fmt.Fprintf(os.Stderr, "Tests failed: %v\n", err)
			fmt.Fprintln(os.Stderr, "Pipeline stopped. Fix tests and retry.")
			os.Exit(1)
		}
	}

	// Step 3: Deploy
	if *deploy != "" {
		fmt.Println("\n=== Step 3: Deploy ===")
		// Refresh build info to get artifact path
		resp, _ = localAgentRequest("GET", "/builds/"+build.ID, nil)
		remarshal(resp, &build)

		switch *deploy {
		case "p2p":
			if build.ArtifactName != "" {
				fmt.Printf("Artifact ready for P2P transfer: %s (%s)\n", build.ArtifactName, formatSize(build.ArtifactSize))
				fmt.Println("Open Yaver mobile app → Builds → Download & Install")
			} else {
				fmt.Println("No artifact detected. Check build output.")
			}

		case "testflight":
			if build.ArtifactPath == "" {
				fmt.Fprintln(os.Stderr, "No artifact to upload.")
				os.Exit(1)
			}
			fmt.Printf("Uploading to TestFlight: %s\n", build.ArtifactName)
			if err := uploadToTestFlight(build.ArtifactPath); err != nil {
				fmt.Fprintf(os.Stderr, "TestFlight upload failed: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("TestFlight upload complete.")

		case "playstore":
			if build.ArtifactPath == "" {
				fmt.Fprintln(os.Stderr, "No artifact to upload.")
				os.Exit(1)
			}
			fmt.Printf("Uploading to Play Store: %s\n", build.ArtifactName)
			if err := uploadToPlayStore(build.ArtifactPath); err != nil {
				fmt.Fprintf(os.Stderr, "Play Store upload failed: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("Play Store upload complete.")

		case "github":
			wf := *workflow
			if wf == "" {
				wf = "build.yml"
			}
			token := getVaultToken("github-token")
			wd, _ := os.Getwd()
			_, repo := detectRepoFromGit(wd)
			if repo == "" {
				fmt.Fprintln(os.Stderr, "Could not detect GitHub repo. Use --repo.")
				os.Exit(1)
			}
			fmt.Printf("Triggering GitHub Actions: %s/%s\n", repo, wf)
			if err := triggerGitHubWorkflow(token, repo, wf, "main", nil); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("GitHub Actions workflow triggered.")

		default:
			fmt.Fprintf(os.Stderr, "Unknown deploy target: %s\n", *deploy)
			os.Exit(1)
		}
	}

	fmt.Println("\n=== Pipeline complete ===")
}

func waitForBuild(buildID string) error {
	for {
		resp, err := localAgentRequest("GET", "/builds/"+buildID, nil)
		if err != nil {
			return err
		}
		var build Build
		remarshal(resp, &build)

		switch build.Status {
		case BuildStatusCompleted:
			fmt.Printf("Build completed: %s", build.ArtifactName)
			if build.ArtifactSize > 0 {
				fmt.Printf(" (%s)", formatSize(build.ArtifactSize))
			}
			fmt.Println()
			return nil
		case BuildStatusFailed:
			return fmt.Errorf("build failed: %s", build.Error)
		case BuildStatusCancelled:
			return fmt.Errorf("build cancelled")
		}

		time.Sleep(3 * time.Second)
	}
}

func waitForTest(testID string) error {
	for {
		resp, err := localAgentRequest("GET", "/tests/"+testID, nil)
		if err != nil {
			return err
		}
		var ts TestSession
		remarshal(resp, &ts)

		switch ts.Status {
		case TestStatusPassed:
			passed, failed := 0, 0
			if ts.Results != nil {
				passed = ts.Results.Passed
				failed = ts.Results.Failed
			}
			fmt.Printf("Tests passed: %d passed, %d failed\n", passed, failed)
			return nil
		case TestStatusFailed:
			if ts.Results != nil {
				fmt.Printf("Tests failed: %d passed, %d failed\n", ts.Results.Passed, ts.Results.Failed)
				for _, f := range ts.Results.Failures {
					fmt.Printf("  FAIL: %s\n", f.Name)
				}
			}
			return fmt.Errorf("tests failed")
		case TestStatusCancelled:
			return fmt.Errorf("tests cancelled")
		}

		time.Sleep(2 * time.Second)
	}
}

// detectBuildPlatform auto-detects the build platform from project files.
func detectBuildPlatform(workDir string) string {
	checks := []struct {
		file     string
		platform string
	}{
		{"pubspec.yaml", "flutter-apk"},
		{"android/app/build.gradle", "gradle-apk"},
		{"android/app/build.gradle.kts", "gradle-apk"},
		{"ios/Runner.xcodeproj", "xcode-ipa"},
		{"package.json", ""}, // need to check for react-native
	}

	for _, c := range checks {
		if _, err := os.Stat(fmt.Sprintf("%s/%s", workDir, c.file)); err == nil {
			if c.platform != "" {
				return c.platform
			}
			// Check package.json for react-native
			if c.file == "package.json" {
				data, _ := os.ReadFile(fmt.Sprintf("%s/package.json", workDir))
				if len(data) > 0 {
					s := string(data)
					if contains(s, "react-native") {
						return "rn-android"
					}
				}
			}
		}
	}

	return ""
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func printPipelineUsage() {
	fmt.Print(`Usage:
  yaver pipeline [--test] --deploy <target> [--platform <p>] [--dir <path>]

Targets:
  p2p         Transfer artifact to phone via P2P (free, instant)
  testflight  Upload IPA to TestFlight
  playstore   Upload AAB to Play Store (internal track)
  github      Trigger GitHub Actions workflow

Options:
  --test       Run tests before deploying (stops if tests fail)
  --platform   Build platform (auto-detected: flutter-apk, gradle-apk, xcode-ipa, rn-android)
  --dir        Project directory
  --workflow   GitHub Actions workflow filename (default: build.yml)

Example:
  yaver pipeline --test --deploy p2p
  yaver pipeline --deploy testflight --platform flutter-ipa
  yaver pipeline --test --deploy github --workflow release.yml
`)
}
