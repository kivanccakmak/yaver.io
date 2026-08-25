package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCloudWorkspaceComfortGateFailsClosed(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "cloud-workspace")
	t.Setenv("YAVER_CLOUD_WORKSPACE", "")
	if cloudWorkspaceComfortEnabledAt(marker) {
		t.Fatal("ordinary self-hosted agents must not receive Cloud Workspace dotfiles")
	}
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if !cloudWorkspaceComfortEnabledAt(marker) {
		t.Fatal("native managed Cloud Workspace marker must enable defaults")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	t.Setenv("YAVER_CLOUD_WORKSPACE", "1")
	if !cloudWorkspaceComfortEnabledAt(marker) {
		t.Fatal("dedicated container Cloud Workspace marker must enable defaults")
	}
}

func TestCloudWorkspaceComfortDefaultsArePublicAndEditable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := ensureCloudWorkspaceComfortDefaults(nil); err != nil {
		t.Fatal(err)
	}

	checks := map[string][]string{
		".zshrc":     {`ZSH_THEME="ys"`, "plugins=(git)", "yaver-shell", "fzf"},
		".tmux.conf": {"history-limit 1000000", `status-bg "#262626"`, "split-window -h", "tmux-yank"},
		".vimrc":     {"colorscheme gruvbox", "set relativenumber", "nnoremap ^ 0", "let mapleader"},
	}
	for rel, wants := range checks {
		data, err := os.ReadFile(filepath.Join(home, rel))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, want := range wants {
			if !strings.Contains(text, want) {
				t.Errorf("%s missing %q", rel, want)
			}
		}
		for _, forbidden := range []string{"/Users/", "/home/", "PRIVATE_PROVIDER", "AUTH_TOKEN", "API_KEY", "PASSWORD="} {
			if strings.Contains(text, forbidden) {
				t.Errorf("%s leaked private-shaped value %q", rel, forbidden)
			}
		}
	}
}

func TestCloudWorkspaceComfortNeverOverwritesUserFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, rel := range []string{".zshrc", ".tmux.conf"} {
		if err := os.WriteFile(filepath.Join(home, rel), []byte("user-owned\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(home, ".vim"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".vim", "vimrc"), []byte("user-vim\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ensureCloudWorkspaceComfortDefaults(nil); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{".zshrc", ".tmux.conf"} {
		data, _ := os.ReadFile(filepath.Join(home, rel))
		if string(data) != "user-owned\n" {
			t.Fatalf("%s was overwritten: %q", rel, data)
		}
	}
	if cloudComfortFileExists(filepath.Join(home, ".vimrc")) {
		t.Fatal("Yaver created a competing ~/.vimrc over user-owned ~/.vim/vimrc")
	}
}
