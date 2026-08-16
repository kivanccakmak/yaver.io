package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const managedRunnerProtocolVersion = 2

type ManagedRunnerCapabilities struct {
	Git             bool `json:"git"`
	Shell           bool `json:"shell"`
	Docker          bool `json:"docker"`
	Lint            bool `json:"lint"`
	Typecheck       bool `json:"typecheck"`
	Compile         bool `json:"compile"`
	Test            bool `json:"test"`
	BrowserFrames   bool `json:"browserFrames"`
	AndroidEmulator bool `json:"androidEmulator"`
	IOSSimulator    bool `json:"iosSimulator"`
	TVOSSimulator   bool `json:"tvosSimulator"`
	WebRTC          bool `json:"webrtc"`
}

type ManagedRunnerRegistrationRequest struct {
	DeviceID        string                    `json:"deviceId"`
	Name            string                    `json:"name"`
	Platform        string                    `json:"platform"`
	QuicHost        string                    `json:"quicHost"`
	QuicPort        int                       `json:"quicPort"`
	RunnerClass     string                    `json:"runnerClass"`
	Region          string                    `json:"region"`
	AgentVersion    string                    `json:"agentVersion"`
	ProtocolVersion int                       `json:"protocolVersion"`
	Capabilities    ManagedRunnerCapabilities `json:"capabilities"`
}

type ManagedRunnerRegistrationResponse struct {
	DeviceID    string `json:"deviceId"`
	OwnerUserID string `json:"ownerUserId"`
}

func managedRunnerCapabilities() ManagedRunnerCapabilities {
	preview := detectPreviewCapabilities()
	return ManagedRunnerCapabilities{
		Git:             hasBinary("git"),
		Shell:           true,
		Docker:          hasBinary("docker"),
		Lint:            true,
		Typecheck:       true,
		Compile:         true,
		Test:            true,
		BrowserFrames:   preview.Browser,
		AndroidEmulator: preview.Android,
		IOSSimulator:    preview.IOSSimulator,
		TVOSSimulator:   preview.TVOSSimulator,
		WebRTC:          false,
	}
}

func RegisterManagedRunner(baseURL, workloadToken string, registration ManagedRunnerRegistrationRequest) (*ManagedRunnerRegistrationResponse, error) {
	body, err := json.Marshal(registration)
	if err != nil {
		return nil, fmt.Errorf("marshal managed runner registration: %w", err)
	}
	request, err := newBearerRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+"/cloud/runners/register", workloadToken, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("register managed runner: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return nil, fmt.Errorf("managed runner registration failed (status %d): %s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	var result ManagedRunnerRegistrationResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse managed runner registration: %w", err)
	}
	if result.OwnerUserID == "" {
		return nil, fmt.Errorf("managed runner registration omitted owner scope")
	}
	return &result, nil
}

func SendManagedHeartbeat(baseURL, workloadToken, deviceID string, runners []RunnerInfo, quicHost string, capabilities ManagedRunnerCapabilities) error {
	payload := map[string]interface{}{
		"deviceId":        deviceID,
		"runners":         runners,
		"quicHost":        quicHost,
		"agentVersion":    version,
		"protocolVersion": managedRunnerProtocolVersion,
		"capabilities":    capabilities,
	}
	return sendManagedRunnerMutation(baseURL, workloadToken, "/cloud/runners/heartbeat", payload)
}

func MarkManagedRunnerOffline(baseURL, workloadToken, deviceID string) error {
	return sendManagedRunnerMutation(baseURL, workloadToken, "/cloud/runners/offline", map[string]string{"deviceId": deviceID})
}

func sendManagedRunnerMutation(baseURL, workloadToken, path string, payload interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := newBearerRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+path, workloadToken, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return fmt.Errorf("managed runner request failed (status %d): %s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	return nil
}

func managedHeartbeatLoop(ctx context.Context, baseURL, workloadToken, deviceID string, taskManager *TaskManager, capabilities ManagedRunnerCapabilities) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := SendManagedHeartbeat(baseURL, workloadToken, deviceID, taskManager.GetRunnerInfos(), getLocalIP(), capabilities); err != nil {
				log.Printf("[cloud-runner] heartbeat failed: %v", err)
			}
		}
	}
}

func chooseManagedRunner() RunnerConfig {
	for _, id := range []string{"claude", "codex", "opencode", "aider"} {
		runner, ok := builtinRunners[id]
		if !ok {
			continue
		}
		if _, err := os.Stat(runner.Command); err == nil {
			return runner
		}
		if hasBinary(runner.Command) {
			return runner
		}
	}
	return defaultRunner
}

