package main

// feedback_http_json.go — the application/json branch of POST /feedback.
//
// The Kotlin and Swift feedback SDKs serialize their whole report as one
// JSON document with data-URI screenshots (native platforms ship no
// multipart encoder). The multipart-only handler 400'd every report they
// ever filed. This branch accepts that shape, decodes the data URIs into
// the same per-report files the multipart path writes, and hands the
// remaining metadata to the same ReceiveFeedback pipeline — one storage
// layout regardless of which door a report came through.
//
// Accepted shape (kt/swift, superset-tolerant):
//   { id?, source?, screenshots?: ["data:image/jpeg;base64,…", …],
//     video?: "data:video/mp4;base64,…", audio?: "data:…",
//     timeline?, errors?, deviceInfo?, appVersion?, buildId?,
//     note?, createdAt? }
// `note` maps to transcript when no transcript is present — it is the
// user's words, which is what UserWords()/fix prompts read.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// decodeDataURI splits "data:<mime>;base64,<payload>". Returns ok=false
// for anything else — raw strings are not silently guessed at.
func decodeDataURI(s string) (mime string, data []byte, ok bool) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "data:") {
		return "", nil, false
	}
	rest := s[len("data:"):]
	comma := strings.Index(rest, ",")
	if comma < 0 {
		return "", nil, false
	}
	header, payload := rest[:comma], rest[comma+1:]
	if !strings.HasSuffix(header, ";base64") {
		return "", nil, false
	}
	mime = strings.TrimSuffix(header, ";base64")
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || len(raw) == 0 {
		return "", nil, false
	}
	return mime, raw, true
}

func extForMime(mime string) string {
	switch mime {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime":
		return ".mov"
	case "audio/m4a", "audio/mp4", "audio/aac":
		return ".m4a"
	case "audio/wav":
		return ".wav"
	default:
		return ""
	}
}

func (s *HTTPServer) handleFeedbackCreateJSON(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "read body: " + err.Error()})
		return
	}
	var doc map[string]interface{}
	if err := json.Unmarshal(body, &doc); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}

	files := make(map[string][]byte)
	takeDataURI := func(value interface{}, baseName string) {
		str, _ := value.(string)
		mime, data, ok := decodeDataURI(str)
		if !ok {
			return
		}
		ext := extForMime(mime)
		if ext == "" {
			return
		}
		files[baseName+ext] = data
	}

	// Screenshots: array of data URIs → screenshot_N.<ext>. The decoded
	// entries are REMOVED from the metadata so the stored metadata.json
	// doesn't carry megabytes of base64 the files already hold.
	if shots, ok := doc["screenshots"].([]interface{}); ok {
		kept := make([]interface{}, 0, len(shots))
		for i, sv := range shots {
			before := len(files)
			takeDataURI(sv, fmt.Sprintf("screenshot_%d", i))
			if len(files) == before {
				kept = append(kept, sv) // not a data URI — leave as-is
			}
		}
		doc["screenshots"] = kept
	}
	if v, ok := doc["video"]; ok {
		takeDataURI(v, "screen_recording")
		delete(doc, "video")
	}
	if v, ok := doc["audio"]; ok {
		takeDataURI(v, "voice_note")
		delete(doc, "audio")
	}

	// `note` is the user's words. Map to transcript so UserWords() and
	// the fix prompt see it — kt/swift have no separate transcript field.
	if note, ok := doc["note"].(string); ok && strings.TrimSpace(note) != "" {
		if existing, _ := doc["transcript"].(string); strings.TrimSpace(existing) == "" {
			doc["transcript"] = note
		}
	}

	metaJSON, err := json.Marshal(doc)
	if err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "re-encode metadata: " + err.Error()})
		return
	}
	report, err := s.feedbackMgr.ReceiveFeedback(json.RawMessage(metaJSON), files)
	if err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	jsonReply(w, http.StatusOK, report)
}
