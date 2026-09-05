package main

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// nodeInstallVersion is the Node.js LTS shipped by the on-demand
// installer. Pinning avoids an extra HTTP call to nodejs.org/dist on
// every request and gives a stable baseline above the modern Expo SDK
// floor.
//
// Floor required by Expo SDK 53/54: Node ≥ 20.19.4. We deliberately
// ship the active LTS line (v22.x) instead of grazing the floor with
// v20.19.x because every customer-side Expo bump for the next year+
// would otherwise re-trigger this incident. v22 is the currently-active
// LTS and supports Expo 54 + RN 0.81 cleanly.
const nodeInstallVersion = "v22.12.0"

// nodeMinimumMajor / nodeMinimumMinor define the minimum Node version
// the agent considers acceptable for an Expo-aware project. If the
// existing binary at ~/.yaver/runtimes/node/bin/node is below this
// floor, installNodeRuntime re-downloads even though "something" is
// already present — otherwise customers stay stuck on stale runtimes
// after a single yaver upgrade.
const (
	nodeMinimumMajor = 20
	nodeMinimumMinor = 19
	nodeMinimumPatch = 4
)

// installNodeRuntime downloads the Node.js LTS tarball for the current
// platform into ~/.yaver/runtimes/node, sudo-free, so a fresh
// Linux/macOS dev box can be brought up from the phone without any
// terminal access. Returns the bin directory on success.
//
// progress (if non-nil) receives one human-readable line per phase
// (download, extract, ready). It is not closed.
func installNodeRuntime(ctx context.Context, progress func(string)) (string, error) {
	logf := func(s string) {
		if progress != nil {
			progress(s)
		}
	}

	tarName, urlPath, ok := nodeTarballForPlatform(nodeInstallVersion)
	if !ok {
		return "", fmt.Errorf("node runtime install: unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	root := runtimeRoot()
	target := filepath.Join(root, "node")
	binDir := filepath.Join(target, "bin")

	if existing := nodeRuntimeExisting(binDir); existing != "" {
		if nodeVersionMeetsFloor(existing) {
			if err := ensureNodeCurrentSymlink(target); err != nil {
				return "", err
			}
			if err := ensureUserShellPathSetup(progress); err != nil {
				return "", err
			}
			if err := configureNpmUserPrefix(binDir, progress); err != nil {
				return "", err
			}
			logf(fmt.Sprintf("Node already installed at %s (%s)", binDir, existing))
			return binDir, nil
		}
		logf(fmt.Sprintf("Node at %s is %s — below Expo SDK floor (need ≥ v%d.%d.%d). Reinstalling.",
			binDir, existing, nodeMinimumMajor, nodeMinimumMinor, nodeMinimumPatch))
	}

	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("create runtime root: %w", err)
	}

	tmpFile := filepath.Join(root, tarName)
	url := "https://nodejs.org/dist/" + urlPath
	logf(fmt.Sprintf("Downloading %s …", url))
	if err := downloadFile(ctx, url, tmpFile); err != nil {
		return "", fmt.Errorf("download node: %w", err)
	}
	defer os.Remove(tmpFile)

	logf("Extracting …")
	stage := filepath.Join(root, "node.new")
	_ = os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return "", err
	}
	if err := extractNodeArchive(ctx, tmpFile, tarName, stage); err != nil {
		_ = os.RemoveAll(stage)
		return "", fmt.Errorf("extract node: %w", err)
	}

	if _, err := os.Stat(target); err == nil {
		_ = os.RemoveAll(target + ".old")
		if err := os.Rename(target, target+".old"); err != nil {
			_ = os.RemoveAll(stage)
			return "", fmt.Errorf("swap old node: %w", err)
		}
		defer os.RemoveAll(target + ".old")
	}
	if err := os.Rename(stage, target); err != nil {
		return "", fmt.Errorf("install node: %w", err)
	}

	if existing := nodeRuntimeExisting(binDir); existing != "" {
		if err := ensureNodeCurrentSymlink(target); err != nil {
			return "", err
		}
		if err := ensureUserShellPathSetup(progress); err != nil {
			return "", err
		}
		if err := configureNpmUserPrefix(binDir, progress); err != nil {
			return "", err
		}
		logf(fmt.Sprintf("Node ready: %s (%s)", binDir, existing))
		return binDir, nil
	}
	return "", fmt.Errorf("node binary missing after extract at %s", binDir)
}

func ensureNodeCurrentSymlink(target string) error {
	// Native Windows does not need a shell-visible compatibility symlink: the
	// agent prepends target/bin to every spawned process itself. Creating a
	// symlink there would also require Developer Mode or elevation on many
	// consumer PCs, turning a sudo-free install into an admin-only one.
	if runtime.GOOS == "windows" {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return fmt.Errorf("resolve home dir for node-current symlink: %w", err)
	}
	localDir := filepath.Join(home, ".local")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return fmt.Errorf("create .local dir: %w", err)
	}
	linkPath := filepath.Join(localDir, "node-current")
	if info, err := os.Lstat(linkPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			if current, readErr := os.Readlink(linkPath); readErr == nil {
				if current == target {
					return nil
				}
			}
		}
		if removeErr := os.RemoveAll(linkPath); removeErr != nil {
			return fmt.Errorf("remove stale node-current link: %w", removeErr)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat node-current link: %w", err)
	}
	if err := os.Symlink(target, linkPath); err != nil {
		return fmt.Errorf("create node-current symlink: %w", err)
	}
	return nil
}

// nodeTarballForPlatform returns (filename, urlPath, ok) for the
// current OS/arch. The url path is appended to https://nodejs.org/dist/.
func nodeTarballForPlatform(version string) (string, string, bool) {
	return nodeArchiveForPlatform(version, runtime.GOOS, runtime.GOARCH)
}