func runCloudRunner(args []string) {
	flags := flag.NewFlagSet("cloud-runner", flag.ExitOnError)
	httpPort := flags.Int("port", 18080, "HTTP server port")
	workDir := flags.String("work-dir", ".", "Controller-provisioned repository root")
	relayPassword := flags.String("relay-password", os.Getenv("YAVER_RELAY_PASSWORD"), "Relay authentication password")
	waitForSession := flags.Bool("wait-for-session", false, "Wait for another runner session to finish")
	dummy := flags.Bool("dummy", false, "Use deterministic fake runner output")
	flags.Parse(args)

	workloadToken := strings.TrimSpace(os.Getenv("YAVER_WORKLOAD_TOKEN"))
	deviceID := strings.TrimSpace(os.Getenv("YAVER_RUNNER_DEVICE_ID"))
	region := strings.TrimSpace(os.Getenv("YAVER_RUNNER_REGION"))
	if workloadToken == "" || deviceID == "" || region == "" {
		log.Fatal("YAVER_WORKLOAD_TOKEN, YAVER_RUNNER_DEVICE_ID, and YAVER_RUNNER_REGION are required")
	}
	convexURL := strings.TrimSpace(os.Getenv("YAVER_CONVEX_SITE_URL"))
	if convexURL == "" {
		convexURL = defaultConvexSiteURL
	}
	runnerClass := runtime.GOOS
	if runnerClass == "darwin" {
		runnerClass = "macos"
	}
	if runnerClass != "linux" && runnerClass != "macos" {
		log.Fatalf("managed Cloud Runners require Linux or macOS, got %s", runtime.GOOS)
	}
	absoluteWorkDir, err := filepath.Abs(*workDir)
	if err != nil {
		log.Fatalf("resolve work dir: %v", err)
	}
	if err := os.MkdirAll(absoluteWorkDir, 0700); err != nil {
		log.Fatalf("create work dir: %v", err)
	}

	if platformConfig, err := FetchPlatformConfig(convexURL); err != nil {
		log.Printf("[cloud-runner] platform config unavailable: %v", err)
	} else {
		LoadRunnersFromBackend(platformConfig.Runners)
		LoadModelsFromBackend(platformConfig.Models)
	}
	runner := chooseManagedRunner()
	capabilities := managedRunnerCapabilities()
	runnerName := strings.TrimSpace(os.Getenv("YAVER_RUNNER_NAME"))
	if runnerName == "" {
		runnerName = "Cloud Runner"
	}
	registration, err := RegisterManagedRunner(convexURL, workloadToken, ManagedRunnerRegistrationRequest{
		DeviceID:        deviceID,
		Name:            runnerName,
		Platform:        runnerClass,
		QuicHost:        getLocalIP(),
		QuicPort:        *httpPort,
		RunnerClass:     runnerClass,
		Region:          region,
		AgentVersion:    version,
		ProtocolVersion: managedRunnerProtocolVersion,
		Capabilities:    capabilities,
	})
	if err != nil {
		log.Fatalf("cloud runner registration: %v", err)
	}

	ensureProjectDiscovery()
	taskStore, err := NewTaskStore()
	if err != nil {
		log.Fatalf("create task store: %v", err)
	}
	taskManager := NewTaskManager(absoluteWorkDir, taskStore, runner)
	taskManager.WaitForSlot = *waitForSession
	taskManager.DummyMode = *dummy
	taskManager.DeviceID = deviceID
	taskManager.Sandbox = DefaultSandboxConfig()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	httpServer := NewHTTPServer(*httpPort, workloadToken, registration.OwnerUserID, deviceID, convexURL, runnerName, taskManager)
	httpServer.operatorMode = true
	httpServer.onShutdown = cancel
	go func() {
		if err := httpServer.Start(ctx); err != nil {
			log.Printf("[cloud-runner] HTTP server stopped: %v", err)
			cancel()
		}
	}()
	go managedHeartbeatLoop(ctx, convexURL, workloadToken, deviceID, taskManager, capabilities)

	if platformConfig, err := FetchPlatformConfig(convexURL); err == nil {
		for _, relay := range platformConfig.RelayServers {
			if relay.QuicAddr == "" {
				continue
			}
			go runRelayTunnel(ctx, relay.QuicAddr, fmt.Sprintf("127.0.0.1:%d", *httpPort), deviceID, workloadToken, *relayPassword, nil, nil)
		}
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case signalValue := <-signals:
		log.Printf("[cloud-runner] received %s", signalValue)
	case <-ctx.Done():
	}
	cancel()
	taskManager.Shutdown()
	if err := MarkManagedRunnerOffline(convexURL, workloadToken, deviceID); err != nil {
		log.Printf("[cloud-runner] offline update failed: %v", err)
	}
}
