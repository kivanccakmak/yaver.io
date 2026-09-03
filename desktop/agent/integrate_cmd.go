package main

// integrate_cmd.go owns the deterministic "existing app -> Yaver-enabled app"
// path. Before this existed, `yaver expo setup` installed the package and
// printed JSX that a human or coding agent still had to interpret. That was a
// false green: package inventory said yes while the running app had no mounted
// FeedbackModal. Keep every entry point (CLI, legacy setup aliases, and MCP) on
// this implementation so they cannot drift back into instructions-only setup.

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	yaverIntegrationPackage        = "yaver-feedback-react-native"
	yaverIntegrationPackageVersion = "^0.9.16"
	yaverIntegrationFile           = "yaver/YaverFeedbackRoot.tsx"
)

var expoIntegrationPackages = []string{
	yaverIntegrationPackage,
	"@react-native-async-storage/async-storage",
	"expo-web-browser",
	"expo-apple-authentication",
	"expo-secure-store",
	"expo-crypto",
	"expo-document-picker",
	"react-native-view-shot",
	// A fresh Expo app does not always include the web lane. Installing Expo's
	// compatible versions here makes `--verify web` an operation proof rather
	// than a predictable missing-react-dom failure.
	"react-dom",
	"react-native-web",
	"@expo/metro-runtime",
}

type projectIntegrationOptions struct {
	Directory   string
	Framework   string
	Verify      string
	SkipInstall bool
}

type projectIntegrationResult struct {
	OK                bool     `json:"ok"`
	Directory         string   `json:"directory"`
	Framework         string   `json:"framework"`
	PackageManager    string   `json:"package_manager"`
	RootFile          string   `json:"root_file"`
	IntegrationFile   string   `json:"integration_file"`
	InstalledPackages []string `json:"installed_packages,omitempty"`
	ChangedFiles      []string `json:"changed_files,omitempty"`
	UnchangedFiles    []string `json:"unchanged_files,omitempty"`
	Verification      []string `json:"verification,omitempty"`
	Warnings          []string `json:"warnings,omitempty"`
	LogTail           string   `json:"log_tail,omitempty"`
	Error             string   `json:"error,omitempty"`
}

func runIntegrate(args []string) {
	fs := flag.NewFlagSet("integrate", flag.ExitOnError)
	dir := fs.String("dir", ".", "Existing project directory")
	framework := fs.String("framework", "", "Framework override (currently expo)")
	verify := fs.String("verify", "quick", "Verification level: none, quick, or web")
	skipInstall := fs.Bool("no-install", false, "Patch and verify without installing packages")
	asJSON := fs.Bool("json", false, "Print one machine-readable JSON result")
	fs.Parse(args)

	var logWriter io.Writer = os.Stdout
	if *asJSON {
		logWriter = io.Discard
	}
	result, err := integrateProject(projectIntegrationOptions{
		Directory:   *dir,
		Framework:   *framework,
		Verify:      *verify,
		SkipInstall: *skipInstall,
	}, logWriter)
	if err != nil {
		result.OK = false
		result.Error = err.Error()
	}

	if *asJSON {
		_ = json.NewEncoder(os.Stdout).Encode(result)
	} else if err != nil {
		fmt.Fprintf(os.Stderr, "Yaver integration failed: %v\n", err)
	} else {
		fmt.Fprintln(os.Stdout, "\nYaver integration ready.")
		fmt.Fprintf(os.Stdout, "  Root: %s\n", result.RootFile)
		fmt.Fprintf(os.Stdout, "  Verify: %s\n", strings.Join(result.Verification, ", "))
	}
	if err != nil {
		os.Exit(1)
	}
}

