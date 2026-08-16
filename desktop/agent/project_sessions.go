package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
)

const projectSessionCommandTimeout = 2 * time.Minute

// GitRepository is the path-free repository descriptor returned to clients.
// Repository paths are resolved only inside the trusted runner.
type GitRepository struct {
	RepositoryID string `json:"repositoryId"`
	Name         string `json:"name"`
	DefaultRef   string `json:"defaultRef,omitempty"`
}

// ProjectSession owns one isolated checkout and review branch.
type ProjectSession struct {
	ProjectSessionID string    `json:"projectSessionId"`
	RepositoryID     string    `json:"repositoryId"`
	RepositoryName   string    `json:"repositoryName"`
	BaseRef          string    `json:"baseRef"`
	ReviewBranch     string    `json:"reviewBranch"`
	Status           string    `json:"status"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
	WorkDir          string    `json:"-"`
}

type persistedProjectSession struct {
	ProjectSession
	WorkDir string `json:"workDir"`
}

type ProjectSessionManager struct {
	mu       sync.RWMutex
	rootDir  string
	registry string
	sessions map[string]*ProjectSession
}

func NewProjectSessionManager() (*ProjectSessionManager, error) {
	configDir, err := ConfigDir()
	if err != nil {
		return nil, err
	}
	root := filepath.Join(configDir, "project-sessions")
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create project sessions directory: %w", err)
	}
	m := &ProjectSessionManager{
		rootDir:  root,
		registry: filepath.Join(root, "sessions.json"),
		sessions: make(map[string]*ProjectSession),
	}
	if err := m.load(); err != nil {
		return nil, err
	}
	return m, nil
}

func repositoryID(path string) string {
	digest := sha256.Sum256([]byte("yaver-repository-v1\x00" + filepath.Clean(path)))
	return "repo_" + hex.EncodeToString(digest[:12])
}

func repositoryCatalog() (map[string]projectInfo, error) {
	projects := listDiscoveredProjects()
	catalog := make(map[string]projectInfo, len(projects))
	for _, project := range projects {
		path := filepath.Clean(project.Path)
		if _, statErr := os.Stat(filepath.Join(path, ".git")); statErr != nil {
			continue
		}
		project.Path = path
		catalog[repositoryID(path)] = project
	}
	return catalog, nil
}

func ListGitRepositories(refresh bool) ([]GitRepository, error) {
	if refresh {
		discoverProjects()
	}
	catalog, err := repositoryCatalog()
	if err != nil {
		return nil, err
	}
	repositories := make([]GitRepository, 0, len(catalog))
	for id, project := range catalog {
		repositories = append(repositories, GitRepository{
			RepositoryID: id,
			Name:         filepath.Base(project.Path),
			DefaultRef:   project.Branch,
		})
	}
	sort.Slice(repositories, func(i, j int) bool {
		if repositories[i].Name == repositories[j].Name {
			return repositories[i].RepositoryID < repositories[j].RepositoryID
		}
		return repositories[i].Name < repositories[j].Name
	})
	return repositories, nil
}

func validGitRef(ref string) bool {
	if ref == "" || strings.HasPrefix(ref, "-") || strings.HasSuffix(ref, ".") || strings.HasSuffix(ref, "/") {
		return false
	}
	if strings.Contains(ref, "..") || strings.Contains(ref, "//") || strings.Contains(ref, "@{") || strings.ContainsAny(ref, "~^:?*[\\") {
		return false
	}
	for _, r := range ref {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func runProjectSessionGit(ctx context.Context, workDir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("git %s: %s", args[0], message)
	}
	return out, nil
}

func (m *ProjectSessionManager) Create(repositoryIDValue, baseRef string) (*ProjectSession, error) {
	catalog, err := repositoryCatalog()
	if err != nil {
		return nil, err
	}
	project, ok := catalog[repositoryIDValue]
	if !ok {
		return nil, fmt.Errorf("repository is not available to this runner")
	}
	baseRef = strings.TrimSpace(baseRef)
	if baseRef == "" {
		baseRef = strings.TrimSpace(project.Branch)
	}
	if baseRef == "" {
		baseRef = "HEAD"
	}
	if !validGitRef(baseRef) {
		return nil, fmt.Errorf("invalid base ref")
	}

	id := "ps_" + strings.ReplaceAll(uuid.New().String(), "-", "")[:20]
	reviewBranch := "yaver/cloud-" + strings.TrimPrefix(id, "ps_")
	sessionDir := filepath.Join(m.rootDir, id)
	checkoutDir := filepath.Join(sessionDir, "checkout")
	if err := os.Mkdir(sessionDir, 0700); err != nil {
		return nil, fmt.Errorf("create project session: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(sessionDir)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), projectSessionCommandTimeout)
	defer cancel()
	if _, err := runProjectSessionGit(ctx, sessionDir, "clone", "--no-local", "--no-checkout", project.Path, checkoutDir); err != nil {
		return nil, err
	}
	// A local seed clone would otherwise retain a filesystem origin and could
	// never publish a review branch. Preserve the seed repository's network
	// origin when the controller provisioned one.
	if remoteOut, remoteErr := runProjectSessionGit(ctx, project.Path, "remote", "get-url", "origin"); remoteErr == nil {
		remote := strings.TrimSpace(string(remoteOut))
		if isNetworkGitRemote(remote) {
			if _, err := runProjectSessionGit(ctx, checkoutDir, "remote", "set-url", "origin", remote); err != nil {
				return nil, err
			}
		}
	}
	if _, err := runProjectSessionGit(ctx, checkoutDir, "checkout", "-b", reviewBranch, baseRef); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	session := &ProjectSession{
		ProjectSessionID: id,
		RepositoryID:     repositoryIDValue,
		RepositoryName:   filepath.Base(project.Path),
		BaseRef:          baseRef,
		ReviewBranch:     reviewBranch,
		Status:           "ready",
		CreatedAt:        now,
		UpdatedAt:        now,
		WorkDir:          checkoutDir,
	}
	m.mu.Lock()
	m.sessions[id] = session
	if err := m.persistLocked(); err != nil {
		delete(m.sessions, id)
		m.mu.Unlock()
		return nil, err
	}
	m.mu.Unlock()
	cleanup = false
	copy := *session
	return &copy, nil
}

func (m *ProjectSessionManager) List() []ProjectSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]ProjectSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		result = append(result, *session)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	return result
}

func (m *ProjectSessionManager) Get(id string) (*ProjectSession, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session, ok := m.sessions[id]
	if !ok {
		return nil, false
	}
	copy := *session
	return &copy, true
}

func (m *ProjectSessionManager) Stop(id string) (*ProjectSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("project session not found")
	}
	session.Status = "stopped"
	session.UpdatedAt = time.Now().UTC()
	if err := m.persistLocked(); err != nil {
		return nil, err
	}
	copy := *session
	return &copy, nil
}

func (m *ProjectSessionManager) Delete(id string) (*ProjectSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("project session not found")
	}
	copy := *session
	copy.Status = "stopped"
	copy.UpdatedAt = time.Now().UTC()
	sessionDir := filepath.Dir(session.WorkDir)
	expectedDir := filepath.Join(m.rootDir, id)
	if filepath.Clean(sessionDir) != filepath.Clean(expectedDir) {
		return nil, fmt.Errorf("project session cleanup boundary mismatch")
	}
	if err := os.RemoveAll(sessionDir); err != nil {
		return nil, fmt.Errorf("remove project session checkout: %w", err)
	}
	delete(m.sessions, id)
	if err := m.persistLocked(); err != nil {
		return nil, err
	}
	return &copy, nil
}

func (m *ProjectSessionManager) GitStatus(id string) (map[string]string, error) {
	session, ok := m.Get(id)
	if !ok {
		return nil, fmt.Errorf("project session not found")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, err := runProjectSessionGit(ctx, session.WorkDir, "status", "--short", "--branch")
	if err != nil {
		return nil, err
	}
	return map[string]string{"branch": session.ReviewBranch, "status": string(status)}, nil
}

func (m *ProjectSessionManager) GitDiff(id string) (string, error) {
	session, ok := m.Get(id)
	if !ok {
		return "", fmt.Errorf("project session not found")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := runProjectSessionGit(ctx, session.WorkDir, "diff", "--no-ext-diff", "--no-color")
	if err != nil {
		return "", err
	}
	const maxDiffBytes = 1024 * 1024
	if len(out) > maxDiffBytes {
		return string(out[:maxDiffBytes]) + "\n\n[diff truncated]", nil
	}
	return string(out), nil
}

func (m *ProjectSessionManager) GitCommit(id, message string) (string, error) {
	session, ok := m.Get(id)
	if !ok {
		return "", fmt.Errorf("project session not found")
	}
	message = strings.TrimSpace(message)
	if message == "" || len(message) > 500 {
		return "", fmt.Errorf("commit message must be between 1 and 500 characters")
	}
	ctx, cancel := context.WithTimeout(context.Background(), projectSessionCommandTimeout)
	defer cancel()
	if _, err := runProjectSessionGit(ctx, session.WorkDir, "add", "--all"); err != nil {
		return "", err
	}
	if _, err := runProjectSessionGit(ctx, session.WorkDir, "commit", "-m", message); err != nil {
		return "", err
	}
	out, err := runProjectSessionGit(ctx, session.WorkDir, "rev-parse", "HEAD")
	return strings.TrimSpace(string(out)), err
}

func (m *ProjectSessionManager) PushReview(id string) (string, error) {
	session, ok := m.Get(id)
	if !ok {
		return "", fmt.Errorf("project session not found")
	}
	ctx, cancel := context.WithTimeout(context.Background(), projectSessionCommandTimeout)
	defer cancel()
	branchOut, err := runProjectSessionGit(ctx, session.WorkDir, "branch", "--show-current")
	if err != nil || strings.TrimSpace(string(branchOut)) != session.ReviewBranch {
		return "", fmt.Errorf("review branch policy violation")
	}
	remoteOut, err := runProjectSessionGit(ctx, session.WorkDir, "remote", "get-url", "origin")
	if err != nil {
		return "", err
	}
	remote := strings.TrimSpace(string(remoteOut))
	if !isNetworkGitRemote(remote) {
		return "", fmt.Errorf("review push requires an HTTPS or SSH Git remote")
	}
	if _, err := runProjectSessionGit(ctx, session.WorkDir, "push", "--set-upstream", "origin", session.ReviewBranch); err != nil {
		return "", err
	}
	return session.ReviewBranch, nil
}

func isNetworkGitRemote(remote string) bool {
	return strings.HasPrefix(remote, "https://") || strings.HasPrefix(remote, "ssh://") || strings.HasPrefix(remote, "git@")
}

func (m *ProjectSessionManager) load() error {
	data, err := os.ReadFile(m.registry)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read project session registry: %w", err)
	}
	var stored []persistedProjectSession
	if err := json.Unmarshal(data, &stored); err != nil {
		return fmt.Errorf("parse project session registry: %w", err)
	}
	for _, item := range stored {
		workDir := filepath.Clean(item.WorkDir)
		rel, relErr := filepath.Rel(m.rootDir, workDir)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		copy := item.ProjectSession
		copy.WorkDir = workDir
		if _, statErr := os.Stat(workDir); statErr != nil && copy.Status == "ready" {
			copy.Status = "error"
		}
		m.sessions[copy.ProjectSessionID] = &copy
	}
	return nil
}

func (m *ProjectSessionManager) persistLocked() error {
	stored := make([]persistedProjectSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		stored = append(stored, persistedProjectSession{ProjectSession: *session, WorkDir: session.WorkDir})
	}
	sort.Slice(stored, func(i, j int) bool { return stored[i].CreatedAt.Before(stored[j].CreatedAt) })
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return fmt.Errorf("encode project session registry: %w", err)
	}
	temp := m.registry + ".tmp"
	if err := os.WriteFile(temp, data, 0600); err != nil {
		return fmt.Errorf("write project session registry: %w", err)
	}
	if err := os.Rename(temp, m.registry); err != nil {
		return fmt.Errorf("replace project session registry: %w", err)
	}
	return nil
}