// nodeArchiveForPlatform is split from the runtime wrapper so Windows archive
// support is testable on any CI host. Node's Windows zip contains node.exe,
// npm.cmd and npx.cmd at the archive root; extractNodeArchive places those in
// the same ~/.yaver/runtimes/node/bin layout used on Unix.
func nodeArchiveForPlatform(version, goos, goarch string) (string, string, bool) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		name := fmt.Sprintf("node-%s-linux-x64.tar.xz", version)
		return name, fmt.Sprintf("%s/%s", version, name), true
	case "linux/arm64":
		name := fmt.Sprintf("node-%s-linux-arm64.tar.xz", version)
		return name, fmt.Sprintf("%s/%s", version, name), true
	case "darwin/amd64":
		name := fmt.Sprintf("node-%s-darwin-x64.tar.gz", version)
		return name, fmt.Sprintf("%s/%s", version, name), true
	case "darwin/arm64":
		name := fmt.Sprintf("node-%s-darwin-arm64.tar.gz", version)
		return name, fmt.Sprintf("%s/%s", version, name), true
	case "windows/amd64":
		name := fmt.Sprintf("node-%s-win-x64.zip", version)
		return name, fmt.Sprintf("%s/%s", version, name), true
	case "windows/arm64":
		name := fmt.Sprintf("node-%s-win-arm64.zip", version)
		return name, fmt.Sprintf("%s/%s", version, name), true
	}
	return "", "", false
}

// extractNodeArchive expands the official Node archive into stage using one
// stable layout on every OS. Unix archives already contain bin/ after their
// top-level directory is stripped. Windows archives put node.exe/npm.cmd/npx.cmd
// at the top level, so their stripped contents go into stage/bin.
func extractNodeArchive(ctx context.Context, archivePath, archiveName, stage string) error {
	if strings.HasSuffix(strings.ToLower(archiveName), ".zip") {
		return extractNodeZip(ctx, archivePath, filepath.Join(stage, "bin"))
	}
	tarFlag := "-xzf"
	if strings.HasSuffix(archiveName, ".tar.xz") {
		tarFlag = "-xJf"
	}
	cmd := exec.CommandContext(ctx, "tar", tarFlag, archivePath, "-C", stage, "--strip-components=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func extractNodeZip(ctx context.Context, archivePath, destRoot string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()
	if err := os.MkdirAll(destRoot, 0o755); err != nil {
		return err
	}

	for _, entry := range zr.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Official archives have one top-level node-vX-win-ARCH directory.
		// Strip exactly that component and reject absolute/parent traversal.
		clean := path.Clean(strings.ReplaceAll(entry.Name, "\\", "/"))
		if clean == "." || strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
			return fmt.Errorf("unsafe zip entry %q", entry.Name)
		}
		parts := strings.SplitN(clean, "/", 2)
		if len(parts) != 2 || parts[1] == "" {
			continue
		}
		rel := parts[1]
		dst := filepath.Join(destRoot, filepath.FromSlash(rel))
		resolvedRoot, rootErr := filepath.Abs(destRoot)
		resolvedDst, dstErr := filepath.Abs(dst)
		if rootErr != nil || dstErr != nil || (resolvedDst != resolvedRoot && !strings.HasPrefix(resolvedDst, resolvedRoot+string(os.PathSeparator))) {
			return fmt.Errorf("unsafe zip entry %q", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := entry.Open()
		if err != nil {
			return err
		}
		mode := entry.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		closeErr := out.Close()
		rcErr := rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if rcErr != nil {
			return rcErr
		}
	}
	return nil
}

// nodeVersionMeetsFloor returns true when the version string (e.g. "v20.19.4"
// or "v22.12.0") is at or above the Expo SDK 53/54 minimum. Symlinks like
// the test box's "/usr/bin/node v22.x" go through fine; old vendored Node
// installs at v20.18.x are flagged for reinstall.
func nodeVersionMeetsFloor(version string) bool {
	v := strings.TrimSpace(version)
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 1 {
		return false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	if major > nodeMinimumMajor {
		return true
	}
	if major < nodeMinimumMajor {
		return false
	}
	if len(parts) < 2 {
		return false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	if minor > nodeMinimumMinor {
		return true
	}
	if minor < nodeMinimumMinor {
		return false
	}
	if len(parts) < 3 {
		return false
	}
	// patch may be "4", "4-darwin", or "4 (build ...)"
	patchToken := parts[2]
	if i := strings.IndexAny(patchToken, "-+ \t"); i >= 0 {
		patchToken = patchToken[:i]
	}
	patch, err := strconv.Atoi(patchToken)
	if err != nil {
		return false
	}
	return patch >= nodeMinimumPatch
}

// nodeRuntimeExisting returns the version string from `node --version`
// in binDir, or "" if no usable binary lives there.
func nodeRuntimeExisting(binDir string) string {
	binName := "node"
	if runtime.GOOS == "windows" {
		binName = "node.exe"
	}
	bin := filepath.Join(binDir, binName)
	if _, err := os.Stat(bin); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func detectManagedOrSystemNode() (path, version string) {
	if p, v := detectBinaryWithVersion("node", "--version"); p != "" {
		return p, v
	}
	binDir := runtimeNodeBinDir()
	if binDir == "" {
		return "", ""
	}
	if v := nodeRuntimeExisting(binDir); v != "" {
		binName := "node"
		if runtime.GOOS == "windows" {
			binName = "node.exe"
		}
		return filepath.Join(binDir, binName), v
	}
	return "", ""
}

// downloadFile fetches url into dstPath. Existing file is overwritten
// atomically via a .part rename. Honors ctx for cancellation.
func downloadFile(ctx context.Context, url, dstPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	tmp := dstPath + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dstPath)
}
