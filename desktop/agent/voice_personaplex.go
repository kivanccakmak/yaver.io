package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	personaplexModelID   = "nvidia/personaplex-7b-v1"
	personaplexModelName = "PersonaPlex 7B v1"
	personaplexPort      = 19838
)

// PersonaPlexProvider implements VoiceProvider for NVIDIA PersonaPlex 7B.
// Free, on-prem speech-to-speech model. Requires NVIDIA GPU (A100/H100)
// or Apple Silicon for MPS inference.
type PersonaPlexProvider struct{}

func (p *PersonaPlexProvider) Name() string { return "personaplex" }

func (p *PersonaPlexProvider) IsAvailable() bool {
	s := p.Status()
	return s.Ready
}

func (p *PersonaPlexProvider) Status() VoiceStatus {
	gpuAvail, gpuName := DetectGPU()
	modelDir := p.modelDir()
	modelExists := p.modelDownloaded(modelDir)

	status := VoiceStatus{
		Provider:     "personaplex",
		GPUAvailable: gpuAvail,
		GPUName:      gpuName,
		ModelPath:    modelDir,
	}

	if !gpuAvail {
		status.Error = "no compatible GPU detected (needs NVIDIA or Apple Silicon)"
		return status
	}

	if !modelExists {
		status.Error = "model not downloaded. Run: yaver voice setup --provider personaplex"
		return status
	}

	// Check if inference server is running
	if p.serverHealthy() {
		status.Ready = true
		status.Endpoint = fmt.Sprintf("http://localhost:%d", personaplexPort)
		status.ModelSize = "7B"
	} else {
		status.Error = "model downloaded but inference server not running. Run: yaver voice serve"
	}

	return status
}

func (p *PersonaPlexProvider) Setup(opts SetupOpts) error {
	modelDir := opts.ModelDir
	if modelDir == "" {
		modelDir = p.modelDir()
	}

	gpuAvail, gpuName := DetectGPU()
	if !gpuAvail {
		return fmt.Errorf("no compatible GPU detected. PersonaPlex requires NVIDIA GPU (A100/H100 recommended) or Apple Silicon.\n" +
			"Consider using 'openai' provider instead: yaver voice setup --provider openai")
	}
	fmt.Printf("GPU detected: %s\n", gpuName)

	if !opts.Force && p.modelDownloaded(modelDir) {
		fmt.Printf("Model already downloaded at %s\n", modelDir)
		fmt.Println("Use --force to re-download.")
		return nil
	}

	// Create model directory
	if err := os.MkdirAll(modelDir, 0755); err != nil {
		return fmt.Errorf("create model dir: %w", err)
	}

	fmt.Printf("Downloading %s from HuggingFace...\n", personaplexModelName)
	fmt.Printf("Model: %s\n", personaplexModelID)
	fmt.Printf("Destination: %s\n", modelDir)
	fmt.Println()

	// Try huggingface-cli first
	if hfPath, err := exec.LookPath("huggingface-cli"); err == nil {
		return p.downloadWithHFCLI(hfPath, modelDir)
	}

	// Try Python huggingface_hub
	if _, err := exec.LookPath("python3"); err == nil {
		return p.downloadWithPython(modelDir)
	}

	// Direct HTTP download fallback
	return p.downloadDirect(modelDir)
}

