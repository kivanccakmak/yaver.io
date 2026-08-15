package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type PreviewStatus struct {
	ProjectSessionID string `json:"projectSessionId"`
	Framework        string `json:"framework,omitempty"`
	Kind             string `json:"kind"`
	Running          bool   `json:"running"`
	Serving          bool   `json:"serving"`
	ServingLabel     string `json:"servingLabel,omitempty"`
	Port             int    `json:"port,omitempty"`
	PreviewHealth    struct {
		State  string `json:"state"`
		Reason string `json:"reason,omitempty"`
	} `json:"previewHealth"`
}

type previewProcess struct {
	projectSessionID string
	framework        string
	port             int
	cmd              *exec.Cmd
	done             chan struct{}
	mu               sync.RWMutex
	running          bool
	exitReason       string
	logs             []string
}

func (p *previewProcess) appendLog(line string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, line)
	if len(p.logs) > 300 {
		p.logs = p.logs[len(p.logs)-300:]
	}
}

type ProjectPreviewManager struct {
	mu         sync.RWMutex
	previews   map[string]*previewProcess
	httpClient *http.Client
}

func NewProjectPreviewManager() *ProjectPreviewManager {
	return &ProjectPreviewManager{
		previews: make(map[string]*previewProcess),
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				Proxy:       nil,
				DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
			},
		},
	}
}

