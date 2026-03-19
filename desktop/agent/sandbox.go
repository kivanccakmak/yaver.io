package main

import (
	"fmt"
	"regexp"
	"strings"
)

// SandboxConfig controls command validation before execution.
type SandboxConfig struct {
	Enabled          bool     `json:"enabled"`
	AllowSudo        bool     `json:"allow_sudo,omitempty"`
	AllowedPaths     []string `json:"allowed_paths,omitempty"`
	BlockedCommands  []string `json:"blocked_commands,omitempty"`
	MaxOutputSizeMB  int      `json:"max_output_size_mb,omitempty"`
}

// DefaultSandboxConfig returns secure defaults.
func DefaultSandboxConfig() SandboxConfig {
	return SandboxConfig{
		Enabled:         true,
		AllowSudo:       false,
		MaxOutputSizeMB: 100,
	}
}

// dangerousPatterns are regex patterns that match dangerous commands.
// Each pattern has a human-readable reason for the block.
var dangerousPatterns = []struct {
	pattern *regexp.Regexp
	reason  string
}{
	// Filesystem destruction — broad recursive removal of critical paths
	// Match rm with any combination of -r, -f, -rf, -fr flags, targeting dangerous paths
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*(/\s*$|/\s)`), "recursive removal of root"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*(~|~/)(\s|$)`), "recursive removal of home directory"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*\$HOME(\s|$|/)`), "recursive removal of $HOME"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*\$\{HOME\}(\s|$|/)`), "recursive removal of ${HOME}"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/boot(\s|$|/)`), "removal of /boot"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/etc(\s|$|/)`), "removal of /etc"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/usr(\s|$|/)`), "removal of /usr"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/var(\s|$|/)`), "removal of /var"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/sys(\s|$|/)`), "removal of /sys"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/proc(\s|$|/)`), "removal of /proc"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/lib(\s|$|/)`), "removal of /lib"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/bin(\s|$|/)`), "removal of /bin"},
	{regexp.MustCompile(`\brm\s+(-\w+\s+)*/sbin(\s|$|/)`), "removal of /sbin"},

	// Disk/partition manipulation
	{regexp.MustCompile(`\bmkfs\b`), "filesystem creation on block device"},
	{regexp.MustCompile(`\bdd\s+.*\bof=/dev/`), "raw write to block device"},
	{regexp.MustCompile(`\bfdisk\b`), "partition table manipulation"},
	{regexp.MustCompile(`\bparted\b`), "partition manipulation"},
	{regexp.MustCompile(`\bshred\b`), "secure file destruction"},

	// Encryption/ransomware patterns
	{regexp.MustCompile(`\bgpg\s+.*--encrypt\s+.*(-r|--recipient)\s+.*(/|~|\$HOME)`), "bulk encryption of home/root"},
	{regexp.MustCompile(`\bopenssl\s+enc\s+.*(-in\s+/|-in\s+~)`), "encrypting system files with openssl"},
	{regexp.MustCompile(`\bfind\s+/\s+.*-exec.*openssl\s+enc`), "bulk encryption via find"},
	{regexp.MustCompile(`\bfind\s+/\s+.*-exec.*gpg.*--encrypt`), "bulk encryption via find"},

	// System compromise
	{regexp.MustCompile(`\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)*777\s+/\s*$`), "chmod 777 on root"},
	{regexp.MustCompile(`\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)*777\s+/etc\b`), "chmod 777 on /etc"},
	{regexp.MustCompile(`\bchown\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)*.*\s+/\s*$`), "chown on root filesystem"},
	{regexp.MustCompile(`>\s*/etc/passwd\b`), "overwriting /etc/passwd"},
	{regexp.MustCompile(`>\s*/etc/shadow\b`), "overwriting /etc/shadow"},
	{regexp.MustCompile(`\bcrontab\s+-r\b`), "removing all cron jobs"},

	// Network exfiltration — piping sensitive files to remote
	{regexp.MustCompile(`\bcurl\b.*\|\s*(ba)?sh\b`), "piping remote content to shell"},
	{regexp.MustCompile(`\bwget\b.*\|\s*(ba)?sh\b`), "piping remote content to shell"},
	{regexp.MustCompile(`\bcurl\b.*-[a-zA-Z]*d\s*@(/etc/passwd|/etc/shadow|~/.ssh)`), "exfiltrating sensitive files via curl"},

	// Process kill-all
	{regexp.MustCompile(`\bkillall\s+-9\b`), "force killing all processes by name"},
	{regexp.MustCompile(`\bpkill\s+-9\s+\.\*`), "force killing all matching processes"},
	{regexp.MustCompile(`\bkill\s+-9\s+-1\b`), "killing all user processes"},

	// Fork bomb
	{regexp.MustCompile(`:\(\)\{.*\|.*&\s*\}`), "fork bomb"},
	{regexp.MustCompile(`\bwhile\s+true.*fork\b`), "fork bomb variant"},

	// Systemd / init system abuse
	{regexp.MustCompile(`\bsystemctl\s+(stop|disable|mask)\s+(sshd|networking|network-manager|firewalld|iptables)\b`), "disabling critical system services"},

	// Kernel module manipulation
	{regexp.MustCompile(`\binsmod\b`), "inserting kernel module"},
	{regexp.MustCompile(`\brmmod\b`), "removing kernel module"},
	{regexp.MustCompile(`\bmodprobe\s+-r\b`), "removing kernel module"},
}

