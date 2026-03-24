package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// FeedbackMode determines how feedback is collected.
type FeedbackMode string

const (
	FeedbackModeLive     FeedbackMode = "live"     // stream in real-time, agent comments proactively
	FeedbackModeNarrated FeedbackMode = "narrated" // record + narrate, send when done
	FeedbackModeBatch    FeedbackMode = "batch"    // full dump after testing session
)

// AgentCommentaryLevel controls how proactive the agent is during live feedback.
// 0 = silent, 5 = suggests fixes on obvious issues, 10 = comments on everything it sees.
type AgentCommentaryLevel int

// CapturedError represents an error with stack trace captured by the SDK.
type CapturedError struct {
	Message   string                 `json:"message"`
	Stack     []string               `json:"stack"`
	IsFatal   bool                   `json:"isFatal"`
	Timestamp int64                  `json:"timestamp"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// FeedbackReport represents a visual bug report from device testing.
type FeedbackReport struct {
	ID          string          `json:"id"`
	Source      string          `json:"source"` // "yaver-app" or "in-app-sdk"
	VideoPath   string          `json:"videoPath,omitempty"`
	AudioPath   string          `json:"audioPath,omitempty"`
	Transcript  string          `json:"transcript,omitempty"`
	Screenshots []string        `json:"screenshots,omitempty"`
	Timeline    []TimelineEvent `json:"timeline,omitempty"`
	Errors      []CapturedError `json:"errors,omitempty"`
	DeviceInfo  DeviceFBInfo    `json:"deviceInfo"`
	AppVersion  string          `json:"appVersion,omitempty"`
	BuildID     string          `json:"buildId,omitempty"`
	CreatedAt   string          `json:"createdAt"`
}

// TimelineEvent is a timestamped annotation in a feedback report.
type TimelineEvent struct {
	Time float64 `json:"time"` // seconds from start
	Type string  `json:"type"` // "voice", "screenshot", "annotation", "crash"
	Text string  `json:"text,omitempty"`
	File string  `json:"file,omitempty"`
}

// DeviceFBInfo describes the device that sent the feedback.
type DeviceFBInfo struct {
	Platform  string `json:"platform"`  // ios, android
	Model     string `json:"model"`     // iPhone 16, Pixel 8
	OSVersion string `json:"osVersion"` // 18.2, 15
	AppName   string `json:"appName,omitempty"`
}

// FeedbackSummary is returned by list.
type FeedbackSummary struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	AppVersion string `json:"appVersion,omitempty"`
	Platform   string `json:"platform"`
	HasVideo   bool   `json:"hasVideo"`
	NumScreens int    `json:"numScreenshots"`
	CreatedAt  string `json:"createdAt"`
}

// FeedbackManager stores and manages feedback reports.
type FeedbackManager struct {
	mu      sync.RWMutex
	reports map[string]*FeedbackReport
	baseDir string // ~/.yaver/feedback/
}

// NewFeedbackManager creates a new feedback manager.
func NewFeedbackManager() (*FeedbackManager, error) {
	dir, err := ConfigDir()
	if err != nil {
		return nil, err
	}
	baseDir := filepath.Join(dir, "feedback")
	if err := os.MkdirAll(baseDir, 0700); err != nil {
		return nil, err
	}

	fm := &FeedbackManager{
		reports: make(map[string]*FeedbackReport),
		baseDir: baseDir,
	}

	// Load existing reports from disk
	fm.loadExisting()
	return fm, nil
}

// loadExisting scans the feedback directory for existing reports.
func (fm *FeedbackManager) loadExisting() {
	entries, err := os.ReadDir(fm.baseDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		metaPath := filepath.Join(fm.baseDir, e.Name(), "metadata.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}
		var report FeedbackReport
		if err := json.Unmarshal(data, &report); err != nil {
			continue
		}
		fm.reports[report.ID] = &report
	}
}

// ReceiveFeedback stores a new feedback report with its files.
func (fm *FeedbackManager) ReceiveFeedback(metadata json.RawMessage, files map[string][]byte) (*FeedbackReport, error) {
	var report FeedbackReport
	if err := json.Unmarshal(metadata, &report); err != nil {
		return nil, fmt.Errorf("invalid metadata: %w", err)
	}

	if report.ID == "" {
		report.ID = uuid.New().String()[:8]
	}
	if report.CreatedAt == "" {
		report.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}

	// Create report directory
	reportDir := filepath.Join(fm.baseDir, report.ID)
	if err := os.MkdirAll(reportDir, 0700); err != nil {
		return nil, fmt.Errorf("create dir: %w", err)
	}

	// Save files
	for name, data := range files {
		filePath := filepath.Join(reportDir, name)
		if err := os.WriteFile(filePath, data, 0600); err != nil {
			log.Printf("[feedback] failed to write %s: %v", name, err)
			continue
		}

		// Update report paths
		switch {
		case strings.HasSuffix(name, ".mp4") || strings.HasSuffix(name, ".mov"):
			report.VideoPath = filePath
		case strings.HasSuffix(name, ".m4a") || strings.HasSuffix(name, ".aac") || strings.HasSuffix(name, ".wav"):
			report.AudioPath = filePath
		case strings.HasSuffix(name, ".jpg") || strings.HasSuffix(name, ".png"):
			report.Screenshots = append(report.Screenshots, filePath)
		}
	}

	// Save metadata
	metaData, _ := json.MarshalIndent(report, "", "  ")
	os.WriteFile(filepath.Join(reportDir, "metadata.json"), metaData, 0600)

	fm.mu.Lock()
	fm.reports[report.ID] = &report
	fm.mu.Unlock()

	log.Printf("[feedback] Received report %s: video=%v screenshots=%d", report.ID, report.VideoPath != "", len(report.Screenshots))
	return &report, nil
}

// GetFeedback returns a report by ID.
func (fm *FeedbackManager) GetFeedback(id string) (*FeedbackReport, bool) {
	fm.mu.RLock()
	defer fm.mu.RUnlock()
	r, ok := fm.reports[id]
	return r, ok
}

// ListFeedback returns summaries of all reports.
func (fm *FeedbackManager) ListFeedback() []FeedbackSummary {
	fm.mu.RLock()
	defer fm.mu.RUnlock()

	result := make([]FeedbackSummary, 0, len(fm.reports))
	for _, r := range fm.reports {
		result = append(result, FeedbackSummary{
			ID:         r.ID,
			Source:     r.Source,
			AppVersion: r.AppVersion,
			Platform:   r.DeviceInfo.Platform,
			HasVideo:   r.VideoPath != "",
			NumScreens: len(r.Screenshots),
			CreatedAt:  r.CreatedAt,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].CreatedAt > result[j].CreatedAt
	})
	return result
}

// DeleteFeedback removes a report and its files.
func (fm *FeedbackManager) DeleteFeedback(id string) error {
	fm.mu.Lock()
	defer fm.mu.Unlock()

	if _, ok := fm.reports[id]; !ok {
		return fmt.Errorf("feedback %q not found", id)
	}

	reportDir := filepath.Join(fm.baseDir, id)
	os.RemoveAll(reportDir)
	delete(fm.reports, id)
	return nil
}

// GenerateFixPrompt creates a structured prompt for the AI agent to fix bugs.
func (fm *FeedbackManager) GenerateFixPrompt(id string) (string, error) {
	fm.mu.RLock()
	r, ok := fm.reports[id]
	fm.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("feedback %q not found", id)
	}

	var sb strings.Builder
	sb.WriteString("Bug report from device testing:\n\n")

	// Device info
	sb.WriteString(fmt.Sprintf("Device: %s %s, %s %s\n", r.DeviceInfo.Model, r.DeviceInfo.Platform, r.DeviceInfo.Platform, r.DeviceInfo.OSVersion))
	if r.AppVersion != "" {
		sb.WriteString(fmt.Sprintf("App version: %s\n", r.AppVersion))
	}
	sb.WriteString("\n")

	// Timeline
	if len(r.Timeline) > 0 {
		sb.WriteString("Timeline:\n")
		for _, e := range r.Timeline {
			min := int(e.Time) / 60
			sec := int(e.Time) % 60
			switch e.Type {
			case "voice":
				sb.WriteString(fmt.Sprintf("- %d:%02d — [voice] \"%s\"\n", min, sec, e.Text))
			case "screenshot":
				sb.WriteString(fmt.Sprintf("- %d:%02d — [screenshot] %s\n", min, sec, e.File))
			case "annotation":
				sb.WriteString(fmt.Sprintf("- %d:%02d — [note] %s\n", min, sec, e.Text))
			case "crash":
				sb.WriteString(fmt.Sprintf("- %d:%02d — [CRASH] %s\n", min, sec, e.Text))
			}
		}
		sb.WriteString("\n")
	}

	// Captured errors
	if len(r.Errors) > 0 {
		sb.WriteString("Captured errors:\n")
		for i, e := range r.Errors {
			fatal := ""
			if e.IsFatal {
				fatal = " [FATAL]"
			}
			sb.WriteString(fmt.Sprintf("  Error %d%s: %s\n", i+1, fatal, e.Message))
			for _, frame := range e.Stack {
				sb.WriteString(fmt.Sprintf("    %s\n", frame))
			}
			if len(e.Metadata) > 0 {
				metaJSON, _ := json.Marshal(e.Metadata)
				sb.WriteString(fmt.Sprintf("    context: %s\n", string(metaJSON)))
			}
		}
		sb.WriteString("\n")
	}

	// Transcript
	if r.Transcript != "" {
		sb.WriteString("Voice transcript:\n")
		sb.WriteString(r.Transcript)
		sb.WriteString("\n\n")
	}

	// Screenshots
	if len(r.Screenshots) > 0 {
		sb.WriteString(fmt.Sprintf("Screenshots attached: %d files\n", len(r.Screenshots)))
		for _, s := range r.Screenshots {
			sb.WriteString(fmt.Sprintf("  - %s\n", filepath.Base(s)))
		}
		sb.WriteString("\n")
	}

	// Video
	if r.VideoPath != "" {
		sb.WriteString(fmt.Sprintf("Screen recording: %s\n\n", filepath.Base(r.VideoPath)))
	}

	sb.WriteString("Please fix these issues based on the user's feedback. The user tested the app on their physical device and recorded these problems.\n")
	sb.WriteString("Note: If a live black box stream is active for this device, the full app log context (console logs, navigation history, error traces, network requests) will be included separately.\n")

	return sb.String(), nil
}

// GetFilePath returns the full path to a feedback file.
func (fm *FeedbackManager) GetFilePath(id, filename string) (string, error) {
	reportDir := filepath.Join(fm.baseDir, id)
	filePath := filepath.Join(reportDir, filename)

	// Security: ensure path is within report directory
	absDir, _ := filepath.Abs(reportDir)
	absFile, _ := filepath.Abs(filePath)
	if !strings.HasPrefix(absFile, absDir) {
		return "", fmt.Errorf("invalid path")
	}

	if _, err := os.Stat(filePath); err != nil {
		return "", fmt.Errorf("file not found: %s", filename)
	}
	return filePath, nil
}

// SaveTranscript saves a voice transcript (from whisper.rn STT on mobile).
func (fm *FeedbackManager) SaveTranscript(id, transcript string) error {
	fm.mu.Lock()
	defer fm.mu.Unlock()

	r, ok := fm.reports[id]
	if !ok {
		return fmt.Errorf("feedback %q not found", id)
	}
	r.Transcript = transcript

	// Update metadata on disk
	reportDir := filepath.Join(fm.baseDir, id)
	metaData, _ := json.MarshalIndent(r, "", "  ")
	return os.WriteFile(filepath.Join(reportDir, "metadata.json"), metaData, 0600)
}

// interface check
var _ io.Reader = (*os.File)(nil)
