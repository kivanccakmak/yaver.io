package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
)

func runRepo(args []string) {
	if len(args) == 0 {
		printRepoUsage()
		os.Exit(0)
	}

	switch args[0] {
	case "list", "ls":
		runRepoList()
	case "switch":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: yaver repo switch <name-or-path>")
			os.Exit(1)
		}
		runRepoSwitch(strings.Join(args[1:], " "))
	case "refresh":
		runRepoRefresh()
	case "current":
		runRepoCurrent()
	default:
		fmt.Fprintf(os.Stderr, "Unknown repo subcommand: %s\n\n", args[0])
		printRepoUsage()
		os.Exit(1)
	}
}

func printRepoUsage() {
	fmt.Print(`Usage:
  yaver repo list              List discovered projects
  yaver repo switch <query>    Switch working directory to a project
  yaver repo refresh           Re-run project discovery
  yaver repo current           Show current project context

Projects are auto-discovered from git repos in your home directory.
Works with or without GitHub/GitLab integration.
`)
}

func runRepoList() {
	projects := listDiscoveredProjects()
	if len(projects) == 0 {
		fmt.Println("No projects found. Run 'yaver repo refresh' to scan.")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tBRANCH\tPATH")
	for _, p := range projects {
		name := filepath.Base(p.Path)
		fmt.Fprintf(w, "%s\t%s\t%s\n", name, p.Branch, p.Path)
	}
	w.Flush()
}

func runRepoSwitch(query string) {
	match, err := findProject(query)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Try to update running agent's work directory
	_, err = localAgentRequest("POST", "/agent/workdir", map[string]interface{}{
		"workDir": match,
	})
	if err != nil {
		// Agent not running — just update config
		fmt.Printf("Agent not running. Setting default work directory.\n")
	} else {
		fmt.Printf("Switched to: %s\n", match)
	}

	// Persist in config
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not save config: %v\n", err)
		return
	}
	// Store preferred work dir (used on next serve start)
	// We don't add a field — the user uses --work-dir or we print instructions
	fmt.Printf("\nTo start the agent in this directory:\n")
	fmt.Printf("  yaver serve --work-dir %s\n", match)
	_ = cfg // suppress unused
}

func runRepoRefresh() {
	fmt.Println("Scanning for projects...")
	discoverProjects()
	fp, _ := projectsFilePath()
	fmt.Printf("Done. Projects saved to %s\n", fp)
}

func runRepoCurrent() {
	// Try to get from running agent
	resp, err := localAgentRequest("GET", "/agent/context", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Agent not running. Start with 'yaver serve'.")
		os.Exit(1)
	}

	if workDir, ok := resp["workDir"].(string); ok {
		fmt.Printf("Project: %s\n", filepath.Base(workDir))
		fmt.Printf("Path:    %s\n", workDir)
	}
	if branch, ok := resp["branch"].(string); ok && branch != "" {
		fmt.Printf("Branch:  %s\n", branch)
	}
	if langs, ok := resp["languages"].([]interface{}); ok && len(langs) > 0 {
		strs := make([]string, len(langs))
		for i, l := range langs {
			strs[i] = fmt.Sprint(l)
		}
		fmt.Printf("Langs:   %s\n", strings.Join(strs, ", "))
	}
}

// listDiscoveredProjects parses PROJECTS.md for project entries.
func listDiscoveredProjects() []projectInfo {
	fp, err := projectsFilePath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(fp)
	if err != nil {
		return nil
	}

	var projects []projectInfo
	lines := strings.Split(string(data), "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		// Projects appear as "### /path/to/project" in PROJECTS.md
		if strings.HasPrefix(line, "### /") || strings.HasPrefix(line, "### ~/") {
			path := strings.TrimPrefix(line, "### ")
			path = strings.TrimSpace(path)
			// Expand ~
			if strings.HasPrefix(path, "~/") {
				home, _ := os.UserHomeDir()
				path = filepath.Join(home, path[2:])
			}

			p := projectInfo{Path: path}
			// Look for branch in next few lines
			for j := i + 1; j < i+5 && j < len(lines); j++ {
				if strings.HasPrefix(lines[j], "- Branch: ") {
					p.Branch = strings.TrimPrefix(lines[j], "- Branch: ")
				}
			}
			projects = append(projects, p)
		}
	}
	return projects
}

// findProject fuzzy-matches a query against discovered projects.
// Matches by repo name, directory name, or path substring.
func findProject(query string) (string, error) {
	projects := listDiscoveredProjects()
	if len(projects) == 0 {
		// Try fresh discovery
		discoverProjects()
		projects = listDiscoveredProjects()
	}
	if len(projects) == 0 {
		return "", fmt.Errorf("no projects found")
	}

	query = strings.ToLower(query)

	// Exact name match first
	for _, p := range projects {
		name := strings.ToLower(filepath.Base(p.Path))
		if name == query {
			return p.Path, nil
		}
	}

	// Substring match
	var matches []projectInfo
	for _, p := range projects {
		lower := strings.ToLower(p.Path)
		name := strings.ToLower(filepath.Base(p.Path))
		if strings.Contains(name, query) || strings.Contains(lower, query) {
			matches = append(matches, p)
		}
	}

	if len(matches) == 0 {
		return "", fmt.Errorf("no project matching %q found. Run 'yaver repo list' to see available projects", query)
	}
	if len(matches) == 1 {
		return matches[0].Path, nil
	}

	// Multiple matches — prefer shortest name (most specific)
	best := matches[0]
	for _, m := range matches[1:] {
		if len(filepath.Base(m.Path)) < len(filepath.Base(best.Path)) {
			best = m
		}
	}
	return best.Path, nil
}
