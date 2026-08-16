package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Make
// ---------------------------------------------------------------------------

func mcpMakeTargets(dir string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	// Extract targets from Makefile
	out, err := runCmd("sh", "-c", fmt.Sprintf("cd %s && make -qp 2>/dev/null | awk -F: '/^[a-zA-Z0-9][^$#\\/\\t=]*:([^=]|$)/ {split($1,a,/ /); print a[1]}' | sort -u", dir))
	if err != nil || out == "" {
		// Fallback: grep for targets
		out, _ = runCmd("sh", "-c", fmt.Sprintf("grep -E '^[a-zA-Z_-]+:' %s/Makefile 2>/dev/null | cut -d: -f1 | sort -u", dir))
	}
	targets := strings.Split(strings.TrimSpace(out), "\n")
	return map[string]interface{}{"targets": targets, "count": len(targets)}
}

func mcpMakeRun(dir, target string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{}
	if target != "" {
		args = append(args, target)
	}
	cmd := osexec.Command("make", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"target":   target,
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpMakeClean(dir string) interface{} {
	return mcpMakeRun(dir, "clean")
}

// ---------------------------------------------------------------------------
// CMake
// ---------------------------------------------------------------------------

func mcpCMakeConfigure(dir, buildDir, generator string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	if buildDir == "" {
		buildDir = "build"
	}
	args := []string{"-B", buildDir, "-S", "."}
	if generator != "" {
		args = append(args, "-G", generator)
	}
	cmd := osexec.Command("cmake", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "build_dir": buildDir, "output": string(out)}
}

func mcpCMakeBuild(dir, buildDir string, parallel int) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	if buildDir == "" {
		buildDir = "build"
	}
	args := []string{"--build", buildDir}
	if parallel > 0 {
		args = append(args, "--parallel", fmt.Sprintf("%d", parallel))
	}
	cmd := osexec.Command("cmake", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpCMakeTest(dir, buildDir string) interface{} {
	if buildDir == "" {
		buildDir = "build"
	}
	cmd := osexec.Command("ctest", "--test-dir", buildDir, "--output-on-failure")
	if dir != "" {
		cmd.Dir = dir
	}
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpCMakeInstall(dir, buildDir string) interface{} {
	if buildDir == "" {
		buildDir = "build"
	}
	cmd := osexec.Command("cmake", "--install", buildDir)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

// ---------------------------------------------------------------------------
// GCC / Clang / LLVM
// ---------------------------------------------------------------------------

func mcpGCCCompile(file, output string, flags []string) interface{} {
	args := []string{"-o"}
	if output == "" {
		output = strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
	}
	args = append(args, output)
	args = append(args, flags...)
	args = append(args, file)
	out, err := runCmd("gcc", args...)
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": out}
	}
	return map[string]interface{}{"ok": true, "binary": output}
}

func mcpClangCompile(file, output string, flags []string) interface{} {
	args := []string{"-o"}
	if output == "" {
		output = strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
	}
	args = append(args, output)
	args = append(args, flags...)
	args = append(args, file)
	out, err := runCmd("clang", args...)
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": out}
	}
	return map[string]interface{}{"ok": true, "binary": output}
}

func mcpClangTidy(file, dir string) interface{} {
	args := []string{file}
	if dir != "" {
		args = append(args, "-p", dir)
	}
	out, err := runCmd("clang-tidy", args...)
	result := map[string]interface{}{"output": out, "clean": err == nil}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpClangFormat(file string, inPlace bool) interface{} {
	args := []string{}
	if inPlace {
		args = append(args, "-i")
	}
	args = append(args, file)
	out, err := runCmd("clang-format", args...)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	if inPlace {
		return map[string]interface{}{"ok": true, "formatted": file}
	}
	return map[string]interface{}{"formatted": out}
}

func mcpLLVMObjdump(file string) interface{} {
	out, err := runCmd("llvm-objdump", "-d", "--no-show-raw-insn", file)
	if err != nil {
		out, err = runCmd("objdump", "-d", file)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	}
	// Truncate
	lines := strings.Split(out, "\n")
	if len(lines) > 100 {
		out = strings.Join(lines[:100], "\n") + fmt.Sprintf("\n... (%d more lines)", len(lines)-100)
	}
	return map[string]interface{}{"disassembly": out}
}

func mcpLLVMSize(file string) interface{} {
	out, err := runCmd("llvm-size", file)
	if err != nil {
		out, err = runCmd("size", file)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	}
	return map[string]interface{}{"sizes": out}
}

func mcpLLVMNM(file string) interface{} {
	out, err := runCmd("llvm-nm", file)
	if err != nil {
		out, err = runCmd("nm", file)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	}
	lines := strings.Split(out, "\n")
	if len(lines) > 100 {
		out = strings.Join(lines[:100], "\n") + fmt.Sprintf("\n... (%d more symbols)", len(lines)-100)
	}
	return map[string]interface{}{"symbols": out}
}

func mcpCompilerVersion(compiler string) interface{} {
	out, err := runCmd(compiler, "--version")
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("%s: %s", compiler, err)}
	}
	return map[string]interface{}{"compiler": compiler, "version": strings.Split(out, "\n")[0]}
}

// ---------------------------------------------------------------------------
// Rust / Cargo (full suite)
// ---------------------------------------------------------------------------

func mcpCargoCommand(dir, command string, args []string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	allArgs := append([]string{command}, args...)
	cmd := osexec.Command("cargo", allArgs...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"command":  "cargo " + command,
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpCargoBuild(dir string, release bool) interface{} {
	args := []string{}
	if release {
		args = append(args, "--release")
	}
	return mcpCargoCommand(dir, "build", args)
}

func mcpCargoTest(dir, testName string) interface{} {
	args := []string{}
	if testName != "" {
		args = append(args, testName)
	}
	return mcpCargoCommand(dir, "test", args)
}

func mcpCargoClippy(dir string) interface{} {
	return mcpCargoCommand(dir, "clippy", []string{"--", "-W", "clippy::pedantic"})
}

func mcpCargoFmt(dir string, check bool) interface{} {
	args := []string{}
	if check {
		args = append(args, "--check")
	}
	return mcpCargoCommand(dir, "fmt", args)
}

func mcpCargoDoc(dir string, open bool) interface{} {
	args := []string{"--no-deps"}
	if open {
		args = append(args, "--open")
	}
	return mcpCargoCommand(dir, "doc", args)
}

func mcpCargoBench(dir, bench string) interface{} {
	args := []string{}
	if bench != "" {
		args = append(args, bench)
	}
	return mcpCargoCommand(dir, "bench", args)
}

func mcpCargoTree(dir string, depth int) interface{} {
	args := []string{}
	if depth > 0 {
		args = append(args, "--depth", fmt.Sprintf("%d", depth))
	}
	return mcpCargoCommand(dir, "tree", args)
}

func mcpCargoUpdate(dir string) interface{} {
	return mcpCargoCommand(dir, "update", nil)
}

func mcpCargoAudit(dir string) interface{} {
	return mcpCargoCommand(dir, "audit", nil)
}

func mcpCargoCheck(dir string) interface{} {
	return mcpCargoCommand(dir, "check", nil)
}

func mcpCargoClean(dir string) interface{} {
	return mcpCargoCommand(dir, "clean", nil)
}

func mcpCargoAdd(dir, crate string) interface{} {
	return mcpCargoCommand(dir, "add", []string{crate})
}

func mcpCargoRemove(dir, crate string) interface{} {
	return mcpCargoCommand(dir, "remove", []string{crate})
}

// ---------------------------------------------------------------------------
// Go (full suite)
// ---------------------------------------------------------------------------

func mcpGoCommand(dir, command string, args []string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	allArgs := append([]string{command}, args...)
	cmd := osexec.Command("go", allArgs...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"command":  "go " + command,
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpGoBuild(dir, output string) interface{} {
	args := []string{"./..."}
	if output != "" {
		args = []string{"-o", output, "."}
	}
	return mcpGoCommand(dir, "build", args)
}

func mcpGoTest(dir string, verbose, race, cover bool) interface{} {
	args := []string{"./..."}
	if verbose {
		args = append([]string{"-v"}, args...)
	}
	if race {
		args = append([]string{"-race"}, args...)
	}
	if cover {
		args = append([]string{"-cover"}, args...)
	}
	return mcpGoCommand(dir, "test", args)
}

func mcpGoVet(dir string) interface{} {
	return mcpGoCommand(dir, "vet", []string{"./..."})
}

func mcpGoModTidy(dir string) interface{} {
	return mcpGoCommand(dir, "mod", []string{"tidy"})
}

func mcpGoModGraph(dir string) interface{} {
	return mcpGoCommand(dir, "mod", []string{"graph"})
}

func mcpGoModWhy(dir, module string) interface{} {
	return mcpGoCommand(dir, "mod", []string{"why", module})
}

func mcpGoGenerate(dir string) interface{} {
	return mcpGoCommand(dir, "generate", []string{"./..."})
}

func mcpGoFmt(dir string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	out, err := runCmd("sh", "-c", fmt.Sprintf("cd %s && gofmt -l .", dir))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	if out == "" {
		return map[string]interface{}{"formatted": true, "output": "All files properly formatted"}
	}
	return map[string]interface{}{"formatted": false, "unformatted_files": out}
}

func mcpGolangciLint(dir string) interface{} {
	return mcpGoCommand(dir, "", nil) // Won't work, need direct call
}

func mcpGoStaticcheck(dir string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	cmd := osexec.Command("staticcheck", "./...")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	result := map[string]interface{}{"output": string(out), "clean": err == nil}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpGoVulncheck(dir string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	cmd := osexec.Command("govulncheck", "./...")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	result := map[string]interface{}{"output": string(out), "clean": err == nil}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// ---------------------------------------------------------------------------
// Python (full suite)
// ---------------------------------------------------------------------------

func mcpPythonCommand(dir, tool string, args []string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	cmd := osexec.Command(tool, args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"command":  tool + " " + strings.Join(args, " "),
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpPytest(dir string, verbose, coverage bool, marker string) interface{} {
	args := []string{}
	if verbose {
		args = append(args, "-v")
	}
	if coverage {
		args = append(args, "--cov", "--cov-report=term-missing")
	}
	if marker != "" {
		args = append(args, "-m", marker)
	}
	return mcpPythonCommand(dir, "pytest", args)
}

func mcpRuff(dir, action string) interface{} {
	switch action {
	case "check", "":
		return mcpPythonCommand(dir, "ruff", []string{"check", "."})
	case "format":
		return mcpPythonCommand(dir, "ruff", []string{"format", "."})
	case "fix":
		return mcpPythonCommand(dir, "ruff", []string{"check", "--fix", "."})
	default:
		return map[string]interface{}{"error": "action: check, format, fix"}
	}
}

func mcpMypy(dir string) interface{} {
	return mcpPythonCommand(dir, "mypy", []string{"."})
}

func mcpBlack(dir string, check bool) interface{} {
	args := []string{"."}
	if check {
		args = append(args, "--check")
	}
	return mcpPythonCommand(dir, "black", args)
}

func mcpPipCompile(dir string) interface{} {
	return mcpPythonCommand(dir, "pip-compile", []string{"requirements.in"})
}

func mcpUVInstall(dir string) interface{} {
	return mcpPythonCommand(dir, "uv", []string{"pip", "install", "-r", "requirements.txt"})
}

// ---------------------------------------------------------------------------
// Node.js / TypeScript (full suite)
// ---------------------------------------------------------------------------

func mcpNPMRun(dir, script string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	if script == "" {
		// List scripts
		cmd := osexec.Command("npm", "run")
		cmd.Dir = dir
		out, _ := cmd.CombinedOutput()
		return map[string]interface{}{"scripts": string(out)}
	}
	cmd := osexec.Command("npm", "run", script)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"script":   script,
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

func mcpTSC(dir string, noEmit bool) interface{} {
	args := []string{"tsc"}
	if noEmit {
		args = append(args, "--noEmit")
	}
	return mcpPythonCommand(dir, "npx", args) // reuse runner
}

func mcpESLint(dir string, fix bool) interface{} {
	args := []string{"eslint", "."}
	if fix {
		args = append(args, "--fix")
	}
	return mcpPythonCommand(dir, "npx", args)
}

func mcpPrettier(dir string, check bool) interface{} {
	args := []string{"prettier"}
	if check {
		args = append(args, "--check", ".")
	} else {
		args = append(args, "--write", ".")
	}
	return mcpPythonCommand(dir, "npx", args)
}

func mcpBiome(dir, action string) interface{} {
	switch action {
	case "check", "":
		return mcpPythonCommand(dir, "npx", []string{"biome", "check", "."})
	case "format":
		return mcpPythonCommand(dir, "npx", []string{"biome", "format", ".", "--write"})
	case "lint":
		return mcpPythonCommand(dir, "npx", []string{"biome", "lint", "."})
	default:
		return map[string]interface{}{"error": "action: check, format, lint"}
	}
}
