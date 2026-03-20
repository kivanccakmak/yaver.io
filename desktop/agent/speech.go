package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// RecordAudio records from the system microphone using sox/ffmpeg.
// Returns the path to the recorded audio file.
// The caller is responsible for cleaning up the file.
func RecordAudio(durationHint string) (string, error) {
	tmpDir := os.TempDir()
	audioPath := filepath.Join(tmpDir, fmt.Sprintf("yaver-voice-%d.wav", time.Now().UnixNano()))

	// Try sox first (most portable), then ffmpeg
	if p, err := exec.LookPath("sox"); err == nil {
		// sox uses "rec" for recording
		recPath := filepath.Join(filepath.Dir(p), "rec")
		if _, err := exec.LookPath("rec"); err == nil {
			recPath = "rec"
		}
		fmt.Println("Recording... Press Ctrl+C to stop.")
		cmd := exec.Command(recPath, audioPath, "rate", "16000", "channels", "1")
		cmd.Stdin = os.Stdin
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			// Ctrl+C triggers an error but the file is still valid
			if _, statErr := os.Stat(audioPath); statErr != nil {
				return "", fmt.Errorf("recording failed: %w", err)
			}
		}
		return audioPath, nil
	}

	if _, err := exec.LookPath("ffmpeg"); err == nil {
		fmt.Println("Recording... Press Ctrl+C to stop.")
		var inputDevice, inputFormat string
		switch runtime.GOOS {
		case "darwin":
			inputDevice = ":0"
			inputFormat = "avfoundation"
		case "linux":
			inputDevice = "default"
			inputFormat = "pulse"
		default:
			return "", fmt.Errorf("ffmpeg recording not supported on %s", runtime.GOOS)
		}
		cmd := exec.Command("ffmpeg", "-y", "-f", inputFormat, "-i", inputDevice,
			"-ar", "16000", "-ac", "1", "-t", "120", audioPath)
		cmd.Stdin = os.Stdin
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			if _, statErr := os.Stat(audioPath); statErr != nil {
				return "", fmt.Errorf("recording failed: %w", err)
			}
		}
		return audioPath, nil
	}

	// macOS: fall back to built-in afrecord (if available in newer macOS)
	if runtime.GOOS == "darwin" {
		return "", fmt.Errorf("no audio recording tool found. Install sox: brew install sox")
	}
	return "", fmt.Errorf("no audio recording tool found. Install sox or ffmpeg")
}

// TranscribeAudio transcribes an audio file using the configured provider.
func TranscribeAudio(audioPath string, cfg *SpeechConfig) (string, error) {
	if cfg == nil {
		return "", fmt.Errorf("speech not configured. Run: yaver config set speech.provider <whisper|openai|deepgram|assemblyai>")
	}

	switch cfg.Provider {
	case "whisper", "on-device":
		return transcribeWhisperLocal(audioPath)
	case "openai":
		if cfg.APIKey == "" {
			return "", fmt.Errorf("OpenAI API key required. Run: yaver config set speech.api_key <key>")
		}
		return transcribeOpenAI(audioPath, cfg.APIKey)
	case "deepgram":
		if cfg.APIKey == "" {
			return "", fmt.Errorf("Deepgram API key required. Run: yaver config set speech.api_key <key>")
		}
		return transcribeDeepgram(audioPath, cfg.APIKey)
	case "assemblyai":
		if cfg.APIKey == "" {
			return "", fmt.Errorf("AssemblyAI API key required. Run: yaver config set speech.api_key <key>")
		}
		return transcribeAssemblyAI(audioPath, cfg.APIKey)
	default:
		return "", fmt.Errorf("unknown speech provider: %s", cfg.Provider)
	}
}

// transcribeWhisperLocal uses a locally installed whisper CLI or whisper.cpp.
func transcribeWhisperLocal(audioPath string) (string, error) {
	// Try whisper.cpp CLI first (most common for local use)
	for _, cmd := range []string{"whisper-cpp", "whisper", "main"} {
		if _, err := exec.LookPath(cmd); err == nil {
			log.Printf("[speech] Using local %s for transcription", cmd)
			out, err := exec.Command(cmd, "-f", audioPath, "--language", "en", "--no-timestamps", "-nt").Output()
			if err != nil {
				// Try without -nt flag (older versions)
				out, err = exec.Command(cmd, "-f", audioPath, "--language", "en").Output()
				if err != nil {
					return "", fmt.Errorf("%s failed: %w", cmd, err)
				}
			}
			return strings.TrimSpace(string(out)), nil
		}
	}

	// Try Python whisper
	if _, err := exec.LookPath("python3"); err == nil {
		out, err := exec.Command("python3", "-c",
			fmt.Sprintf(`import whisper; m=whisper.load_model("tiny.en"); r=m.transcribe("%s"); print(r["text"])`, audioPath),
		).Output()
		if err == nil {
			return strings.TrimSpace(string(out)), nil
		}
	}

	return "", fmt.Errorf("no local whisper installation found. Install whisper.cpp (brew install whisper-cpp) or set a cloud provider")
}

