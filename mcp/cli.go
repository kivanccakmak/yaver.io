package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// deployPlugin packages a directory and sends it to the MCP server.
func deployPlugin(dir, serverURL, password string) error {
	// Validate manifest exists
	manifestPath := filepath.Join(dir, "manifest.json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("manifest.json not found in %s", dir)
	}

	var manifest PluginManifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		return fmt.Errorf("invalid manifest: %v", err)
	}

	fmt.Printf("Deploying %s v%s (%d tools)...\n", manifest.Name, manifest.Version, len(manifest.Tools))

	// Create tar.gz archive
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if rel == "." {
			return nil
		}
		// Skip .git, node_modules
		if info.IsDir() && (info.Name() == ".git" || info.Name() == "node_modules") {
			return filepath.SkipDir
		}

		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = rel

		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}

		if !info.IsDir() {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer f.Close()
			io.Copy(tw, f)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("archive error: %v", err)
	}

	tw.Close()
	gw.Close()

	// Send to server
	req, err := http.NewRequest("POST", serverURL+"/plugins/deploy", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/gzip")
	if password != "" {
		req.Header.Set("Authorization", "Bearer "+password)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach server: %v", err)
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)

	if resp.StatusCode != http.StatusCreated {
		errMsg := "unknown error"
		if e, ok := result["error"].(string); ok {
			errMsg = e
		}
		return fmt.Errorf("deploy failed: %s", errMsg)
	}

	fmt.Printf("Deployed %s (%v tools registered)\n", manifest.Name, result["tools"])
	return nil
}

// listPlugins shows plugins on the MCP server.
func listPlugins(serverURL, password string) error {
	req, _ := http.NewRequest("GET", serverURL+"/plugins", nil)
	if password != "" {
		req.Header.Set("Authorization", "Bearer "+password)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach server: %v", err)
	}
	defer resp.Body.Close()

	var data struct {
		OK      bool                     `json:"ok"`
		Plugins []map[string]interface{} `json:"plugins"`
	}
	json.NewDecoder(resp.Body).Decode(&data)

	if len(data.Plugins) == 0 {
		fmt.Println("No plugins deployed.")
		return nil
	}

	fmt.Printf("Deployed plugins (%d):\n\n", len(data.Plugins))
	fmt.Printf("  %-20s %-10s %-8s %s\n", "NAME", "VERSION", "TOOLS", "STATUS")
	fmt.Printf("  %-20s %-10s %-8s %s\n", "----", "-------", "-----", "------")
	for _, p := range data.Plugins {
		name, _ := p["name"].(string)
		ver, _ := p["version"].(string)
		tools, _ := p["tools"].(float64)
		healthy, _ := p["healthy"].(bool)
		status := "healthy"
		if !healthy {
			status = "unhealthy"
		}
		fmt.Printf("  %-20s %-10s %-8.0f %s\n", name, ver, tools, status)
	}
	return nil
}

// removePlugin removes a plugin from the MCP server.
func removePlugin(name, serverURL, password string) error {
	req, _ := http.NewRequest("DELETE", serverURL+"/plugins?name="+name, nil)
	if password != "" {
		req.Header.Set("Authorization", "Bearer "+password)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach server: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("remove failed (HTTP %d)", resp.StatusCode)
	}

	fmt.Printf("Plugin '%s' removed.\n", name)
	return nil
}

// showStatus shows MCP server status.
func showStatus(port int) error {
	url := fmt.Sprintf("http://localhost:%d/health", port)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var data map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&data)

	fmt.Println("MCP server is UP")
	if v, ok := data["version"]; ok {
		fmt.Printf("  Version:  %v\n", v)
	}
	if u, ok := data["uptime"]; ok {
		fmt.Printf("  Uptime:   %v\n", u)
	}
	if p, ok := data["plugins"]; ok {
		fmt.Printf("  Plugins:  %v\n", p)
	}
	return nil
}
