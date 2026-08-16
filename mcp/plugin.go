package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// PluginManifest describes a plugin's metadata.
type PluginManifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description"`
	Runtime     string   `json:"runtime"`  // "binary", "node", "python"
	Command     string   `json:"command"`  // e.g. "./my-plugin", "main.py"
	Build       string   `json:"build"`    // optional build command
	Env         []string `json:"env"`      // allowed env vars
	Tools       []map[string]interface{} `json:"tools"` // tool definitions
}

// Plugin represents a loaded plugin subprocess.
type Plugin struct {
	Manifest PluginManifest
	Dir      string
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stdout   *bufio.Reader
	mu       sync.Mutex
	healthy  bool
}

// PluginManager manages plugin lifecycle.
type PluginManager struct {
	mu      sync.RWMutex
	plugins map[string]*Plugin
	dir     string
}

// NewPluginManager creates a new plugin manager.
func NewPluginManager(dir string) *PluginManager {
	return &PluginManager{
		plugins: make(map[string]*Plugin),
		dir:     dir,
	}
}

// LoadAll loads all plugins from the plugins directory.
func (pm *PluginManager) LoadAll() {
	entries, err := os.ReadDir(pm.dir)
	if err != nil {
		return
	}

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		manifestPath := filepath.Join(pm.dir, e.Name(), "manifest.json")
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			continue
		}

		var manifest PluginManifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			log.Printf("[plugin] Invalid manifest in %s: %v", e.Name(), err)
			continue
		}

		pluginDir := filepath.Join(pm.dir, e.Name())
		if err := pm.startPlugin(manifest, pluginDir); err != nil {
			log.Printf("[plugin] Failed to start %s: %v", manifest.Name, err)
		} else {
			log.Printf("[plugin] Loaded %s v%s (%d tools)", manifest.Name, manifest.Version, len(manifest.Tools))
		}
	}
}

// startPlugin starts a plugin subprocess.
func (pm *PluginManager) startPlugin(manifest PluginManifest, dir string) error {
	var cmdPath string
	var cmdArgs []string

	switch manifest.Runtime {
	case "binary", "":
		cmdPath = filepath.Join(dir, manifest.Command)
		if _, err := os.Stat(cmdPath); err != nil {
			// Try building first
			if manifest.Build != "" {
				buildCmd := exec.Command("sh", "-c", manifest.Build)
				buildCmd.Dir = dir
				if out, err := buildCmd.CombinedOutput(); err != nil {
					return fmt.Errorf("build failed: %v\n%s", err, out)
				}
			}
		}
	case "python":
		cmdPath = "python3"
		cmdArgs = []string{filepath.Join(dir, manifest.Command)}
	case "node":
		cmdPath = "node"
		cmdArgs = []string{filepath.Join(dir, manifest.Command)}
	default:
		return fmt.Errorf("unsupported runtime: %s", manifest.Runtime)
	}

	cmd := exec.Command(cmdPath, cmdArgs...)
	cmd.Dir = dir

	// Only pass allowed env vars
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	for _, key := range manifest.Env {
		if val := os.Getenv(key); val != "" {
			cmd.Env = append(cmd.Env, key+"="+val)
		}
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start failed: %v", err)
	}

	plugin := &Plugin{
		Manifest: manifest,
		Dir:      dir,
		cmd:      cmd,
		stdin:    stdin,
		stdout:   bufio.NewReader(stdout),
		healthy:  true,
	}

	// Send initialize
	initReq := JSONRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
		Params:  json.RawMessage(`{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"yaver-mcp","version":"` + version + `"}}`),
	}
	if _, err := plugin.call(initReq); err != nil {
		cmd.Process.Kill()
		return fmt.Errorf("initialize failed: %v", err)
	}

	pm.mu.Lock()
	pm.plugins[manifest.Name] = plugin
	pm.mu.Unlock()

	return nil
}

// call sends a JSON-RPC request to a plugin and returns the response.
func (p *Plugin) call(req JSONRPCRequest) (*JSONRPCResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	data, _ := json.Marshal(req)
	data = append(data, '\n')

	if _, err := p.stdin.Write(data); err != nil {
		p.healthy = false
		return nil, err
	}

	line, err := p.stdout.ReadBytes('\n')
	if err != nil {
		p.healthy = false
		return nil, err
	}

	var resp JSONRPCResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, err
	}

	return &resp, nil
}