// transcribeOpenAI uses the OpenAI Whisper API.
func transcribeOpenAI(audioPath, apiKey string) (string, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, file); err != nil {
		return "", err
	}
	writer.WriteField("model", "gpt-4o-mini-transcribe")
	writer.WriteField("language", "en")
	writer.Close()

	req, err := http.NewRequest("POST", "https://api.openai.com/v1/audio/transcriptions", &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("OpenAI API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("OpenAI API error (%d): %s", resp.StatusCode, string(body))
	}

	var result struct{ Text string `json:"text"` }
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Text), nil
}

// transcribeDeepgram uses the Deepgram Nova-2 API.
func transcribeDeepgram(audioPath, apiKey string) (string, error) {
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	req, err := http.NewRequest("POST",
		"https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true",
		file)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Token "+apiKey)
	req.Header.Set("Content-Type", "audio/wav")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("Deepgram API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("Deepgram API error (%d): %s", resp.StatusCode, string(body))
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
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Results.Channels) > 0 && len(result.Results.Channels[0].Alternatives) > 0 {
		return strings.TrimSpace(result.Results.Channels[0].Alternatives[0].Transcript), nil
	}
	return "", fmt.Errorf("no transcription result")
}

// transcribeAssemblyAI uses the AssemblyAI API.
func transcribeAssemblyAI(audioPath, apiKey string) (string, error) {
	// Step 1: Upload
	file, err := os.Open(audioPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	uploadReq, err := http.NewRequest("POST", "https://api.assemblyai.com/v2/upload", file)
	if err != nil {
		return "", err
	}
	uploadReq.Header.Set("Authorization", apiKey)

	uploadResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil {
		return "", fmt.Errorf("AssemblyAI upload failed: %w", err)
	}
	defer uploadResp.Body.Close()

	if uploadResp.StatusCode != 200 {
		body, _ := io.ReadAll(uploadResp.Body)
		return "", fmt.Errorf("AssemblyAI upload error (%d): %s", uploadResp.StatusCode, string(body))
	}

	var uploadResult struct{ UploadURL string `json:"upload_url"` }
	json.NewDecoder(uploadResp.Body).Decode(&uploadResult)

	// Step 2: Create transcription
	reqBody, _ := json.Marshal(map[string]string{
		"audio_url":     uploadResult.UploadURL,
		"language_code": "en",
	})
	txReq, _ := http.NewRequest("POST", "https://api.assemblyai.com/v2/transcript", bytes.NewReader(reqBody))
	txReq.Header.Set("Authorization", apiKey)
	txReq.Header.Set("Content-Type", "application/json")

	txResp, err := http.DefaultClient.Do(txReq)
	if err != nil {
		return "", err
	}
	defer txResp.Body.Close()

	var txResult struct{ ID string `json:"id"` }
	json.NewDecoder(txResp.Body).Decode(&txResult)

	// Step 3: Poll for result
	for i := 0; i < 60; i++ {
		time.Sleep(time.Second)
		pollReq, _ := http.NewRequest("GET", "https://api.assemblyai.com/v2/transcript/"+txResult.ID, nil)
		pollReq.Header.Set("Authorization", apiKey)
		pollResp, err := http.DefaultClient.Do(pollReq)
		if err != nil {
			continue
		}
		var pollData struct {
			Status string `json:"status"`
			Text   string `json:"text"`
			Error  string `json:"error"`
		}
		json.NewDecoder(pollResp.Body).Decode(&pollData)
		pollResp.Body.Close()

		if pollData.Status == "completed" {
			return strings.TrimSpace(pollData.Text), nil
		}
		if pollData.Status == "error" {
			return "", fmt.Errorf("AssemblyAI error: %s", pollData.Error)
		}
	}
	return "", fmt.Errorf("AssemblyAI transcription timed out")
}

// SpeakText reads text aloud using the OS TTS engine.
func SpeakText(text string) {
	// Strip markdown for cleaner speech
	text = strings.NewReplacer(
		"#", "", "*", "", "`", "", "_", "", "~", "",
		"[", "", "]", "", "(", "", ")", "",
		"|", "", "\\", "", ">", "",
	).Replace(text)

	switch runtime.GOOS {
	case "darwin":
		cmd := exec.Command("say", text)
		cmd.Run()
	case "linux":
		if _, err := exec.LookPath("espeak"); err == nil {
			exec.Command("espeak", text).Run()
		} else if _, err := exec.LookPath("spd-say"); err == nil {
			exec.Command("spd-say", text).Run()
		}
	}
}
