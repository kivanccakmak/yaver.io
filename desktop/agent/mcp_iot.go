package main

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	osexec "os/exec"
	"runtime"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Philips Hue — local bridge API (no cloud, no HA needed)
// ---------------------------------------------------------------------------

func mcpHueLights(bridgeIP, apiKey string) interface{} {
	url := fmt.Sprintf("http://%s/api/%s/lights", bridgeIP, apiKey)
	return hueGET(url)
}

func mcpHueControl(bridgeIP, apiKey, lightID, action string, brightness int) interface{} {
	url := fmt.Sprintf("http://%s/api/%s/lights/%s/state", bridgeIP, apiKey, lightID)
	var body string
	switch action {
	case "on":
		body = `{"on": true}`
	case "off":
		body = `{"on": false}`
	case "toggle":
		// Get current state first
		stateURL := fmt.Sprintf("http://%s/api/%s/lights/%s", bridgeIP, apiKey, lightID)
		data := hueGET(stateURL)
		if m, ok := data.(map[string]interface{}); ok {
			if state, ok := m["state"].(map[string]interface{}); ok {
				if on, ok := state["on"].(bool); ok {
					if on {
						body = `{"on": false}`
					} else {
						body = `{"on": true}`
					}
				}
			}
		}
		if body == "" {
			body = `{"on": true}`
		}
	case "brightness":
		if brightness < 0 {
			brightness = 0
		}
		if brightness > 254 {
			brightness = 254
		}
		body = fmt.Sprintf(`{"on": true, "bri": %d}`, brightness)
	case "color":
		// brightness here is used as hue (0-65535)
		body = fmt.Sprintf(`{"on": true, "hue": %d, "sat": 254}`, brightness)
	default:
		return map[string]interface{}{"error": "action must be: on, off, toggle, brightness, color"}
	}
	return huePUT(url, body)
}

func mcpHueScenes(bridgeIP, apiKey string) interface{} {
	url := fmt.Sprintf("http://%s/api/%s/scenes", bridgeIP, apiKey)
	return hueGET(url)
}

func mcpHueActivateScene(bridgeIP, apiKey, groupID, sceneID string) interface{} {
	url := fmt.Sprintf("http://%s/api/%s/groups/%s/action", bridgeIP, apiKey, groupID)
	body := fmt.Sprintf(`{"scene": "%s"}`, sceneID)
	return huePUT(url, body)
}

