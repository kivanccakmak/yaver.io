package yaver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Transcriber transcribes audio files to text.
type Transcriber struct {
	Config *SpeechConfig
}

// NewTranscriber creates a transcriber with the given config.
func NewTranscriber(cfg *SpeechConfig) *Transcriber {
	return &Transcriber{Config: cfg}
}

// TranscriptionResult holds the result of a transcription.
type TranscriptionResult struct {
	Text       string        `json:"text"`
	Duration   time.Duration `json:"duration"`
	Provider   string        `json:"provider"`
}

// Transcribe transcribes an audio file using the configured provider.
func (t *Transcriber) Transcribe(audioPath string) (*TranscriptionResult, error) {
	if t.Config == nil || t.Config.Provider == "" {
		return nil, fmt.Errorf("speech provider not configured")
	}

	start := time.Now()
	var text string
	var err error

	switch t.Config.Provider {
	case "whisper", "on-device":
		text, err = transcribeLocal(audioPath)
	case "openai":
		text, err = transcribeOpenAISDK(audioPath, t.Config.APIKey)
	case "deepgram":
		text, err = transcribeDeepgramSDK(audioPath, t.Config.APIKey)
	case "assemblyai":
		text, err = transcribeAssemblyAISDK(audioPath, t.Config.APIKey)
	default:
		return nil, fmt.Errorf("unknown speech provider: %s", t.Config.Provider)
	}

	if err != nil {
		return nil, err
	}
	return &TranscriptionResult{
		Text:     text,
		Duration: time.Since(start),
		Provider: t.Config.Provider,
	}, nil
}

// RecordAudio records from the system microphone using sox or ffmpeg.
// Returns the path to the recorded WAV file. Caller must clean up.
func RecordAudio() (string, error) {
	audioPath := filepath.Join(os.TempDir(), fmt.Sprintf("yaver-sdk-%d.wav", time.Now().UnixNano()))

	if _, err := exec.LookPath("rec"); err == nil {
		fmt.Println("Recording... Press Ctrl+C to stop.")
		cmd := exec.Command("rec", audioPath, "rate", "16000", "channels", "1")
		cmd.Stdin = os.Stdin
		cmd.Stderr = os.Stderr
		cmd.Run()
		if _, err := os.Stat(audioPath); err == nil {
			return audioPath, nil
		}
		return "", fmt.Errorf("recording failed")
	}

	if _, err := exec.LookPath("ffmpeg"); err == nil {
		var inputDevice, inputFormat string
		switch runtime.GOOS {
		case "darwin":
			inputDevice, inputFormat = ":0", "avfoundation"
		case "linux":
			inputDevice, inputFormat = "default", "pulse"
		default:
			return "", fmt.Errorf("ffmpeg recording not supported on %s", runtime.GOOS)
		}
		fmt.Println("Recording... Press Ctrl+C to stop.")
		cmd := exec.Command("ffmpeg", "-y", "-f", inputFormat, "-i", inputDevice, "-ar", "16000", "-ac", "1", "-t", "120", audioPath)
		cmd.Stdin = os.Stdin
		cmd.Stderr = os.Stderr
		cmd.Run()
		if _, err := os.Stat(audioPath); err == nil {
			return audioPath, nil
		}
		return "", fmt.Errorf("recording failed")
	}

	return "", fmt.Errorf("no recording tool found — install sox (brew install sox)")
}

// Speak reads text aloud using the OS TTS engine.
func Speak(text string) error {
	clean := strings.NewReplacer("#", "", "*", "", "`", "", "_", "", "~", "", "[", "", "]", "", "(", "", ")", "").Replace(text)

	switch runtime.GOOS {
	case "darwin":
		return exec.Command("say", clean).Run()
	case "linux":
		if _, err := exec.LookPath("espeak"); err == nil {
			return exec.Command("espeak", clean).Run()
		}
		if _, err := exec.LookPath("spd-say"); err == nil {
			return exec.Command("spd-say", clean).Run()
		}
		return fmt.Errorf("no TTS engine found — install espeak")
	default:
		return fmt.Errorf("TTS not supported on %s", runtime.GOOS)
	}
}

// CheckSpeechDeps checks if required speech tools are installed.
func CheckSpeechDeps(cfg *SpeechConfig) map[string]bool {
	deps := map[string]bool{}

	// Recording
	_, err := exec.LookPath("rec")
	deps["sox/rec"] = err == nil
	_, err = exec.LookPath("ffmpeg")
	deps["ffmpeg"] = err == nil
	deps["can_record"] = deps["sox/rec"] || deps["ffmpeg"]

	// Local whisper
	for _, name := range []string{"whisper-cpp", "whisper"} {
		if _, err := exec.LookPath(name); err == nil {
			deps["whisper"] = true
			break
		}
	}

	// TTS
	switch runtime.GOOS {
	case "darwin":
		_, err := exec.LookPath("say")
		deps["tts"] = err == nil
	case "linux":
		_, err1 := exec.LookPath("espeak")
		_, err2 := exec.LookPath("spd-say")
		deps["tts"] = err1 == nil || err2 == nil
	}

	// Cloud (just need API key)
	if cfg != nil {
		deps["has_api_key"] = cfg.APIKey != ""
	}

	return deps
}