func integrateProject(opts projectIntegrationOptions, out io.Writer) (projectIntegrationResult, error) {
	result := projectIntegrationResult{}
	directory := strings.TrimSpace(opts.Directory)
	if directory == "" {
		return result, fmt.Errorf("directory is required; pass the existing app root explicitly")
	}
	absDir, err := filepath.Abs(directory)
	if err != nil {
		return result, fmt.Errorf("resolve project directory: %w", err)
	}
	result.Directory = absDir
	info, err := os.Stat(absDir)
	if err != nil {
		return result, fmt.Errorf("project directory is not readable: %w", err)
	}
	if !info.IsDir() {
		return result, fmt.Errorf("project path is not a directory: %s", absDir)
	}

	framework := strings.ToLower(strings.TrimSpace(opts.Framework))
	if framework == "react_native" || framework == "rn" {
		framework = "react-native"
	}
	if framework == "" {
		if isExpoProject(absDir) {
			framework = "expo"
		}
	}
	if framework != "expo" || !isExpoProject(absDir) {
		return result, fmt.Errorf("supported deterministic target not detected in %s; this release integrates existing Expo projects (pass --framework expo from the Expo app root)", absDir)
	}
	result.Framework = framework
	result.PackageManager = detectPackageManager(absDir)

	verify, err := normalizeIntegrationVerify(opts.Verify)
	if err != nil {
		return result, err
	}

	rootPath, err := findExpoRootFile(absDir)
	if err != nil {
		return result, err
	}
	result.RootFile = relativeProjectPath(absDir, rootPath)
	result.IntegrationFile = yaverIntegrationFile

	// Parse the root before package installation or file mutation. An unusual
	// export shape must fail cheaply and leave the project untouched.
	rootSource, err := os.ReadFile(rootPath)
	if err != nil {
		return result, fmt.Errorf("read Expo root %s: %w", result.RootFile, err)
	}
	patchedRoot, rootChanged, err := patchExpoRootSource(string(rootSource), rootPath, filepath.Join(absDir, yaverIntegrationFile))
	if err != nil {
		return result, fmt.Errorf("cannot integrate %s: %w; export a named root component (for example `export default function App()`) and retry", result.RootFile, err)
	}
	configPath := filepath.Join(absDir, "app.json")
	configOriginal, err := os.ReadFile(configPath)
	if err != nil {
		return result, fmt.Errorf("app.json is required for deterministic plugin wiring; migrate the dynamic app.config file to expose an app.json plugin list, or add %q there and retry", yaverIntegrationPackage)
	}
	var configProbe map[string]interface{}
	if err := json.Unmarshal(configOriginal, &configProbe); err != nil {
		return result, fmt.Errorf("invalid app.json: %w", err)
	}
	packageSnapshots := snapshotIntegrationFiles(absDir, []string{
		"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
	})

	if !opts.SkipInstall {
		fmt.Fprintf(out, "Installing Expo-compatible Yaver dependencies with %s...\n", result.PackageManager)
		if err := installExpoIntegrationPackages(absDir, result.PackageManager, out); err != nil {
			return result, err
		}
		result.InstalledPackages = append([]string(nil), expoIntegrationPackages...)
	}

	if err := addPluginToAppJSON(configPath); err != nil {
		return result, fmt.Errorf("wire Expo config plugin: %w", err)
	}
	configAfter, err := os.ReadFile(configPath)
	if err != nil {
		return result, fmt.Errorf("re-read app.json: %w", err)
	}
	if string(configOriginal) == string(configAfter) {
		result.UnchangedFiles = append(result.UnchangedFiles, "app.json")
	} else {
		result.ChangedFiles = append(result.ChangedFiles, "app.json")
	}

	integrationPath := filepath.Join(absDir, yaverIntegrationFile)
	integrationChanged, err := writeYaverIntegrationFile(integrationPath)
	if err != nil {
		return result, err
	}
	if integrationChanged {
		result.ChangedFiles = append(result.ChangedFiles, yaverIntegrationFile)
	} else {
		result.UnchangedFiles = append(result.UnchangedFiles, yaverIntegrationFile)
	}

	if rootChanged {
		if err := os.WriteFile(rootPath, []byte(patchedRoot), infoMode(rootPath)); err != nil {
			return result, fmt.Errorf("write Expo root %s: %w", result.RootFile, err)
		}
		result.ChangedFiles = append(result.ChangedFiles, result.RootFile)
	} else {
		result.UnchangedFiles = append(result.UnchangedFiles, result.RootFile)
	}
	for _, rel := range []string{"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"} {
		before, existedBefore := packageSnapshots[rel]
		after, readErr := os.ReadFile(filepath.Join(absDir, rel))
		if readErr != nil {
			continue
		}
		if !existedBefore || string(before) != string(after) {
			result.ChangedFiles = appendUniqueString(result.ChangedFiles, rel)
		} else {
			result.UnchangedFiles = appendUniqueString(result.UnchangedFiles, rel)
		}
	}

	fmt.Fprintf(out, "Wired %s through %s.\n", result.RootFile, yaverIntegrationFile)
	checks, err := verifyExpoIntegration(absDir, verify, out)
	result.Verification = checks
	if err != nil {
		return result, err
	}
	result.OK = true
	return result, nil
}