// CallTool calls a tool on the appropriate plugin.
func (pm *PluginManager) CallTool(name string, args json.RawMessage) (interface{}, bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	for _, plugin := range pm.plugins {
		for _, tool := range plugin.Manifest.Tools {
			toolName, _ := tool["name"].(string)
			if toolName == name {
				req := JSONRPCRequest{
					JSONRPC: "2.0",
					ID:      time.Now().UnixNano(),
					Method:  "tools/call",
					Params:  json.RawMessage(fmt.Sprintf(`{"name":%q,"arguments":%s}`, name, string(args))),
				}
				resp, err := plugin.call(req)
				if err != nil {
					return map[string]interface{}{
						"content": []map[string]interface{}{
							{"type": "text", "text": fmt.Sprintf("plugin error: %v", err)},
						},
						"isError": true,
					}, true
				}
				if resp.Result != nil {
					return resp.Result, true
				}
				return map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": "plugin returned no result"},
					},
				}, true
			}
		}
	}

	return nil, false
}

// AllTools returns tool definitions from all plugins.
func (pm *PluginManager) AllTools() []map[string]interface{} {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	var tools []map[string]interface{}
	for _, plugin := range pm.plugins {
		tools = append(tools, plugin.Manifest.Tools...)
	}
	return tools
}

// List returns info about all plugins.
func (pm *PluginManager) List() []map[string]interface{} {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	var list []map[string]interface{}
	for _, p := range pm.plugins {
		list = append(list, map[string]interface{}{
			"name":        p.Manifest.Name,
			"version":     p.Manifest.Version,
			"description": p.Manifest.Description,
			"tools":       len(p.Manifest.Tools),
			"healthy":     p.healthy,
		})
	}
	return list
}

// Count returns the number of loaded plugins.
func (pm *PluginManager) Count() int {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return len(pm.plugins)
}

// Remove stops and removes a plugin.
func (pm *PluginManager) Remove(name string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	plugin, ok := pm.plugins[name]
	if !ok {
		return fmt.Errorf("plugin not found: %s", name)
	}

	if plugin.cmd != nil && plugin.cmd.Process != nil {
		plugin.cmd.Process.Kill()
	}
	delete(pm.plugins, name)

	// Remove directory
	os.RemoveAll(plugin.Dir)
	log.Printf("[plugin] Removed %s", name)
	return nil
}

// StopAll stops all plugins.
func (pm *PluginManager) StopAll() {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for name, plugin := range pm.plugins {
		if plugin.cmd != nil && plugin.cmd.Process != nil {
			plugin.cmd.Process.Kill()
		}
		log.Printf("[plugin] Stopped %s", name)
	}
}

// Deploy deploys a plugin from a tar.gz archive.
func (pm *PluginManager) Deploy(archive []byte) (string, int, error) {
	// Create temp dir, extract, validate manifest, move to plugins dir
	tmpDir, err := os.MkdirTemp("", "yaver-mcp-plugin-")
	if err != nil {
		return "", 0, err
	}
	defer os.RemoveAll(tmpDir)

	// Extract tar.gz
	gr, err := gzip.NewReader(strings.NewReader(string(archive)))
	if err != nil {
		// Try as raw tar
		return "", 0, fmt.Errorf("invalid archive: %v", err)
	}
	defer gr.Close()

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", 0, fmt.Errorf("tar error: %v", err)
		}

		target := filepath.Join(tmpDir, hdr.Name)
		if hdr.Typeflag == tar.TypeDir {
			os.MkdirAll(target, 0755)
		} else {
			os.MkdirAll(filepath.Dir(target), 0755)
			f, err := os.Create(target)
			if err != nil {
				return "", 0, err
			}
			io.Copy(f, tr)
			f.Close()
			if hdr.Mode&0111 != 0 {
				os.Chmod(target, 0755)
			}
		}
	}

	// Read manifest
	manifestData, err := os.ReadFile(filepath.Join(tmpDir, "manifest.json"))
	if err != nil {
		return "", 0, fmt.Errorf("manifest.json not found in archive")
	}

	var manifest PluginManifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		return "", 0, fmt.Errorf("invalid manifest: %v", err)
	}

	if manifest.Name == "" {
		return "", 0, fmt.Errorf("manifest missing 'name' field")
	}

	// Stop existing plugin if running
	pm.Remove(manifest.Name)

	// Move to plugins directory
	destDir := filepath.Join(pm.dir, manifest.Name)
	os.RemoveAll(destDir)
	if err := os.Rename(tmpDir, destDir); err != nil {
		return "", 0, fmt.Errorf("install failed: %v", err)
	}

	// Start the plugin
	if err := pm.startPlugin(manifest, destDir); err != nil {
		return manifest.Name, 0, fmt.Errorf("plugin installed but failed to start: %v", err)
	}

	return manifest.Name, len(manifest.Tools), nil
}
