package main

// getMCPToolsList returns the full MCP tools list for tools/list responses.
func (s *HTTPServer) getMCPToolsList() interface{} {
	tools := []map[string]interface{}{
		// --- Task Management ---
		{
			"name":        "create_task",
			"description": "Create a new coding task. The AI runner will execute this task on the connected development machine.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"prompt"},
				"properties": map[string]interface{}{
					"prompt": map[string]interface{}{
						"type":        "string",
						"description": "The task prompt describing what the AI should do",
					},
					"verbosity": map[string]interface{}{
						"type":        "integer",
						"description": "Response detail level 0-10. 0=minimal ('done, no issues'), 5=moderate (key changes + reasoning), 10=full (all diffs, reasoning, alternatives). Default: 10.",
						"minimum":     0,
						"maximum":     10,
					},
				},
			},
		},
		{
			"name":        "list_tasks",
			"description": "List all tasks and their current status (queued, running, completed, failed, stopped).",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "get_task",
			"description": "Get detailed information about a specific task, including its full output.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id"},
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "The task ID",
					},
				},
			},
		},
		{
			"name":        "stop_task",
			"description": "Stop a running task.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id"},
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "The task ID to stop",
					},
				},
			},
		},
		{
			"name":        "continue_task",
			"description": "Continue a stopped task with additional input/instructions.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id", "input"},
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "The task ID to continue",
					},
					"input": map[string]interface{}{
						"type":        "string",
						"description": "Follow-up instructions for the task",
					},
				},
			},
		},
		{
			"name":        "get_info",
			"description": "Get information about the connected development machine (hostname, working directory, version).",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		// --- Runner Management ---
		{
			"name":        "list_runners",
			"description": "List available AI runners (Claude Code, Codex, Aider, etc.) with install status.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "switch_runner",
			"description": "Switch the active AI runner. Available: claude, codex, aider.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"runner_id"},
				"properties": map[string]interface{}{
					"runner_id": map[string]interface{}{
						"type":        "string",
						"description": "Runner ID (claude, codex, aider)",
					},
				},
			},
		},
		// --- System & Config ---
		{
			"name":        "get_system_info",
			"description": "Get detailed system info: OS, arch, memory, hostname, running tasks.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "get_config",
			"description": "Get agent configuration (sandbox, auto-start, relay, email, ACL peers).",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "set_work_dir",
			"description": "Change the agent's working directory for task execution.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"path"},
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "Absolute path to the new working directory",
					},
				},
			},
		},
		{
			"name":        "list_projects",
			"description": "List discovered git projects on this machine.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		// --- Relay Management ---
		{
			"name":        "get_relay_config",
			"description": "List configured relay servers.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "add_relay_server",
			"description": "Add a relay server for NAT traversal.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"quic_addr"},
				"properties": map[string]interface{}{
					"quic_addr": map[string]interface{}{"type": "string", "description": "QUIC address (host:port)"},
					"http_url":  map[string]interface{}{"type": "string", "description": "HTTP proxy URL"},
					"password":  map[string]interface{}{"type": "string", "description": "Relay password"},
					"label":     map[string]interface{}{"type": "string", "description": "Human-friendly label"},
				},
			},
		},
		{
			"name":        "remove_relay_server",
			"description": "Remove a relay server by ID.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"relay_id"},
				"properties": map[string]interface{}{
					"relay_id": map[string]interface{}{"type": "string", "description": "Relay server ID to remove"},
				},
			},
		},
		// --- Filesystem ---
		{
			"name":        "read_file",
			"description": "Read contents of a file. Limited to 100KB.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"path"},
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "File path (absolute or relative to work dir)"},
				},
			},
		},
		{
			"name":        "write_file",
			"description": "Write content to a file. Creates parent directories if needed.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"path", "content"},
				"properties": map[string]interface{}{
					"path":    map[string]interface{}{"type": "string", "description": "File path"},
					"content": map[string]interface{}{"type": "string", "description": "File content"},
				},
			},
		},
		{
			"name":        "list_directory",
			"description": "List files and directories at a path.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "Directory path (default: work dir)"},
				},
			},
		},
		{
			"name":        "search_files",
			"description": "Search for files by name pattern (glob) or content (grep).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"pattern": map[string]interface{}{"type": "string", "description": "File name glob pattern (e.g. '*.go')"},
					"content": map[string]interface{}{"type": "string", "description": "Search within file contents"},
					"path":    map[string]interface{}{"type": "string", "description": "Search root (default: work dir)"},
				},
			},
		},
		// --- Email ---
		{
			"name":        "email_list_inbox",
			"description": "List inbox or sent emails. Requires email to be configured (yaver email setup).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"folder": map[string]interface{}{"type": "string", "description": "inbox, sent, or all", "enum": []string{"inbox", "sent", "all"}},
					"search": map[string]interface{}{"type": "string", "description": "Search in subject, sender, body"},
					"limit":  map[string]interface{}{"type": "integer", "description": "Max results (default 20)"},
				},
			},
		},
		{
			"name":        "email_get",
			"description": "Get full email details by ID.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"email_id"},
				"properties": map[string]interface{}{
					"email_id": map[string]interface{}{"type": "string", "description": "Email ID"},
				},
			},
		},
		{
			"name":        "email_send",
			"description": "Send a plain text email.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"to", "subject", "body"},
				"properties": map[string]interface{}{
					"to":      map[string]interface{}{"type": "string", "description": "Recipient email"},
					"subject": map[string]interface{}{"type": "string", "description": "Subject line"},
					"body":    map[string]interface{}{"type": "string", "description": "Email body (plain text)"},
					"cc":      map[string]interface{}{"type": "string", "description": "CC recipients (comma-separated)"},
				},
			},
		},
		{
			"name":        "email_sync",
			"description": "Sync emails from provider (Office 365 or Gmail) to local database.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "email_search",
			"description": "Search synced emails in local database.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"query"},
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "Search keyword"},
					"limit": map[string]interface{}{"type": "integer", "description": "Max results (default 20)"},
				},
			},
		},
		// --- ACL (Agent Communication Layer) ---
		{
			"name":        "acl_list_peers",
			"description": "List connected MCP peers (other AI tools, databases, services).",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "acl_add_peer",
			"description": "Connect to another MCP server (local or remote).",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"name", "url"},
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string", "description": "Peer name"},
					"url":  map[string]interface{}{"type": "string", "description": "MCP endpoint URL"},
					"auth": map[string]interface{}{"type": "string", "description": "Bearer token"},
				},
			},
		},
		{
			"name":        "acl_remove_peer",
			"description": "Disconnect from an MCP peer.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"peer_id"},
				"properties": map[string]interface{}{
					"peer_id": map[string]interface{}{"type": "string", "description": "Peer ID to remove"},
				},
			},
		},
		{
			"name":        "acl_list_peer_tools",
			"description": "List all tools available from a connected MCP peer.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"peer_id"},
				"properties": map[string]interface{}{
					"peer_id": map[string]interface{}{"type": "string", "description": "Peer ID"},
				},
			},
		},
		{
			"name":        "acl_call_peer_tool",
			"description": "Call a tool on a connected MCP peer.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"peer_id", "tool_name"},
				"properties": map[string]interface{}{
					"peer_id":   map[string]interface{}{"type": "string", "description": "Peer ID"},
					"tool_name": map[string]interface{}{"type": "string", "description": "Tool name"},
					"arguments": map[string]interface{}{"type": "object", "description": "Tool arguments"},
				},
			},
		},
		{
			"name":        "acl_health",
			"description": "Health check all connected MCP peers.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
	}

	// --- Tmux Session Management ---
	tmuxTools := []map[string]interface{}{
		{
			"name":        "tmux_list_sessions",
			"description": "List all tmux sessions on this machine with agent detection (claude, codex, aider, etc.) and their relationship to Yaver (adopted, forked-by-yaver, unrelated).",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "tmux_adopt_session",
			"description": "Adopt an existing tmux session as a Yaver task. The session continues running and its output is streamed as task output. Useful for bringing pre-existing agent sessions under Yaver management.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"session_name"},
				"properties": map[string]interface{}{
					"session_name": map[string]interface{}{
						"type":        "string",
						"description": "Name of the tmux session to adopt",
					},
				},
			},
		},
		{
			"name":        "tmux_detach_session",
			"description": "Detach (stop monitoring) an adopted tmux session. The tmux session keeps running but Yaver stops tracking it. The task is marked as stopped.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id"},
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "The Yaver task ID of the adopted session",
					},
				},
			},
		},
		{
			"name":        "tmux_send_input",
			"description": "Send keyboard input to an adopted tmux session. The input is sent via tmux send-keys followed by Enter.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id", "input"},
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "The Yaver task ID of the adopted session",
					},
					"input": map[string]interface{}{
						"type":        "string",
						"description": "The text to send to the tmux session",
					},
				},
			},
		},
	}
	tools = append(tools, tmuxTools...)

	// --- Diagnostics & Status ---
	diagnosticTools := []map[string]interface{}{
		{
			"name":        "yaver_doctor",
			"description": "Run a comprehensive system health check — auth, agent, runners, relay servers, tunnels, network, tmux sessions. Like 'yaver doctor' on the CLI.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "yaver_status",
			"description": "Show auth status, agent info, current runner, relay servers, and connection details. Like 'yaver status' on the CLI.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "yaver_devices",
			"description": "List all registered devices across your account (dev machines, laptops, servers) with online/offline status.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "yaver_logs",
			"description": "View the last N lines of the agent log file.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"lines": map[string]interface{}{
						"type":        "integer",
						"description": "Number of log lines to return (default 50, max 500)",
					},
				},
			},
		},
		{
			"name":        "yaver_clear_logs",
			"description": "Clear the agent log file.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "yaver_help",
			"description": "Get help about Yaver features and capabilities. Use this when a user asks what Yaver can do, how to set up, or how features work (tmux adoption, relay servers, tunnels, MCP tools, mobile app, etc.).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"topic": map[string]interface{}{
						"type":        "string",
						"description": "Optional topic: overview, tmux, relay, tunnel, mobile, mcp, runners, tasks, auth",
					},
				},
			},
		},
		{
			"name":        "yaver_ping",
			"description": "Ping the agent to verify it's alive and measure round-trip time.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "agent_shutdown",
			"description": "Gracefully shut down the Yaver agent. All running tasks will be stopped.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"confirm": map[string]interface{}{
						"type":        "boolean",
						"description": "Must be true to confirm shutdown",
					},
				},
				"required": []string{"confirm"},
			},
		},
	}
	tools = append(tools, diagnosticTools...)

	// --- Config Management ---
	configTools := []map[string]interface{}{
		{
			"name":        "config_set",
			"description": "Set a Yaver configuration value. Keys: auto-start (true/false), auto-update (true/false).",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"key", "value"},
				"properties": map[string]interface{}{
					"key":   map[string]interface{}{"type": "string", "description": "Config key (auto-start, auto-update)"},
					"value": map[string]interface{}{"type": "string", "description": "Config value"},
				},
			},
		},
		{
			"name":        "relay_test",
			"description": "Test connectivity and latency to configured relay servers (or a specific URL).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url": map[string]interface{}{"type": "string", "description": "Optional: specific relay URL to test. If omitted, tests all configured relays."},
				},
			},
		},
		{
			"name":        "relay_set_password",
			"description": "Set the default relay server password used for all relay connections.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"password"},
				"properties": map[string]interface{}{
					"password": map[string]interface{}{"type": "string", "description": "The relay password"},
				},
			},
		},
		{
			"name":        "relay_clear_password",
			"description": "Remove the default relay server password.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
	}
	tools = append(tools, configTools...)

	// --- Tunnel Management ---
	tunnelTools := []map[string]interface{}{
		{
			"name":        "tunnel_list",
			"description": "List configured Cloudflare Tunnels.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "tunnel_add",
			"description": "Add a Cloudflare Tunnel endpoint for NAT traversal.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"url"},
				"properties": map[string]interface{}{
					"url":              map[string]interface{}{"type": "string", "description": "Tunnel URL (e.g. https://my-tunnel.example.com)"},
					"cf_client_id":     map[string]interface{}{"type": "string", "description": "CF Access Service Token Client ID (optional)"},
					"cf_client_secret": map[string]interface{}{"type": "string", "description": "CF Access Service Token Client Secret (optional)"},
					"label":            map[string]interface{}{"type": "string", "description": "Human-readable label (optional)"},
				},
			},
		},
		{
			"name":        "tunnel_remove",
			"description": "Remove a Cloudflare Tunnel by ID or URL.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"tunnel_id"},
				"properties": map[string]interface{}{
					"tunnel_id": map[string]interface{}{"type": "string", "description": "Tunnel ID or URL to remove"},
				},
			},
		},
		{
			"name":        "tunnel_test",
			"description": "Test connectivity to configured Cloudflare Tunnels (or a specific URL).",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url": map[string]interface{}{"type": "string", "description": "Optional: specific tunnel URL to test. If omitted, tests all configured tunnels."},
				},
			},
		},
	}
	tools = append(tools, tunnelTools...)

	// --- Session Transfer ---
	sessionTools := []map[string]interface{}{
		{
			"name":        "session_list",
			"description": "List AI agent sessions that can be transferred to another machine. Shows task ID, agent type, title, status, and whether the session is resumable.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "session_export",
			"description": "Export an AI agent session as a portable bundle. The bundle contains conversation history, agent-specific session files, and optionally workspace info (git patch or tar). Use this to prepare a session for transfer to another machine.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id"},
				"properties": map[string]interface{}{
					"task_id":           map[string]interface{}{"type": "string", "description": "The task ID of the session to export"},
					"include_workspace": map[string]interface{}{"type": "boolean", "description": "Include workspace files in the bundle (default: false)"},
					"workspace_mode":    map[string]interface{}{"type": "string", "description": "How to include workspace: 'none', 'git' (git patch), or 'tar'. Default: 'git' if git repo, else 'none'."},
				},
			},
		},
		{
			"name":        "session_import",
			"description": "Import a session bundle that was exported from another machine. Creates a new task with the transferred session state. Supports Claude Code, Aider, Codex, Goose, Amp, OpenCode, and custom agents.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"bundle_json"},
				"properties": map[string]interface{}{
					"bundle_json": map[string]interface{}{"type": "string", "description": "The JSON string of the transfer bundle"},
					"work_dir":    map[string]interface{}{"type": "string", "description": "Target working directory (default: agent's work dir)"},
					"git_clone":   map[string]interface{}{"type": "boolean", "description": "Clone the git repo from the bundle's remote URL (default: false)"},
				},
			},
		},
		{
			"name":        "session_transfer",
			"description": "Transfer an AI agent session from THIS machine to another device in one step. The session (conversation history, agent state, optionally workspace) is packaged, sent to the target device, and imported there. The user can then continue working from the target device via mobile or desktop. Supports Claude Code, Aider, Codex, Goose, Amp, OpenCode sessions.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"task_id", "target_device"},
				"properties": map[string]interface{}{
					"task_id":           map[string]interface{}{"type": "string", "description": "The task ID of the session to transfer"},
					"target_device":     map[string]interface{}{"type": "string", "description": "Target device ID or hostname prefix (from your registered devices)"},
					"include_workspace": map[string]interface{}{"type": "boolean", "description": "Include workspace files (default: false)"},
					"workspace_mode":    map[string]interface{}{"type": "string", "description": "How to transfer workspace: 'none', 'git', or 'tar'. Default: 'git'."},
				},
			},
		},
	}
	tools = append(tools, sessionTools...)

	// --- Exec (Remote Command Execution) ---
	execTools := []map[string]interface{}{
		{
			"name":        "exec_command",
			"description": "Execute a shell command on this machine and return the output. Like SSH but local. Commands are validated through the sandbox (dangerous patterns like rm -rf / are blocked). Use this for quick commands — for long-running tasks, use create_task instead.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"command"},
				"properties": map[string]interface{}{
					"command":  map[string]interface{}{"type": "string", "description": "Shell command to execute"},
					"work_dir": map[string]interface{}{"type": "string", "description": "Working directory (default: agent's work dir)"},
					"timeout":  map[string]interface{}{"type": "integer", "description": "Timeout in seconds (default: 300, max: 3600)"},
				},
			},
		},
	}
	tools = append(tools, execTools...)

	return map[string]interface{}{
		"tools": tools,
	}
}
