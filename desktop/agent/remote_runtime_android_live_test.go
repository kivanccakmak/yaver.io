package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestLiveAndroidWebRTCClosedLoop(t *testing.T) {
	if os.Getenv("YAVER_LIVE_ANDROID_WEBRTC") != "1" {
		t.Skip("set YAVER_LIVE_ANDROID_WEBRTC=1 to boot an Android target and verify live WebRTC frames")
	}
	targetID := strings.TrimSpace(os.Getenv("YAVER_LIVE_ANDROID_TARGET"))
	if targetID == "" {
		targetID = "android-emulator"
	}
	workDir := strings.TrimSpace(os.Getenv("YAVER_LIVE_WORKDIR"))
	if workDir == "" {
		workDir = filepath.Clean(filepath.Join("..", "..", "mobile"))
	}
	artifactDir := strings.TrimSpace(os.Getenv("YAVER_LIVE_ARTIFACT_DIR"))
	if artifactDir == "" {
		artifactDir = filepath.Join(os.TempDir(), "yaver-webrtc-live")
	}
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		t.Fatalf("artifact dir: %v", err)
	}
	if strings.HasPrefix(targetID, "android-") && targetID != "android-emulator" && targetID != "android-device" {
		t.Setenv("YAVER_REMOTE_RUNTIME_ALL_SURFACES", "1")
	}

	mgr := NewRemoteRuntimeManager()
	session, err := mgr.Create(workDir, "expo", targetID, "direct-webrtc")
	if err != nil {
		t.Fatalf("create %s: %v", targetID, err)
	}
	defer mgr.CloseSession(session.ID)

	clientPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("client PC: %v", err)
	}
	defer clientPC.Close()
	if _, err := clientPC.CreateDataChannel("primer", nil); err != nil {
		t.Fatalf("client primer DC: %v", err)
	}

	frameCh := make(chan []byte, 4)
	eventCh := make(chan string, 16)
	clientPC.OnDataChannel(func(dc *webrtc.DataChannel) {
		chunks := map[string][][]byte{}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			switch dc.Label() {
			case "frames":
				if !msg.IsString {
					select {
					case frameCh <- append([]byte(nil), msg.Data...):
					default:
					}
					return
				}
				if data, ok := decodeJPEGChunk(t, chunks, string(msg.Data)); ok {
					select {
					case frameCh <- data:
					default:
					}
				}
			case "events":
				if msg.IsString {
					select {
					case eventCh <- string(msg.Data):
					default:
					}
				}
			}
		})
	})

	offer, err := clientPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gather := webrtc.GatheringCompletePromise(clientPC)
	if err := clientPC.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local: %v", err)
	}
	<-gather

	updated, answer, err := mgr.ApplyWebRTCOffer(session.ID, *clientPC.LocalDescription())
	if err != nil {
		t.Fatalf("apply offer for %s: %v", targetID, err)
	}
	if err := clientPC.SetRemoteDescription(answer); err != nil {
		t.Fatalf("set remote answer: %v", err)
	}
	t.Logf("session=%s target=%s device=%s transport=%s", updated.ID, updated.TargetID, updated.DeviceID, updated.FrameTransport)

	recordDone := startAndroidScreenRecording(t, context.Background(), updated.DeviceID, artifactDir, targetID)

	var frame []byte
	select {
	case frame = <-frameCh:
	case <-time.After(4 * time.Minute):
		t.Fatalf("no JPEG frame arrived for %s; events=%s", targetID, drainEvents(eventCh))
	}
	if !isProbableLiveJPEG(frame) {
		t.Fatalf("frame for %s is not JPEG: len=%d head=%v", targetID, len(frame), livePrefix(frame, 8))
	}
	if len(frame) < 1024 {
		t.Fatalf("frame for %s too small (%d bytes)", targetID, len(frame))
	}
	framePath := filepath.Join(artifactDir, fmt.Sprintf("%s-%s.jpg", targetID, time.Now().UTC().Format("20060102T150405")))
	if err := os.WriteFile(framePath, frame, 0o644); err != nil {
		t.Fatalf("write frame artifact: %v", err)
	}
	t.Logf("wrote first WebRTC frame: %s (%d bytes)", framePath, len(frame))

	select {
	case err := <-recordDone:
		if err != nil {
			t.Logf("screenrecord artifact failed: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Log("screenrecord artifact still running after frame proof")
	}
}

func decodeJPEGChunk(t *testing.T, chunks map[string][][]byte, raw string) ([]byte, bool) {
	t.Helper()
	var msg struct {
		Type  string `json:"type"`
		ID    string `json:"id"`
		Index int    `json:"index"`
		Total int    `json:"total"`
		Data  string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &msg); err != nil || msg.Type != "jpeg-chunk" || msg.ID == "" || msg.Total <= 0 {
		return nil, false
	}
	part, err := base64.StdEncoding.DecodeString(msg.Data)
	if err != nil {
		t.Fatalf("decode jpeg chunk: %v", err)
	}
	if _, ok := chunks[msg.ID]; !ok {
		chunks[msg.ID] = make([][]byte, msg.Total)
	}
	if msg.Index < 0 || msg.Index >= len(chunks[msg.ID]) {
		t.Fatalf("jpeg chunk index %d outside total %d", msg.Index, msg.Total)
	}
	chunks[msg.ID][msg.Index] = part
	for _, p := range chunks[msg.ID] {
		if p == nil {
			return nil, false
		}
	}
	var out []byte
	for _, p := range chunks[msg.ID] {
		out = append(out, p...)
	}
	delete(chunks, msg.ID)
	return out, true
}

func startAndroidScreenRecording(t *testing.T, ctx context.Context, deviceID, artifactDir, targetID string) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		done <- fmt.Errorf("device id empty")
		return done
	}
	adb, err := exec.LookPath("adb")
	if err != nil {
		done <- fmt.Errorf("adb not on PATH")
		return done
	}
	remotes := []string{
		"/data/local/tmp/yaver-webrtc-live.mp4",
		"/sdcard/yaver-webrtc-live.mp4",
		"/sdcard/Movies/yaver-webrtc-live.mp4",
	}
	local := filepath.Join(artifactDir, fmt.Sprintf("%s-%s.mp4", targetID, time.Now().UTC().Format("20060102T150405")))
	go func() {
		recCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		defer cancel()
		for _, remote := range remotes {
			_ = exec.CommandContext(recCtx, adb, "-s", deviceID, "shell", "rm", "-f", remote).Run()
		}
		remote := remotes[0]
		recOut, recErr := exec.CommandContext(recCtx, adb, "-s", deviceID, "shell", "screenrecord", "--time-limit", "6", remote).CombinedOutput()
		pullCtx, pullCancel := context.WithTimeout(ctx, 20*time.Second)
		defer pullCancel()
		var pullErrors []string
		for _, candidate := range remotes {
			if out, err := exec.CommandContext(pullCtx, adb, "-s", deviceID, "pull", candidate, local).CombinedOutput(); err == nil {
				t.Logf("wrote screen recording: %s", local)
				done <- nil
				return
			} else {
				pullErrors = append(pullErrors, fmt.Sprintf("adb pull %s: %v: %s", candidate, err, strings.TrimSpace(string(out))))
			}
		}
		done <- fmt.Errorf("screenrecord %s: %v: %s; %s",
			remote,
			recErr,
			strings.TrimSpace(string(recOut)),
			strings.Join(pullErrors, "; "))
	}()
	return done
}

func drainEvents(ch <-chan string) string {
	var events []string
	for {
		select {
		case ev := <-ch:
			events = append(events, ev)
		default:
			if len(events) > 8 {
				events = events[len(events)-8:]
			}
			return strings.Join(events, "\n")
		}
	}
}

func isProbableLiveJPEG(b []byte) bool {
	return len(b) >= 4 && b[0] == 0xff && b[1] == 0xd8 && b[len(b)-2] == 0xff && b[len(b)-1] == 0xd9
}

func livePrefix(b []byte, n int) []byte {
	if len(b) < n {
		n = len(b)
	}
	return b[:n]
}
