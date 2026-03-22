package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	osexec "os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Home Assistant
// ---------------------------------------------------------------------------

func mcpHACall(haURL, token, method, path string, body interface{}) interface{} {
	if haURL == "" {
		haURL = "http://homeassistant.local:8123"
	}
	if token == "" {
		return map[string]interface{}{"error": "Home Assistant long-lived access token required. Set via: yaver config set ha.token <token>"}
	}

	var reqBody io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reqBody = strings.NewReader(string(data))
	}

	req, err := http.NewRequest(method, haURL+path, reqBody)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(respBody, &result)
	return result
}

func mcpHAStates(haURL, token, entityFilter string) interface{} {
	result := mcpHACall(haURL, token, "GET", "/api/states", nil)
	if entityFilter == "" {
		return result
	}
	// Filter entities
	if states, ok := result.([]interface{}); ok {
		var filtered []interface{}
		for _, s := range states {
			if m, ok := s.(map[string]interface{}); ok {
				if id, ok := m["entity_id"].(string); ok && strings.Contains(id, entityFilter) {
					filtered = append(filtered, s)
				}
			}
		}
		return map[string]interface{}{"states": filtered, "count": len(filtered)}
	}
	return result
}

func mcpHAService(haURL, token, domain, service string, data map[string]interface{}) interface{} {
	path := fmt.Sprintf("/api/services/%s/%s", domain, service)
	return mcpHACall(haURL, token, "POST", path, data)
}

func mcpHAToggle(haURL, token, entityID string) interface{} {
	domain := strings.SplitN(entityID, ".", 2)[0]
	return mcpHAService(haURL, token, domain, "toggle", map[string]interface{}{"entity_id": entityID})
}

// ---------------------------------------------------------------------------
// Desktop control
// ---------------------------------------------------------------------------

func mcpDesktopNotify(title, message string) interface{} {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`display notification %q with title %q`, message, title)
		_, err := runCmd("osascript", "-e", script)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	case "linux":
		_, err := runCmd("notify-send", title, message)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	case "windows":
		ps := fmt.Sprintf(`[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '%s', '%s', 'Info')`, title, message)
		_, err := runCmd("powershell", "-command", ps)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	}
	return map[string]interface{}{"ok": true}
}

func mcpOpenURL(urlStr string) interface{} {
	var err error
	switch runtime.GOOS {
	case "darwin":
		_, err = runCmd("open", urlStr)
	case "linux":
		_, err = runCmd("xdg-open", urlStr)
	case "windows":
		_, err = runCmd("cmd", "/c", "start", urlStr)
	}
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "url": urlStr}
}

func mcpVolume(action string, level int) interface{} {
	switch runtime.GOOS {
	case "darwin":
		switch action {
		case "get":
			out, _ := runCmd("osascript", "-e", "output volume of (get volume settings)")
			return map[string]interface{}{"volume": out}
		case "set":
			_, err := runCmd("osascript", "-e", fmt.Sprintf("set volume output volume %d", level))
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			return map[string]interface{}{"ok": true, "volume": level}
		case "mute":
			_, err := runCmd("osascript", "-e", "set volume output muted true")
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			return map[string]interface{}{"ok": true, "muted": true}
		case "unmute":
			_, err := runCmd("osascript", "-e", "set volume output muted false")
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			return map[string]interface{}{"ok": true, "muted": false}
		}
	case "linux":
		switch action {
		case "get":
			out, _ := runCmd("amixer", "get", "Master")
			return map[string]interface{}{"volume": out}
		case "set":
			_, err := runCmd("amixer", "set", "Master", fmt.Sprintf("%d%%", level))
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			return map[string]interface{}{"ok": true, "volume": level}
		case "mute":
			_, err := runCmd("amixer", "set", "Master", "mute")
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			return map[string]interface{}{"ok": true, "muted": true}
		case "unmute":
			_, err := runCmd("amixer", "set", "Master", "unmute")
			if err != nil {
				return map[string]interface{}{"error": err.Error()}
			}
			return map[string]interface{}{"ok": true, "muted": false}
		}
	}
	return map[string]interface{}{"error": "unsupported action: " + action}
}