func (p *PersonaPlexProvider) Transcribe(audioData []byte) (string, error) {
	if !p.serverHealthy() {
		return "", fmt.Errorf("PersonaPlex inference server not running. Run: yaver voice serve")
	}

	// POST audio to local inference server for transcription
	resp, err := http.Post(
		fmt.Sprintf("http://localhost:%d/transcribe", personaplexPort),
		"audio/wav",
		strings.NewReader(string(audioData)),
	)
	if err != nil {
		return "", fmt.Errorf("transcribe request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("transcribe error (%d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.Text, nil
}

func (p *PersonaPlexProvider) StartSession(ctx context.Context, opts VoiceSessionOpts) (*VoiceSession, error) {
	if !p.serverHealthy() {
		return nil, fmt.Errorf("PersonaPlex inference server not running. Run: yaver voice serve")
	}

	// The session connects via WebSocket to the local inference server
	audioIn := make(chan []byte, 64)
	audioOut := make(chan []byte, 64)
	textOut := make(chan string, 64)

	sessionCtx, cancel := context.WithCancel(ctx)

	// Start WebSocket connection to inference server
	go p.streamSession(sessionCtx, audioIn, audioOut, textOut, opts)

	return &VoiceSession{
		SendAudio: func(chunk []byte) error {
			select {
			case audioIn <- chunk:
				return nil
			case <-sessionCtx.Done():
				return sessionCtx.Err()
			}
		},
		RecvAudio: audioOut,
		RecvText:  textOut,
		Close: func() error {
			cancel()
			close(audioIn)
			return nil
		},
	}, nil
}

// streamSession handles the WebSocket connection to the PersonaPlex inference server.
func (p *PersonaPlexProvider) streamSession(ctx context.Context, audioIn <-chan []byte, audioOut chan<- []byte, textOut chan<- string, opts VoiceSessionOpts) {
	defer close(audioOut)
	defer close(textOut)

	// Connect to inference server WebSocket
	endpoint := fmt.Sprintf("ws://localhost:%d/stream", personaplexPort)
	log.Printf("[voice/personaplex] Connecting to %s", endpoint)

	// For now, bridge audio chunks via HTTP streaming until WebSocket is implemented
	// in the Python inference server. Each audio chunk goes to /stream as POST,
	// response audio comes back.
	for {
		select {
		case <-ctx.Done():
			return
		case chunk, ok := <-audioIn:
			if !ok {
				return
			}
			// Forward to inference server
			resp, err := http.Post(
				fmt.Sprintf("http://localhost:%d/stream", personaplexPort),
				"application/octet-stream",
				strings.NewReader(string(chunk)),
			)
			if err != nil {
				log.Printf("[voice/personaplex] Stream error: %v", err)
				continue
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()

			if resp.StatusCode == http.StatusOK && len(body) > 0 {
				// Check if response is JSON (text) or binary (audio)
				var textResp struct {
					Text  string `json:"text,omitempty"`
					Audio []byte `json:"audio,omitempty"`
				}
				if json.Unmarshal(body, &textResp) == nil {
					if textResp.Text != "" {
						textOut <- textResp.Text
					}
					if len(textResp.Audio) > 0 {
						audioOut <- textResp.Audio
					}
				} else {
					audioOut <- body
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Download methods
// ---------------------------------------------------------------------------

func (p *PersonaPlexProvider) downloadWithHFCLI(hfPath, modelDir string) error {
	fmt.Println("Using huggingface-cli for download...")
	cmd := exec.Command(hfPath, "download", personaplexModelID,
		"--local-dir", modelDir,
		"--local-dir-use-symlinks", "False")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("huggingface-cli download failed: %w", err)
	}
	fmt.Println("\nModel downloaded successfully.")
	return nil
}

func (p *PersonaPlexProvider) downloadWithPython(modelDir string) error {
	fmt.Println("Using Python huggingface_hub for download...")
	script := fmt.Sprintf(`
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="%s",
    local_dir="%s",
    local_dir_use_symlinks=False,
)
print("Download complete.")
`, personaplexModelID, modelDir)

	cmd := exec.Command("python3", "-c", script)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("python download failed: %w\nInstall: pip install huggingface_hub", err)
	}
	return nil
}

func (p *PersonaPlexProvider) downloadDirect(modelDir string) error {
	return fmt.Errorf("direct HTTP download not yet implemented.\n" +
		"Install huggingface-cli: pip install huggingface_hub\n" +
		"Then retry: yaver voice setup --provider personaplex")
}

// ---------------------------------------------------------------------------
// Inference server management
// ---------------------------------------------------------------------------

// ServeInference starts the PersonaPlex inference server as a Python subprocess.
func (p *PersonaPlexProvider) ServeInference(ctx context.Context, port int) error {
	modelDir := p.modelDir()
	if !p.modelDownloaded(modelDir) {
		return fmt.Errorf("model not downloaded. Run: yaver voice setup --provider personaplex")
	}

	gpuAvail, gpuName := DetectGPU()
	if !gpuAvail {
		return fmt.Errorf("no GPU detected — PersonaPlex requires NVIDIA GPU or Apple Silicon")
	}

	log.Printf("[voice/personaplex] Starting inference server on port %d (GPU: %s)", port, gpuName)

	// Determine device backend
	device := "cuda"
	if runtime.GOOS == "darwin" {
		device = "mps"
	}

	script := fmt.Sprintf(`
import sys, os, json, struct
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

MODEL_DIR = "%s"
DEVICE = "%s"
PORT = %d

model = None
model_lock = threading.Lock()

def load_model():
    global model
    try:
        from moshi.models import loaders
        model = loaders.load_model(MODEL_DIR, device=DEVICE)
        print(f"[personaplex] Model loaded on {DEVICE}", flush=True)
    except ImportError:
        # Fallback: try transformers
        try:
            from transformers import AutoModel
            model = AutoModel.from_pretrained(MODEL_DIR, trust_remote_code=True)
            model = model.to(DEVICE)
            print(f"[personaplex] Model loaded via transformers on {DEVICE}", flush=True)
        except Exception as e:
            print(f"[personaplex] Failed to load model: {e}", flush=True)
            model = "error"

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            ready = model is not None and model != "error"
            self.wfile.write(json.dumps({"ok": ready, "provider": "personaplex", "device": DEVICE}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/transcribe":
            length = int(self.headers.get("Content-Length", 0))
            audio_data = self.rfile.read(length)
            # Basic transcription via model
            text = self._transcribe(audio_data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"text": text}).encode())
        elif self.path == "/stream":
            length = int(self.headers.get("Content-Length", 0))
            audio_data = self.rfile.read(length)
            response = self._process_audio(audio_data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def _transcribe(self, audio_data):
        if model is None or model == "error":
            return "[model not loaded]"
        with model_lock:
            try:
                # Model-specific transcription
                return "[transcription placeholder — model loaded]"
            except Exception as e:
                return f"[error: {e}]"

    def _process_audio(self, audio_data):
        if model is None or model == "error":
            return {"text": "[model not loaded]", "audio": ""}
        with model_lock:
            try:
                return {"text": "[response placeholder — model loaded]", "audio": ""}
            except Exception as e:
                return {"text": f"[error: {e}]", "audio": ""}

    def log_message(self, format, *args):
        pass  # Suppress request logs

# Load model in background
threading.Thread(target=load_model, daemon=True).start()

print(f"[personaplex] Inference server starting on port {PORT}...", flush=True)
httpd = HTTPServer(("127.0.0.1", PORT), Handler)
httpd.serve_forever()
`, modelDir, device, port)

	cmd := exec.CommandContext(ctx, "python3", "-c", script)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (p *PersonaPlexProvider) modelDir() string {
	return filepath.Join(VoiceModelDir(), "personaplex")
}

func (p *PersonaPlexProvider) modelDownloaded(dir string) bool {
	// Check for common model files
	for _, name := range []string{"config.json", "model.safetensors", "tokenizer.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	// Also check for sharded model files
	matches, _ := filepath.Glob(filepath.Join(dir, "model-*.safetensors"))
	return len(matches) > 0
}

func (p *PersonaPlexProvider) serverHealthy() bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://localhost:%d/health", personaplexPort))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