// sudoPattern matches commands starting with sudo, su, or doas.
var sudoPattern = regexp.MustCompile(`^\s*(sudo\b|su\s|doas\b)`)

// ValidateCommand checks a command string against the sandbox rules.
// Returns nil if the command is allowed, or an error describing why it was blocked.
func ValidateCommand(cmd string, cfg SandboxConfig) error {
	if !cfg.Enabled {
		return nil
	}

	// Normalize: collapse whitespace, trim
	normalized := strings.TrimSpace(cmd)
	if normalized == "" {
		return nil
	}

	// Check sudo/su/doas
	if !cfg.AllowSudo && sudoPattern.MatchString(normalized) {
		return fmt.Errorf("sandbox: blocked privilege escalation (%s) — enable with sandbox.allow_sudo=true", extractFirstWord(normalized))
	}

	// Check user-defined blocked commands
	for _, blocked := range cfg.BlockedCommands {
		if strings.Contains(normalized, blocked) {
			return fmt.Errorf("sandbox: blocked by custom rule — command contains '%s'", blocked)
		}
	}

	// Check dangerous patterns
	for _, dp := range dangerousPatterns {
		if dp.pattern.MatchString(normalized) {
			return fmt.Errorf("sandbox: blocked dangerous command — %s", dp.reason)
		}
	}

	// For piped commands, validate each segment
	if strings.Contains(normalized, "|") {
		segments := strings.Split(normalized, "|")
		for _, seg := range segments {
			seg = strings.TrimSpace(seg)
			if seg == "" {
				continue
			}
			if err := validateSegment(seg, cfg); err != nil {
				return err
			}
		}
	}

	// For chained commands (&&, ;), validate each
	for _, sep := range []string{"&&", ";"} {
		if strings.Contains(normalized, sep) {
			parts := strings.Split(normalized, sep)
			for _, part := range parts {
				part = strings.TrimSpace(part)
				if part == "" {
					continue
				}
				if err := validateSegment(part, cfg); err != nil {
					return err
				}
			}
		}
	}

	return nil
}

// validateSegment checks a single command segment (no pipes).
func validateSegment(seg string, cfg SandboxConfig) error {
	if !cfg.AllowSudo && sudoPattern.MatchString(seg) {
		return fmt.Errorf("sandbox: blocked privilege escalation in pipe/chain — %s", extractFirstWord(seg))
	}
	for _, dp := range dangerousPatterns {
		if dp.pattern.MatchString(seg) {
			return fmt.Errorf("sandbox: blocked dangerous command in pipe/chain — %s", dp.reason)
		}
	}
	return nil
}

// ValidateWorkDir ensures the work directory is within allowed paths (if configured).
func ValidateWorkDir(workDir string, cfg SandboxConfig) error {
	if !cfg.Enabled || len(cfg.AllowedPaths) == 0 {
		return nil
	}
	for _, allowed := range cfg.AllowedPaths {
		if strings.HasPrefix(workDir, allowed) {
			return nil
		}
	}
	return fmt.Errorf("sandbox: work directory %s is not within allowed paths %v", workDir, cfg.AllowedPaths)
}

func extractFirstWord(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexAny(s, " \t"); idx > 0 {
		return s[:idx]
	}
	return s
}