func mcpScreenLock() interface{} {
	switch runtime.GOOS {
	case "darwin":
		runCmd("pmset", "displaysleepnow")
	case "linux":
		runCmd("loginctl", "lock-session")
	case "windows":
		runCmd("rundll32.exe", "user32.dll,LockWorkStation")
	}
	return map[string]interface{}{"ok": true}
}

func mcpSay(text string) interface{} {
	switch runtime.GOOS {
	case "darwin":
		cmd := osexec.Command("say", text)
		cmd.Start()
	case "linux":
		cmd := osexec.Command("espeak", text)
		cmd.Start()
	case "windows":
		ps := fmt.Sprintf(`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('%s')`, text)
		cmd := osexec.Command("powershell", "-command", ps)
		cmd.Start()
	}
	return map[string]interface{}{"ok": true, "text": text}
}

// ---------------------------------------------------------------------------
// Spotify / Music control (macOS via osascript, Linux via playerctl)
// ---------------------------------------------------------------------------

func mcpMusicControl(action string) interface{} {
	switch runtime.GOOS {
	case "darwin":
		var script string
		switch action {
		case "play":
			script = `tell application "Spotify" to play`
		case "pause":
			script = `tell application "Spotify" to pause`
		case "next":
			script = `tell application "Spotify" to next track`
		case "previous":
			script = `tell application "Spotify" to previous track`
		case "now_playing":
			script = `tell application "Spotify" to return name of current track & " - " & artist of current track & " (" & album of current track & ")"`
			out, err := runCmd("osascript", "-e", script)
			if err != nil {
				return map[string]interface{}{"error": "Spotify not running or no track playing"}
			}
			return map[string]interface{}{"now_playing": out}
		default:
			return map[string]interface{}{"error": "action must be: play, pause, next, previous, now_playing"}
		}
		_, err := runCmd("osascript", "-e", script)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"ok": true, "action": action}
	case "linux":
		switch action {
		case "play":
			runCmd("playerctl", "play")
		case "pause":
			runCmd("playerctl", "pause")
		case "next":
			runCmd("playerctl", "next")
		case "previous":
			runCmd("playerctl", "previous")
		case "now_playing":
			out, err := runCmd("playerctl", "metadata", "--format", "{{title}} - {{artist}} ({{album}})")
			if err != nil {
				return map[string]interface{}{"error": "no player running"}
			}
			return map[string]interface{}{"now_playing": out}
		default:
			return map[string]interface{}{"error": "action must be: play, pause, next, previous, now_playing"}
		}
		return map[string]interface{}{"ok": true, "action": action}
	default:
		return map[string]interface{}{"error": "music control not supported on " + runtime.GOOS}
	}
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

func mcpWeather(location string) interface{} {
	if location == "" {
		location = ""
	}
	// Use wttr.in — free, no API key needed
	u := "https://wttr.in/" + url.PathEscape(location) + "?format=j1"
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	// Return a simplified version
	if m, ok := result.(map[string]interface{}); ok {
		if cc, ok := m["current_condition"].([]interface{}); ok && len(cc) > 0 {
			return map[string]interface{}{"current": cc[0], "location": location}
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// System info extras
// ---------------------------------------------------------------------------

func mcpBattery() interface{} {
	switch runtime.GOOS {
	case "darwin":
		out, err := runCmd("pmset", "-g", "batt")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"battery": out}
	case "linux":
		out, err := runCmd("cat", "/sys/class/power_supply/BAT0/capacity")
		if err != nil {
			return map[string]interface{}{"error": "no battery found"}
		}
		status, _ := runCmd("cat", "/sys/class/power_supply/BAT0/status")
		return map[string]interface{}{"percent": strings.TrimSpace(out), "status": strings.TrimSpace(status)}
	default:
		return map[string]interface{}{"error": "not supported on " + runtime.GOOS}
	}
}

func mcpDiskUsage(path string) interface{} {
	if path == "" {
		path = "/"
	}
	out, err := runCmd("df", "-h", path)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"usage": out}
}

func mcpWiFiInfo() interface{} {
	switch runtime.GOOS {
	case "darwin":
		out, err := runCmd("/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-I")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"wifi": out}
	case "linux":
		out, err := runCmd("iwconfig")
		if err != nil {
			out, _ = runCmd("nmcli", "device", "wifi", "list")
		}
		return map[string]interface{}{"wifi": out}
	default:
		return map[string]interface{}{"error": "not supported on " + runtime.GOOS}
	}
}