func normalizeIntegrationVerify(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "quick"
	}
	switch value {
	case "none", "quick", "web":
		return value, nil
	default:
		return "", fmt.Errorf("unknown verification level %q (use none, quick, or web)", value)
	}
}

func installExpoIntegrationPackages(dir, packageManager string, out io.Writer) error {
	expoBin := filepath.Join(dir, "node_modules", ".bin", "expo")
	if _, err := os.Stat(expoBin); err != nil {
		fmt.Fprintf(out, "Project dependencies are missing; running %s install first...\n", packageManager)
		name, args := packageManagerInstallCommand(packageManager)
		if err := runIntegrationCommand(dir, out, name, args...); err != nil {
			return fmt.Errorf("install existing project dependencies with %s: %w", packageManager, err)
		}
	}
	if _, err := os.Stat(expoBin); err != nil {
		return fmt.Errorf("Expo CLI is still unavailable after dependency install; verify the project's expo dependency and retry")
	}

	args := append([]string{"install"}, expoIntegrationPackages...)
	switch packageManager {
	case "yarn":
		args = append(args, "--yarn")
	case "pnpm":
		args = append(args, "--pnpm")
	default:
		args = append(args, "--npm")
	}
	if err := runIntegrationCommand(dir, out, expoBin, args...); err != nil {
		return fmt.Errorf("install Expo-compatible Yaver dependencies: %w", err)
	}
	return nil
}

func packageManagerInstallCommand(packageManager string) (string, []string) {
	switch packageManager {
	case "yarn":
		return "yarn", []string{"install"}
	case "pnpm":
		return "pnpm", []string{"install"}
	default:
		return "npm", []string{"install"}
	}
}

func runIntegrationCommand(dir string, out io.Writer, name string, args ...string) error {
	if filepath.Dir(name) == "." {
		if _, err := osexec.LookPath(name); err != nil {
			return fmt.Errorf("required command %q is not installed or not on PATH", name)
		}
	}
	fmt.Fprintf(out, "$ %s %s\n", name, strings.Join(args, " "))
	cmd := osexec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}

func findExpoRootFile(dir string) (string, error) {
	candidates := []string{
		"app/_layout.tsx", "app/_layout.jsx", "app/_layout.ts", "app/_layout.js",
		"src/app/_layout.tsx", "src/app/_layout.jsx", "src/app/_layout.ts", "src/app/_layout.js",
		"App.tsx", "App.jsx", "App.ts", "App.js",
	}
	for _, candidate := range candidates {
		path := filepath.Join(dir, candidate)
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, nil
		}
	}
	return "", fmt.Errorf("no Expo root component found; expected app/_layout.tsx, src/app/_layout.tsx, or App.tsx")
}

