package main

import (
	"path/filepath"
	"testing"
)

func TestNativeKeychainBrowserProfile(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "Users", "owner")
	tests := []struct {
		name string
		path string
		goos string
		want bool
	}{
		{"chromium root", filepath.Join(home, "Library", "Application Support", "Chromium"), "darwin", true},
		{"chromium default", filepath.Join(home, "Library", "Application Support", "Chromium", "Default"), "darwin", true},
		{"chrome profile", filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "Profile 2"), "darwin", true},
		{"prefix lookalike", filepath.Join(home, "Library", "Application Support", "Chromium-copy"), "darwin", false},
		{"yaver isolated profile", filepath.Join(home, ".yaver", "browser-profiles", "apple-developer"), "darwin", false},
		{"linux never uses login keychain", filepath.Join(home, "Library", "Application Support", "Chromium"), "linux", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nativeKeychainBrowserProfile(tt.path, home, tt.goos); got != tt.want {
				t.Fatalf("nativeKeychainBrowserProfile(%q, %q) = %v, want %v", tt.path, tt.goos, got, tt.want)
			}
		})
	}
}

func TestDefaultNativeBrowserDataDir(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "Users", "owner")
	chromium := filepath.Join(home, "Library", "Application Support", "Chromium")
	chrome := filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	tests := []struct {
		name string
		path string
		goos string
		want bool
	}{
		{"chromium root is protected", chromium, "darwin", true},
		{"chrome root is protected", chrome, "darwin", true},
		{"dedicated chromium profile is allowed", filepath.Join(chromium, "Yaver-Automation-Apple"), "darwin", false},
		{"profile subdirectory is not a data root", filepath.Join(chromium, "Default"), "darwin", false},
		{"linux path is not macOS protected profile", chromium, "linux", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := defaultNativeBrowserDataDir(tt.path, home, tt.goos); got != tt.want {
				t.Fatalf("defaultNativeBrowserDataDir(%q, %q) = %v, want %v", tt.path, tt.goos, got, tt.want)
			}
		})
	}
}

func TestNativeBrowserExecutableForProfile(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "Users", "owner")
	tests := []struct {
		name string
		path string
		goos string
		want string
	}{
		{
			"chrome profile uses chrome",
			filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "Yaver-Automation-Apple"),
			"darwin",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		},
		{
			"chromium profile uses chromium",
			filepath.Join(home, "Library", "Application Support", "Chromium", "Yaver-Automation-Apple"),
			"darwin",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		},
		{"lookalike is not paired", filepath.Join(home, "Library", "Application Support", "Google", "Chrome-copy"), "darwin", ""},
		{"linux is not paired", filepath.Join(home, "Library", "Application Support", "Google", "Chrome"), "linux", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nativeBrowserExecutableForProfile(tt.path, home, tt.goos); got != tt.want {
				t.Fatalf("nativeBrowserExecutableForProfile(%q, %q) = %q, want %q", tt.path, tt.goos, got, tt.want)
			}
		})
	}
}
