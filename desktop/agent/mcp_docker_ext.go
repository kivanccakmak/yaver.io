package main

import (
	"encoding/json"
	"fmt"
	osexec "os/exec"
	"strings"
)

// ---------------------------------------------------------------------------
// Docker extended operations — real tools with parsed output
// ---------------------------------------------------------------------------

func mcpDockerPrune(what string) interface{} {
	switch what {
	case "containers":
		out, err := runCmd("docker", "container", "prune", "-f")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"pruned": "containers", "output": out}
	case "images":
		out, err := runCmd("docker", "image", "prune", "-af")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"pruned": "images", "output": out}
	case "volumes":
		out, err := runCmd("docker", "volume", "prune", "-f")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"pruned": "volumes", "output": out}
	case "networks":
		out, err := runCmd("docker", "network", "prune", "-f")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"pruned": "networks", "output": out}
	case "all", "system":
		out, err := runCmd("docker", "system", "prune", "-af", "--volumes")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{"pruned": "all", "output": out}
	default:
		return map[string]interface{}{"error": "what must be: containers, images, volumes, networks, all"}
	}
}

func mcpDockerDiskUsage() interface{} {
	out, err := runCmd("docker", "system", "df", "-v")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"usage": out}
}

func mcpDockerNetworks() interface{} {
	out, err := runCmd("docker", "network", "ls", "--format", "{{.ID}}\t{{.Name}}\t{{.Driver}}\t{{.Scope}}")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"networks": out}
}

func mcpDockerVolumes() interface{} {
	out, err := runCmd("docker", "volume", "ls", "--format", "{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"volumes": out}
}

func mcpDockerInspect(target string) interface{} {
	out, err := runCmd("docker", "inspect", target)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("docker inspect: %s — %s", err, out)}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return result
}

func mcpDockerStats() interface{} {
	out, err := runCmd("docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}")
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"stats": out}
}

func mcpDockerBuild(dir, tag, dockerfile string) interface{} {
	args := []string{"build"}
	if tag != "" {
		args = append(args, "-t", tag)
	}
	if dockerfile != "" {
		args = append(args, "-f", dockerfile)
	}
	args = append(args, ".")
	cmd := osexec.Command("docker", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "tag": tag, "output": string(out)}
}

func mcpDockerPull(image string) interface{} {
	out, err := runCmd("docker", "pull", image)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "image": image, "output": out}
}

func mcpDockerPush(image string) interface{} {
	out, err := runCmd("docker", "push", image)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "image": image, "output": out}
}

func mcpDockerStop(container string) interface{} {
	out, err := runCmd("docker", "stop", container)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "stopped": out}
}

func mcpDockerStart(container string) interface{} {
	out, err := runCmd("docker", "start", container)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "started": out}
}

func mcpDockerRestart(container string) interface{} {
	out, err := runCmd("docker", "restart", container)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "restarted": out}
}

func mcpDockerRm(container string, force bool) interface{} {
	args := []string{"rm"}
	if force {
		args = append(args, "-f")
	}
	args = append(args, container)
	out, err := runCmd("docker", args...)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "removed": out}
}

func mcpDockerRmi(image string, force bool) interface{} {
	args := []string{"rmi"}
	if force {
		args = append(args, "-f")
	}
	args = append(args, image)
	out, err := runCmd("docker", args...)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "removed": out}
}

func mcpDockerTop(container string) interface{} {
	out, err := runCmd("docker", "top", container)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"processes": out}
}

func mcpDockerPort(container string) interface{} {
	out, err := runCmd("docker", "port", container)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ports": out}
}

func mcpDockerCp(src, dst string) interface{} {
	out, err := runCmd("docker", "cp", src, dst)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("%s — %s", err, out)}
	}
	return map[string]interface{}{"ok": true, "from": src, "to": dst}
}

func mcpDockerHistory(image string) interface{} {
	out, err := runCmd("docker", "history", "--no-trunc", image)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"history": out}
}

// ---------------------------------------------------------------------------
// Git extended operations
// ---------------------------------------------------------------------------

func mcpGitStash(action, message string) interface{} {
	switch action {
	case "list":
		out, _ := gitCmd(".", "stash", "list")
		return map[string]interface{}{"stashes": out}
	case "save", "push":
		args := []string{"stash", "push"}
		if message != "" {
			args = append(args, "-m", message)
		}
		out, err := gitCmd(".", args...)
		if err != nil {
			return map[string]interface{}{"error": out}
		}
		return map[string]interface{}{"ok": true, "output": out}
	case "pop":
		out, err := gitCmd(".", "stash", "pop")
		if err != nil {
			return map[string]interface{}{"error": out}
		}
		return map[string]interface{}{"ok": true, "output": out}
	case "apply":
		out, err := gitCmd(".", "stash", "apply")
		if err != nil {
			return map[string]interface{}{"error": out}
		}
		return map[string]interface{}{"ok": true, "output": out}
	case "drop":
		out, err := gitCmd(".", "stash", "drop")
		if err != nil {
			return map[string]interface{}{"error": out}
		}
		return map[string]interface{}{"ok": true, "output": out}
	default:
		return map[string]interface{}{"error": "action: list, save, pop, apply, drop"}
	}
}

func mcpGitBlame(file string, lines string) interface{} {
	args := []string{"blame"}
	if lines != "" {
		args = append(args, "-L", lines)
	}
	args = append(args, file)
	out, err := gitCmd(".", args...)
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	return map[string]interface{}{"blame": out}
}