// ── Internal transcription functions ─────────────────────────────────

func transcribeLocal(audioPath string) (string, error) {
	for _, cmd := range []string{"whisper-cpp", "whisper"} {
		if _, err := exec.LookPath(cmd); err == nil {
			out, err := exec.Command(cmd, "-f", audioPath, "--language", "en", "--no-timestamps", "-nt").Output()
			if err != nil {
				out, err = exec.Command(cmd, "-f", audioPath, "--language", "en").Output()
				if err != nil {
					return "", fmt.Errorf("%s failed: %w", cmd, err)
				}
			}
			return strings.TrimSpace(string(out)), nil
		}
	}
	return "", fmt.Errorf("whisper not found — install: brew install whisper-cpp")
}

func transcribeOpenAISDK(audioPath, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("OpenAI API key required")
	}
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, _ := writer.CreateFormFile("file", filepath.Base(audioPath))
	io.Copy(part, file)
	writer.WriteField("model", "gpt-4o-mini-transcribe")
	writer.WriteField("language", "en")
	writer.Close()

	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/audio/transcriptions", &buf)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("OpenAI error (%d): %s", resp.StatusCode, string(body))
	}

	var result struct{ Text string `json:"text"` }
	json.NewDecoder(resp.Body).Decode(&result)
	return strings.TrimSpace(result.Text), nil
}

func transcribeDeepgramSDK(audioPath, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("Deepgram API key required")
	}
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	req, _ := http.NewRequest("POST", "https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true", file)
	req.Header.Set("Authorization", "Token "+apiKey)
	req.Header.Set("Content-Type", "audio/wav")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("Deepgram error (%d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Results struct {
			Channels []struct {
				Alternatives []struct {
					Transcript string `json:"transcript"`
				} `json:"alternatives"`
			} `json:"channels"`
		} `json:"results"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if len(result.Results.Channels) > 0 && len(result.Results.Channels[0].Alternatives) > 0 {
		return strings.TrimSpace(result.Results.Channels[0].Alternatives[0].Transcript), nil
	}
	return "", fmt.Errorf("no transcription result")
}

func transcribeAssemblyAISDK(audioPath, apiKey string) (string, error) {
	if apiKey == "" {
		return "", fmt.Errorf("AssemblyAI API key required")
	}
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	// Upload
	uploadReq, _ := http.NewRequest("POST", "https://api.assemblyai.com/v2/upload", file)
	uploadReq.Header.Set("Authorization", apiKey)
	uploadResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil {
		return "", err
	}
	defer uploadResp.Body.Close()
	var upload struct{ UploadURL string `json:"upload_url"` }
	json.NewDecoder(uploadResp.Body).Decode(&upload)

	// Transcribe
	reqBody, _ := json.Marshal(map[string]string{"audio_url": upload.UploadURL, "language_code": "en"})
	txReq, _ := http.NewRequest("POST", "https://api.assemblyai.com/v2/transcript", bytes.NewReader(reqBody))
	txReq.Header.Set("Authorization", apiKey)
	txReq.Header.Set("Content-Type", "application/json")
	txResp, err := http.DefaultClient.Do(txReq)
	if err != nil {
		return "", err
	}
	defer txResp.Body.Close()
	var tx struct{ ID string `json:"id"` }
	json.NewDecoder(txResp.Body).Decode(&tx)

	// Poll
	for i := 0; i < 60; i++ {
		time.Sleep(time.Second)
		pollReq, _ := http.NewRequest("GET", "https://api.assemblyai.com/v2/transcript/"+tx.ID, nil)
		pollReq.Header.Set("Authorization", apiKey)
		pollResp, err := http.DefaultClient.Do(pollReq)
		if err != nil {
			continue
		}
		var poll struct {
			Status string `json:"status"`
			Text   string `json:"text"`
		}
		json.NewDecoder(pollResp.Body).Decode(&poll)
		pollResp.Body.Close()
		if poll.Status == "completed" {
			return strings.TrimSpace(poll.Text), nil
		}
		if poll.Status == "error" {
			return "", fmt.Errorf("AssemblyAI transcription error")
		}
	}
	return "", fmt.Errorf("AssemblyAI timed out")
}