var (
	namedDefaultFunction = regexp.MustCompile(`(?m)^([\t ]*)export[\t ]+default[\t ]+(async[\t ]+)?function[\t ]+([A-Za-z_$][A-Za-z0-9_$]*)\b`)
	namedDefaultClass    = regexp.MustCompile(`(?m)^([\t ]*)export[\t ]+default[\t ]+class[\t ]+([A-Za-z_$][A-Za-z0-9_$]*)\b`)
	namedDefaultValue    = regexp.MustCompile(`(?m)^([\t ]*)export[\t ]+default[\t ]+([A-Za-z_$][A-Za-z0-9_$]*)[\t ]*;?[\t ]*$`)
)

func patchExpoRootSource(source, rootPath, integrationPath string) (string, bool, error) {
	if strings.Contains(source, "withYaverFeedback(") && strings.Contains(source, "YaverFeedbackRoot") {
		return source, false, nil
	}

	componentName := ""
	patched := source
	if match := namedDefaultFunction.FindStringSubmatchIndex(source); match != nil {
		componentName = source[match[6]:match[7]]
		asyncPrefix := ""
		if match[4] >= 0 {
			asyncPrefix = source[match[4]:match[5]]
		}
		replacement := source[match[2]:match[3]] + asyncPrefix + "function " + componentName
		patched = source[:match[0]] + replacement + source[match[1]:]
		patched = strings.TrimRight(patched, "\n") + "\n\nexport default withYaverFeedback(" + componentName + ");\n"
	} else if match := namedDefaultClass.FindStringSubmatchIndex(source); match != nil {
		componentName = source[match[4]:match[5]]
		replacement := source[match[2]:match[3]] + "class " + componentName
		patched = source[:match[0]] + replacement + source[match[1]:]
		patched = strings.TrimRight(patched, "\n") + "\n\nexport default withYaverFeedback(" + componentName + ");\n"
	} else if match := namedDefaultValue.FindStringSubmatchIndex(source); match != nil {
		componentName = source[match[4]:match[5]]
		replacement := source[match[2]:match[3]] + "export default withYaverFeedback(" + componentName + ");"
		patched = source[:match[0]] + replacement + source[match[1]:]
	} else {
		return source, false, fmt.Errorf("no supported named default export")
	}

	rel, err := filepath.Rel(filepath.Dir(rootPath), strings.TrimSuffix(integrationPath, filepath.Ext(integrationPath)))
	if err != nil {
		return source, false, fmt.Errorf("resolve integration import: %w", err)
	}
	rel = filepath.ToSlash(rel)
	if !strings.HasPrefix(rel, ".") {
		rel = "./" + rel
	}
	importLine := "import { withYaverFeedback } from '" + rel + "';\n"
	patched = insertAfterImportBlock(patched, importLine)
	return patched, true, nil
}

func insertAfterImportBlock(source, importLine string) string {
	lines := strings.SplitAfter(source, "\n")
	lastImportEnd := 0
	offset := 0
	inImport := false
	braceDepth := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inImport && strings.HasPrefix(trimmed, "import ") {
			inImport = true
			braceDepth = strings.Count(line, "{") - strings.Count(line, "}")
		} else if inImport {
			braceDepth += strings.Count(line, "{") - strings.Count(line, "}")
		}
		if inImport && braceDepth <= 0 && (strings.Contains(line, ";") || strings.Contains(trimmed, " from ") || (strings.HasPrefix(trimmed, "import '") || strings.HasPrefix(trimmed, "import \""))) {
			inImport = false
			lastImportEnd = offset + len(line)
		}
		offset += len(line)
		if lastImportEnd > 0 && !inImport && trimmed != "" && !strings.HasPrefix(trimmed, "import ") && offset > lastImportEnd {
			break
		}
	}
	if lastImportEnd == 0 {
		return importLine + source
	}
	return source[:lastImportEnd] + importLine + source[lastImportEnd:]
}