func mcpGitLogAdvanced(dir string, author, since, until, path string, n int) interface{} {
	if dir == "" {
		dir = "."
	}
	args := []string{"log", "--oneline"}
	if n > 0 {
		args = append(args, fmt.Sprintf("-%d", n))
	} else {
		args = append(args, "-20")
	}
	if author != "" {
		args = append(args, "--author="+author)
	}
	if since != "" {
		args = append(args, "--since="+since)
	}
	if until != "" {
		args = append(args, "--until="+until)
	}
	if path != "" {
		args = append(args, "--", path)
	}
	out, _ := gitCmd(dir, args...)
	return map[string]interface{}{"log": out}
}

func mcpGitBranches(dir string) interface{} {
	if dir == "" {
		dir = "."
	}
	out, _ := gitCmd(dir, "branch", "-a", "-v", "--sort=-committerdate")
	return map[string]interface{}{"branches": out}
}

func mcpGitTags(dir string) interface{} {
	if dir == "" {
		dir = "."
	}
	out, _ := gitCmd(dir, "tag", "--sort=-creatordate", "-n1")
	return map[string]interface{}{"tags": out}
}

func mcpGitRemotes(dir string) interface{} {
	if dir == "" {
		dir = "."
	}
	out, _ := gitCmd(dir, "remote", "-v")
	return map[string]interface{}{"remotes": out}
}

func mcpGitReflog(dir string, n int) interface{} {
	if dir == "" {
		dir = "."
	}
	if n <= 0 {
		n = 20
	}
	out, _ := gitCmd(dir, "reflog", "--oneline", fmt.Sprintf("-%d", n))
	return map[string]interface{}{"reflog": out}
}

func mcpGitShortlog(dir string) interface{} {
	if dir == "" {
		dir = "."
	}
	out, _ := gitCmd(dir, "shortlog", "-sne", "--all")
	return map[string]interface{}{"authors": out}
}

// ---------------------------------------------------------------------------
// Helm
// ---------------------------------------------------------------------------

func mcpHelmList(namespace string) interface{} {
	args := []string{"list"}
	if namespace != "" {
		args = append(args, "-n", namespace)
	} else {
		args = append(args, "--all-namespaces")
	}
	args = append(args, "--output", "json")
	out, err := runCmd("helm", args...)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("helm: %s — %s", err, out)}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return map[string]interface{}{"releases": result}
}

func mcpHelmStatus(release, namespace string) interface{} {
	args := []string{"status", release, "--output", "json"}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	out, err := runCmd("helm", args...)
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return result
}

func mcpHelmValues(release, namespace string) interface{} {
	args := []string{"get", "values", release, "--output", "json"}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	out, err := runCmd("helm", args...)
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return result
}

func mcpHelmSearch(query string) interface{} {
	out, err := runCmd("helm", "search", "hub", query, "--output", "json")
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return map[string]interface{}{"charts": result}
}

func mcpHelmRepos() interface{} {
	out, err := runCmd("helm", "repo", "list", "--output", "json")
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return map[string]interface{}{"repos": result}
}

func mcpHelmHistory(release, namespace string) interface{} {
	args := []string{"history", release, "--output", "json"}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	out, err := runCmd("helm", args...)
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return map[string]interface{}{"history": result}
}

// ---------------------------------------------------------------------------
// System — real tools with parsed output
// ---------------------------------------------------------------------------

func mcpFreeMemory() interface{} {
	out, err := runCmd("free", "-h")
	if err != nil {
		// macOS doesn't have free, use vm_stat
		out, err = runCmd("vm_stat")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	}
	return map[string]interface{}{"memory": out}
}

func mcpListenPorts() interface{} {
	out, err := runCmd("ss", "-tlnp")
	if err != nil {
		out, err = runCmd("lsof", "-i", "-P", "-n")
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
	}
	return map[string]interface{}{"ports": out}
}

func mcpFindLargeFiles(dir string, sizeMB int) interface{} {
	if dir == "" {
		dir = "."
	}
	if sizeMB <= 0 {
		sizeMB = 100
	}
	out, _ := runCmd("find", dir, "-type", "f", "-size", fmt.Sprintf("+%dM", sizeMB),
		"-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*",
		"-exec", "ls", "-lh", "{}", ";")
	if out == "" {
		return map[string]interface{}{"files": "none found", "threshold_mb": sizeMB}
	}
	return map[string]interface{}{"files": out, "threshold_mb": sizeMB}
}

func mcpTreeDir(dir string, depth int) interface{} {
	if dir == "" {
		dir = "."
	}
	if depth <= 0 {
		depth = 3
	}
	out, err := runCmd("tree", "-L", fmt.Sprintf("%d", depth), "--dirsfirst", "-I", "node_modules|.git|__pycache__|.next|dist|build", dir)
	if err != nil {
		// Fallback to find
		out, _ = runCmd("find", dir, "-maxdepth", fmt.Sprintf("%d", depth), "-type", "d",
			"-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*")
	}
	return map[string]interface{}{"tree": out}
}

func mcpLinesOfCode(dir string) interface{} {
	if dir == "" {
		dir = "."
	}
	// Try tokei, scc, cloc in order
	out, err := runCmd("tokei", dir)
	if err != nil {
		out, err = runCmd("scc", dir)
		if err != nil {
			out, err = runCmd("cloc", dir)
			if err != nil {
				// Fallback: simple find + wc
				out, _ = runCmd("sh", "-c", fmt.Sprintf("find %s -type f \\( -name '*.go' -o -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.rs' -o -name '*.java' -o -name '*.rb' -o -name '*.php' -o -name '*.c' -o -name '*.cpp' -o -name '*.swift' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' | xargs wc -l 2>/dev/null | tail -1", dir))
			}
		}
	}
	return map[string]interface{}{"stats": out}
}

// Unused import guards
var _ = strings.TrimSpace