func mcpPublicIP() interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ipify.org?format=json")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	json.Unmarshal(body, &result)
	return result
}

func mcpUptime() interface{} {
	out, err := runCmd("uptime")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"uptime": out}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

func mcpPasswordGen(length int, noSymbols bool) interface{} {
	if length <= 0 {
		length = 24
	}
	chars := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	if !noSymbols {
		chars += "!@#$%^&*()-_=+[]{}|;:,.<>?"
	}
	password := make([]byte, length)
	for i := range password {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		password[i] = chars[n.Int64()]
	}
	return map[string]interface{}{"password": string(password), "length": length}
}

func mcpQRCode(text string) interface{} {
	// Use qrencode CLI if available, otherwise link to API
	out, err := runCmd("qrencode", "-t", "UTF8", text)
	if err != nil {
		// Fallback: return a URL to generate QR
		return map[string]interface{}{
			"text": text,
			"url":  fmt.Sprintf("https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=%s", url.QueryEscape(text)),
			"note": "Install qrencode for terminal display: brew install qrencode",
		}
	}
	return map[string]interface{}{"qr": out, "text": text}
}

func mcpTimer(seconds int, label string) interface{} {
	if seconds <= 0 {
		seconds = 60
	}
	if label == "" {
		label = "Timer"
	}
	// Run timer in background, send notification when done
	go func() {
		time.Sleep(time.Duration(seconds) * time.Second)
		mcpDesktopNotify(label, fmt.Sprintf("Timer finished (%d seconds)", seconds))
		mcpSay(label + " finished")
	}()
	return map[string]interface{}{
		"ok":      true,
		"seconds": seconds,
		"label":   label,
		"ends_at": time.Now().Add(time.Duration(seconds) * time.Second).Format("15:04:05"),
	}
}

func mcpCalculate(expression string) interface{} {
	// Use bc for calculations
	cmd := osexec.Command("bc", "-l")
	cmd.Stdin = strings.NewReader(expression + "\n")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Fallback to python
		out2, err2 := runCmd("python3", "-c", fmt.Sprintf("print(%s)", expression))
		if err2 != nil {
			return map[string]interface{}{"error": fmt.Sprintf("bc: %s, python3: %s", err, err2)}
		}
		return map[string]interface{}{"result": strings.TrimSpace(out2), "expression": expression}
	}
	return map[string]interface{}{"result": strings.TrimSpace(string(out)), "expression": expression}
}

func mcpWorldClock(timezones []string) interface{} {
	if len(timezones) == 0 {
		timezones = []string{"UTC", "America/New_York", "Europe/London", "Europe/Istanbul", "Asia/Tokyo"}
	}
	clocks := make(map[string]string)
	for _, tz := range timezones {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			clocks[tz] = "invalid timezone"
			continue
		}
		clocks[tz] = time.Now().In(loc).Format("2006-01-02 15:04:05 MST")
	}
	return map[string]interface{}{"clocks": clocks}
}

func mcpCountdown(targetDate string) interface{} {
	formats := []string{"2006-01-02", "2006-01-02 15:04", "2006-01-02T15:04:05Z"}
	var target time.Time
	var err error
	for _, f := range formats {
		target, err = time.Parse(f, targetDate)
		if err == nil {
			break
		}
	}
	if err != nil {
		return map[string]interface{}{"error": "invalid date format. Use: 2006-01-02 or 2006-01-02 15:04"}
	}
	diff := time.Until(target)
	if diff < 0 {
		return map[string]interface{}{"passed": true, "ago": (-diff).String(), "date": targetDate}
	}
	days := int(diff.Hours() / 24)
	hours := int(diff.Hours()) % 24
	mins := int(diff.Minutes()) % 60
	return map[string]interface{}{
		"days":    days,
		"hours":   hours,
		"minutes": mins,
		"total":   diff.String(),
		"date":    targetDate,
	}
}