const yaverIntegrationSource = `// Generated by yaver integrate. Safe to regenerate.
import type { ComponentType } from 'react';
import { FeedbackModal, initExpo } from 'yaver-feedback-react-native';

initExpo();

export function withYaverFeedback<Props extends object>(RootComponent: ComponentType<Props>): ComponentType<Props> {
  function YaverEnabledRoot(props: Props) {
    return (
      <>
        <RootComponent {...props} />
        <FeedbackModal />
      </>
    );
  }

  YaverEnabledRoot.displayName = ` + "`" + `YaverEnabled(${RootComponent.displayName || RootComponent.name || 'App'})` + "`" + `;
  return YaverEnabledRoot;
}
`

func writeYaverIntegrationFile(path string) (bool, error) {
	if existing, err := os.ReadFile(path); err == nil {
		if string(existing) == yaverIntegrationSource {
			return false, nil
		}
		if !strings.HasPrefix(string(existing), "// Generated by yaver integrate.") {
			return false, fmt.Errorf("refusing to overwrite non-Yaver file %s; move it or choose a different path", path)
		}
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("read integration file %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, fmt.Errorf("create integration directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(yaverIntegrationSource), 0o644); err != nil {
		return false, fmt.Errorf("write integration file: %w", err)
	}
	return true, nil
}

func verifyExpoIntegration(dir, verify string, out io.Writer) ([]string, error) {
	if verify == "none" {
		return []string{"skipped"}, nil
	}
	expoBin := filepath.Join(dir, "node_modules", ".bin", "expo")
	if _, err := os.Stat(expoBin); err != nil {
		return nil, fmt.Errorf("verification requires installed project dependencies; rerun without --no-install or use --verify none")
	}
	checks := []string{}
	if err := runIntegrationCommand(dir, out, expoBin, "config", "--type", "public"); err != nil {
		return checks, fmt.Errorf("Expo config verification failed: %w", err)
	}
	checks = append(checks, "expo-config")

	if hasFile(dir, "tsconfig.json") {
		tscBin := filepath.Join(dir, "node_modules", ".bin", "tsc")
		if _, err := os.Stat(tscBin); err != nil {
			return checks, fmt.Errorf("TypeScript project has no local tsc; install project dependencies and retry")
		}
		if err := runIntegrationCommand(dir, out, tscBin, "--noEmit"); err != nil {
			return checks, fmt.Errorf("TypeScript verification failed: %w", err)
		}
		checks = append(checks, "typescript")
	}

	if verify == "web" {
		tmpDir, err := os.MkdirTemp("", "yaver-expo-web-verify-")
		if err != nil {
			return checks, fmt.Errorf("create web verification directory: %w", err)
		}
		defer os.RemoveAll(tmpDir)
		if err := runIntegrationCommand(dir, out, expoBin, "export", "--platform", "web", "--output-dir", tmpDir); err != nil {
			return checks, fmt.Errorf("Expo web bundle verification failed: %w", err)
		}
		if _, err := os.Stat(filepath.Join(tmpDir, "index.html")); err != nil {
			return checks, fmt.Errorf("Expo web export reported success but produced no index.html")
		}
		checks = append(checks, "expo-web-export")
	}
	return checks, nil
}

func relativeProjectPath(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return filepath.ToSlash(path)
	}
	return filepath.ToSlash(rel)
}

func snapshotIntegrationFiles(root string, relativePaths []string) map[string][]byte {
	out := make(map[string][]byte, len(relativePaths))
	for _, rel := range relativePaths {
		if data, err := os.ReadFile(filepath.Join(root, rel)); err == nil {
			out[rel] = data
		}
	}
	return out
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func infoMode(path string) os.FileMode {
	if info, err := os.Stat(path); err == nil {
		return info.Mode().Perm()
	}
	return 0o644
}

func integrationLogTail(log string, limit int) string {
	log = strings.TrimSpace(log)
	if limit <= 0 || len(log) <= limit {
		return log
	}
	return "…" + log[len(log)-limit:]
}