type packageManifest struct {
	Scripts         map[string]string `json:"scripts"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
}

func readPreviewManifest(root string) (string, packageManifest, error) {
	workDir := root
	manifestPath := filepath.Join(workDir, "package.json")
	if _, err := os.Stat(manifestPath); err != nil {
		workDir = filepath.Join(root, "mobile")
		manifestPath = filepath.Join(workDir, "package.json")
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", packageManifest{}, fmt.Errorf("Project Session has no supported package.json")
	}
	var manifest packageManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", packageManifest{}, fmt.Errorf("parse package.json: %w", err)
	}
	return workDir, manifest, nil
}

func hasPackage(manifest packageManifest, name string) bool {
	return manifest.Dependencies[name] != "" || manifest.DevDependencies[name] != ""
}

func previewCommand(manifest packageManifest, port int) (framework string, command string, args []string, err error) {
	portValue := strconv.Itoa(port)
	switch {
	case hasPackage(manifest, "expo"):
		if manifest.Scripts["web"] != "" {
			return "Expo", "npm", []string{"run", "web", "--", "--port", portValue}, nil
		}
		return "Expo", "npx", []string{"expo", "start", "--web", "--port", portValue}, nil
	case hasPackage(manifest, "next") && manifest.Scripts["dev"] != "":
		return "Next.js", "npm", []string{"run", "dev", "--", "--hostname", "127.0.0.1", "--port", portValue}, nil
	case hasPackage(manifest, "vite") && manifest.Scripts["dev"] != "":
		return "Vite", "npm", []string{"run", "dev", "--", "--host", "127.0.0.1", "--port", portValue}, nil
	case manifest.Scripts["dev"] != "":
		return "Web", "npm", []string{"run", "dev", "--", "--host", "127.0.0.1", "--port", portValue}, nil
	case manifest.Scripts["start"] != "":
		return "Web", "npm", []string{"run", "start", "--", "--host", "127.0.0.1", "--port", portValue}, nil
	default:
		return "", "", nil, fmt.Errorf("package.json has no supported web preview script")
	}
}

func reservePreviewPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func (m *ProjectPreviewManager) Start(session *ProjectSession, target string) (PreviewStatus, error) {
	if session.Status != "ready" {
		return PreviewStatus{}, fmt.Errorf("Project Session is not ready")
	}
	if target != "" && target != "web" {
		return PreviewStatus{}, fmt.Errorf("preview target is not implemented by this runner")
	}
	if err := m.Stop(session.ProjectSessionID); err != nil && !strings.Contains(err.Error(), "not running") {
		return PreviewStatus{}, err
	}
	workDir, manifest, err := readPreviewManifest(session.WorkDir)
	if err != nil {
		return PreviewStatus{}, err
	}
	port, err := reservePreviewPort()
	if err != nil {
		return PreviewStatus{}, fmt.Errorf("reserve preview port: %w", err)
	}
	framework, command, args, err := previewCommand(manifest, port)
	if err != nil {
		return PreviewStatus{}, err
	}
	cmd := exec.Command(command, args...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), "BROWSER=none", "CI=1", "PORT="+strconv.Itoa(port))
	detachProcess(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return PreviewStatus{}, fmt.Errorf("preview stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return PreviewStatus{}, fmt.Errorf("preview stderr: %w", err)
	}
	preview := &previewProcess{
		projectSessionID: session.ProjectSessionID,
		framework:        framework,
		port:             port,
		cmd:              cmd,
		done:             make(chan struct{}),
		running:          true,
	}
	if err := cmd.Start(); err != nil {
		return PreviewStatus{}, fmt.Errorf("start preview: %w", err)
	}
	m.mu.Lock()
	m.previews[session.ProjectSessionID] = preview
	m.mu.Unlock()
	go scanPreviewOutput(preview, stdout)
	go scanPreviewOutput(preview, stderr)
	go func() {
		err := cmd.Wait()
		preview.mu.Lock()
		preview.running = false
		if err != nil {
			preview.exitReason = err.Error()
		}
		preview.mu.Unlock()
		close(preview.done)
	}()
	return m.Status(session.ProjectSessionID), nil
}

func scanPreviewOutput(preview *previewProcess, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		preview.appendLog(scanner.Text())
	}
}

func (m *ProjectPreviewManager) get(projectSessionID string) (*previewProcess, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	preview, ok := m.previews[projectSessionID]
	return preview, ok
}

func (m *ProjectPreviewManager) Status(projectSessionID string) PreviewStatus {
	preview, ok := m.get(projectSessionID)
	if !ok {
		status := PreviewStatus{ProjectSessionID: projectSessionID, Kind: "web"}
		status.PreviewHealth.State = "stopped"
		return status
	}
	preview.mu.RLock()
	running := preview.running
	reason := preview.exitReason
	framework := preview.framework
	port := preview.port
	preview.mu.RUnlock()
	serving := false
	if running {
		connection, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 300*time.Millisecond)
		if err == nil {
			serving = true
			_ = connection.Close()
		}
	}
	status := PreviewStatus{
		ProjectSessionID: projectSessionID,
		Framework:        framework,
		Kind:             "web",
		Running:          running,
		Serving:          serving,
		Port:             port,
	}
	if serving {
		status.ServingLabel = fmt.Sprintf("http://127.0.0.1:%d", port)
		status.PreviewHealth.State = "ready"
	} else if running {
		status.PreviewHealth.State = "starting"
	} else {
		status.PreviewHealth.State = "stopped"
		status.PreviewHealth.Reason = reason
	}
	return status
}

func (m *ProjectPreviewManager) Stop(projectSessionID string) error {
	preview, ok := m.get(projectSessionID)
	if !ok {
		return fmt.Errorf("preview is not running")
	}
	preview.mu.RLock()
	running := preview.running
	preview.mu.RUnlock()
	if running && preview.cmd.Process != nil {
		if err := terminateProcessTree(preview.cmd.Process); err != nil && !strings.Contains(strings.ToLower(err.Error()), "finished") && !strings.Contains(strings.ToLower(err.Error()), "no such process") {
			return fmt.Errorf("stop preview: %w", err)
		}
		select {
		case <-preview.done:
		case <-time.After(5 * time.Second):
		}
	}
	return nil
}

func (m *ProjectPreviewManager) StopAll() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.previews))
	for id := range m.previews {
		ids = append(ids, id)
	}
	m.mu.RUnlock()
	for _, id := range ids {
		_ = m.Stop(id)
	}
}

func (m *ProjectPreviewManager) Fetch(projectSessionID string) ([]byte, string, error) {
	status := m.Status(projectSessionID)
	if !status.Serving || status.Port == 0 {
		return nil, "", fmt.Errorf("preview is not serving")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/", status.Port), nil)
	if err != nil {
		return nil, "", err
	}
	response, err := m.httpClient.Do(request)
	if err != nil {
		return nil, "", fmt.Errorf("fetch preview: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return nil, "", err
	}
	return body, response.Header.Get("Content-Type"), nil
}