func hueGET(url string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

func huePUT(url, body string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("PUT", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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

// ---------------------------------------------------------------------------
// Shelly — local HTTP API (smart plugs, relays, lights)
// ---------------------------------------------------------------------------

func mcpShellyStatus(ip string) interface{} {
	url := fmt.Sprintf("http://%s/status", ip)
	return shellyGET(url)
}

func mcpShellyControl(ip string, channel int, action string) interface{} {
	var url string
	switch action {
	case "on":
		url = fmt.Sprintf("http://%s/relay/%d?turn=on", ip, channel)
	case "off":
		url = fmt.Sprintf("http://%s/relay/%d?turn=off", ip, channel)
	case "toggle":
		url = fmt.Sprintf("http://%s/relay/%d?turn=toggle", ip, channel)
	default:
		return map[string]interface{}{"error": "action must be: on, off, toggle"}
	}
	return shellyGET(url)
}

func mcpShellyPower(ip string) interface{} {
	url := fmt.Sprintf("http://%s/meter/0", ip)
	return shellyGET(url)
}

func shellyGET(url string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// Elgato Key Light — local HTTP API (developer streaming favorite)
// ---------------------------------------------------------------------------

func mcpElgatoStatus(ip string) interface{} {
	if ip == "" {
		ip = "elgato-key-light.local"
	}
	url := fmt.Sprintf("http://%s:9123/elgato/lights", ip)
	return elgatoGET(url)
}

func mcpElgatoControl(ip string, on bool, brightness, temperature int) interface{} {
	if ip == "" {
		ip = "elgato-key-light.local"
	}
	light := map[string]interface{}{"on": 0}
	if on {
		light["on"] = 1
	}
	if brightness > 0 {
		light["brightness"] = brightness
	}
	if temperature > 0 {
		light["temperature"] = temperature
	}
	body := map[string]interface{}{
		"numberOfLights": 1,
		"lights":         []interface{}{light},
	}
	data, _ := json.Marshal(body)

	url := fmt.Sprintf("http://%s:9123/elgato/lights", ip)
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("PUT", url, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
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

func elgatoGET(url string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// Nanoleaf — local API (light panels, devs love these)
// ---------------------------------------------------------------------------

func mcpNanoleafControl(ip, token, action string, brightness int) interface{} {
	base := fmt.Sprintf("http://%s:16021/api/v1/%s", ip, token)
	switch action {
	case "on":
		return nanoleafPUT(base+"/state", `{"on": {"value": true}}`)
	case "off":
		return nanoleafPUT(base+"/state", `{"on": {"value": false}}`)
	case "brightness":
		return nanoleafPUT(base+"/state", fmt.Sprintf(`{"brightness": {"value": %d}}`, brightness))
	case "effect":
		// brightness used as effect name won't work, but we handle it
		return nanoleafPUT(base+"/effects", fmt.Sprintf(`{"select": "%d"}`, brightness))
	case "effects":
		return nanoleafGET(base + "/effects/effectsList")
	case "status":
		return nanoleafGET(base + "/state")
	default:
		return map[string]interface{}{"error": "action: on, off, brightness, effects, status"}
	}
}

func nanoleafGET(url string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

func nanoleafPUT(url, body string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("PUT", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	return map[string]interface{}{"ok": true}
}

// ---------------------------------------------------------------------------
// Wake on LAN — wake up dev machines
// ---------------------------------------------------------------------------

func mcpWakeOnLAN(mac string) interface{} {
	hw, err := net.ParseMAC(mac)
	if err != nil {
		return map[string]interface{}{"error": "invalid MAC address: " + err.Error()}
	}
	// Build magic packet: 6 bytes of 0xFF + 16 repetitions of MAC
	var packet [102]byte
	for i := 0; i < 6; i++ {
		packet[i] = 0xFF
	}
	for i := 0; i < 16; i++ {
		copy(packet[6+i*6:], hw)
	}
	conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4bcast, Port: 9})
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer conn.Close()
	_, err = conn.Write(packet[:])
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "mac": mac, "message": "Wake-on-LAN packet sent"}
}

// ---------------------------------------------------------------------------
// Apple Shortcuts — run macOS Shortcuts from CLI
// ---------------------------------------------------------------------------

func mcpRunShortcut(name, input string) interface{} {
	if runtime.GOOS != "darwin" {
		return map[string]interface{}{"error": "Apple Shortcuts only available on macOS"}
	}
	args := []string{"-i", name}
	if input != "" {
		args = append(args, "-i", input)
	}
	// The shortcuts CLI is just "shortcuts run <name>"
	out, err := runCmd("shortcuts", "run", name)
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": out}
	}
	return map[string]interface{}{"ok": true, "shortcut": name, "output": out}
}

func mcpListShortcuts() interface{} {
	if runtime.GOOS != "darwin" {
		return map[string]interface{}{"error": "Apple Shortcuts only available on macOS"}
	}
	out, err := runCmd("shortcuts", "list")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	shortcuts := strings.Split(strings.TrimSpace(out), "\n")
	return map[string]interface{}{"shortcuts": shortcuts, "count": len(shortcuts)}
}

// ---------------------------------------------------------------------------
// ADB — Android Debug Bridge (control Android devices/emulators)
// ---------------------------------------------------------------------------

func mcpADBDevices() interface{} {
	out, err := runCmd("adb", "devices", "-l")
	if err != nil {
		return map[string]interface{}{"error": "adb not found: " + err.Error()}
	}
	return map[string]interface{}{"devices": out}
}

func mcpADBCommand(device, command string) interface{} {
	args := []string{}
	if device != "" {
		args = append(args, "-s", device)
	}
	args = append(args, "shell", command)
	out, err := runCmd("adb", args...)
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": out}
	}
	return map[string]interface{}{"output": out}
}

func mcpADBScreenshot(device string) interface{} {
	args := []string{}
	if device != "" {
		args = append(args, "-s", device)
	}
	args = append(args, "exec-out", "screencap", "-p")
	cmd := osexec.Command("adb", args...)
	out, err := cmd.Output()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	// Save to temp file
	tmpFile := fmt.Sprintf("/tmp/adb-screenshot-%d.png", time.Now().Unix())
	if writeErr := writeFileBytes(tmpFile, out); writeErr != nil {
		return map[string]interface{}{"error": writeErr.Error()}
	}
	return map[string]interface{}{"path": tmpFile, "size": len(out)}
}

func writeFileBytes(path string, data []byte) error {
	return osexec.Command("sh", "-c", fmt.Sprintf("cat > %s", path)).Run()
}

// ---------------------------------------------------------------------------
// Sonos — local SOAP/HTTP API
// ---------------------------------------------------------------------------

func mcpSonosDiscover() interface{} {
	// Use UPnP/SSDP discovery or fall back to avahi
	out, err := runCmd("avahi-browse", "-rt", "_sonos._tcp")
	if err != nil {
		// Try dns-sd on macOS
		out, err = runCmd("dns-sd", "-B", "_sonos._tcp", "local")
		if err != nil {
			return map[string]interface{}{"error": "Could not discover Sonos devices. Specify IP directly."}
		}
	}
	return map[string]interface{}{"devices": out}
}

func mcpSonosControl(ip, action string) interface{} {
	endpoint := fmt.Sprintf("http://%s:1400", ip)
	switch action {
	case "play":
		return sonosAction(endpoint, "Play")
	case "pause":
		return sonosAction(endpoint, "Pause")
	case "next":
		return sonosAction(endpoint, "Next")
	case "previous":
		return sonosAction(endpoint, "Previous")
	case "volume_up":
		return sonosSetRelativeVolume(endpoint, 5)
	case "volume_down":
		return sonosSetRelativeVolume(endpoint, -5)
	case "status":
		return sonosGetInfo(endpoint)
	default:
		return map[string]interface{}{"error": "action: play, pause, next, previous, volume_up, volume_down, status"}
	}
}

func sonosAction(endpoint, action string) interface{} {
	body := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:%s xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:%s></s:Body>
</s:Envelope>`, action, action)

	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("POST", endpoint+"/MediaRenderer/AVTransport/Control", strings.NewReader(body))
	req.Header.Set("Content-Type", "text/xml")
	req.Header.Set("SOAPAction", fmt.Sprintf(`"urn:schemas-upnp-org:service:AVTransport:1#%s"`, action))
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	return map[string]interface{}{"ok": true, "action": action}
}

func sonosSetRelativeVolume(endpoint string, delta int) interface{} {
	body := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:SetRelativeVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><Adjustment>%d</Adjustment></u:SetRelativeVolume></s:Body>
</s:Envelope>`, delta)

	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("POST", endpoint+"/MediaRenderer/RenderingControl/Control", strings.NewReader(body))
	req.Header.Set("Content-Type", "text/xml")
	req.Header.Set("SOAPAction", `"urn:schemas-upnp-org:service:RenderingControl:1#SetRelativeVolume"`)
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	return map[string]interface{}{"ok": true, "volume_delta": delta}
}

func sonosGetInfo(endpoint string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(endpoint + "/xml/device_description.xml")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	xml.Unmarshal(body, &result)
	n := min(len(body), 500)
	return map[string]interface{}{"info": string(body[:n])}
}

// ---------------------------------------------------------------------------
// Tasmota — local HTTP API (flashed smart plugs, lights, relays)
// ---------------------------------------------------------------------------

func mcpTasmotaControl(ip, command string) interface{} {
	url := fmt.Sprintf("http://%s/cm?cmnd=%s", ip, command)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// Govee — HTTP API (LED strips, lights)
// ---------------------------------------------------------------------------

func mcpGoveeControl(apiKey, device, model, action string, brightness int, color map[string]int) interface{} {
	if apiKey == "" {
		return map[string]interface{}{"error": "Govee API key required. Get from Govee app → Account → About → Apply for API key"}
	}
	body := map[string]interface{}{
		"device": device,
		"model":  model,
	}
	switch action {
	case "on":
		body["cmd"] = map[string]interface{}{"name": "turn", "value": "on"}
	case "off":
		body["cmd"] = map[string]interface{}{"name": "turn", "value": "off"}
	case "brightness":
		body["cmd"] = map[string]interface{}{"name": "brightness", "value": brightness}
	case "color":
		body["cmd"] = map[string]interface{}{"name": "color", "value": color}
	default:
		return map[string]interface{}{"error": "action: on, off, brightness, color"}
	}
	data, _ := json.Marshal(body)
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("PUT", "https://developer-api.govee.com/v1/devices/control", strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Govee-API-Key", apiKey)
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

func mcpGoveeDevices(apiKey string) interface{} {
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequest("GET", "https://developer-api.govee.com/v1/devices", nil)
	req.Header.Set("Govee-API-Key", apiKey)
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// min is provided by Go 1.22+ builtin