func mcpSiteCheck(urlStr string) interface{} {
	start := time.Now()
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(urlStr)
	latency := time.Since(start)
	if err != nil {
		return map[string]interface{}{"url": urlStr, "up": false, "error": err.Error()}
	}
	defer resp.Body.Close()
	return map[string]interface{}{
		"url":        urlStr,
		"up":         resp.StatusCode >= 200 && resp.StatusCode < 400,
		"status":     resp.StatusCode,
		"latency_ms": latency.Milliseconds(),
	}
}

// MQTT publish (for IoT/home automation)
func mcpMQTTPublish(broker, topic, message string) interface{} {
	if broker == "" {
		broker = "localhost"
	}
	out, err := runCmd("mosquitto_pub", "-h", broker, "-t", topic, "-m", message)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("mosquitto_pub: %s (install: brew install mosquitto) — %s", err, out)}
	}
	return map[string]interface{}{"ok": true, "topic": topic}
}

func mcpSpeedTest() interface{} {
	// Download a small file and measure speed
	start := time.Now()
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get("https://speed.cloudflare.com/__down?bytes=10000000")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	n, _ := io.Copy(io.Discard, resp.Body)
	duration := time.Since(start)
	mbps := float64(n) * 8 / duration.Seconds() / 1_000_000
	return map[string]interface{}{
		"download_mbps": fmt.Sprintf("%.1f", mbps),
		"bytes":         n,
		"duration":      duration.String(),
	}
}

// Placeholder for brightness — macOS only via brightness CLI
func mcpBrightness(action string, level int) interface{} {
	if runtime.GOOS != "darwin" {
		return map[string]interface{}{"error": "brightness control only supported on macOS"}
	}
	switch action {
	case "get":
		out, err := runCmd("brightness", "-l")
		if err != nil {
			return map[string]interface{}{"error": "install brightness: brew install brightness — " + err.Error()}
		}
		return map[string]interface{}{"brightness": out}
	case "set":
		val := fmt.Sprintf("%.2f", float64(level)/100.0)
		_, err := runCmd("brightness", val)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"ok": true, "level": level}
	default:
		return map[string]interface{}{"error": "action must be 'get' or 'set'"}
	}
}

// Conversion helper
func mcpConvertUnits(value float64, from, to string) interface{} {
	// Temperature
	switch {
	case from == "c" && to == "f":
		return map[string]interface{}{"result": value*9/5 + 32, "from": "°C", "to": "°F"}
	case from == "f" && to == "c":
		return map[string]interface{}{"result": (value - 32) * 5 / 9, "from": "°F", "to": "°C"}
	case from == "km" && to == "mi":
		return map[string]interface{}{"result": value * 0.621371, "from": "km", "to": "mi"}
	case from == "mi" && to == "km":
		return map[string]interface{}{"result": value * 1.60934, "from": "mi", "to": "km"}
	case from == "kg" && to == "lb":
		return map[string]interface{}{"result": value * 2.20462, "from": "kg", "to": "lb"}
	case from == "lb" && to == "kg":
		return map[string]interface{}{"result": value * 0.453592, "from": "lb", "to": "kg"}
	case from == "gb" && to == "mb":
		return map[string]interface{}{"result": value * 1024, "from": "GB", "to": "MB"}
	case from == "mb" && to == "gb":
		return map[string]interface{}{"result": value / 1024, "from": "MB", "to": "GB"}
	case from == "bytes" && to == "human":
		units := []string{"B", "KB", "MB", "GB", "TB"}
		v := value
		i := 0
		for v >= 1024 && i < len(units)-1 {
			v /= 1024
			i++
		}
		return map[string]interface{}{"result": fmt.Sprintf("%.2f %s", v, units[i])}
	default:
		// Try using units CLI
		out, err := runCmd("units", fmt.Sprintf("%g %s", value, from), to)
		if err != nil {
			return map[string]interface{}{"error": fmt.Sprintf("unknown conversion: %s → %s", from, to)}
		}
		return map[string]interface{}{"result": out}
	}
}

// Unused import guard
var _ = strconv.Itoa
