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

	// --- Notifications ---
	notifTools := []map[string]interface{}{
		{
			"name":        "notify",
			"description": "Send a notification message to configured channels (Telegram, Discord, Slack, Teams). Useful for alerting yourself about task completions, deployments, or any important events.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"message"},
				"properties": map[string]interface{}{
					"message": map[string]interface{}{"type": "string", "description": "Message to send"},
					"channel": map[string]interface{}{"type": "string", "description": "Specific channel: 'telegram', 'discord', 'slack', 'teams'. Omit to send to all."},
				},
			},
		},
		{
			"name":        "integrations_list",
			"description": "List all configured notification and developer integrations (Telegram, Discord, Slack, Teams, Linear, Jira, PagerDuty, Opsgenie, Email). Shows which are enabled and their settings.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "integrations_set",
			"description": "Configure a notification or developer integration. Saves to config and activates immediately. Channels: telegram, discord, slack, teams, linear, jira, pagerduty, opsgenie, email.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"channel", "config"},
				"properties": map[string]interface{}{
					"channel": map[string]interface{}{"type": "string", "description": "Integration channel name (telegram, discord, slack, teams, linear, jira, pagerduty, opsgenie, email)"},
					"config":  map[string]interface{}{"type": "object", "description": "Channel-specific config. Examples: {\"webhookUrl\":\"...\",\"enabled\":true} for Discord/Slack/Teams, {\"apiKey\":\"...\",\"teamId\":\"...\",\"enabled\":true} for Linear, {\"routingKey\":\"...\",\"enabled\":true,\"onFailOnly\":true} for PagerDuty"},
				},
			},
		},
		{
			"name":        "integrations_test",
			"description": "Send a test notification to verify an integration is working. Specify a channel or omit to test all.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"channel": map[string]interface{}{"type": "string", "description": "Channel to test (telegram, discord, slack, teams, linear, jira, pagerduty, opsgenie, email). Omit to test all."},
				},
			},
		},
	}
	tools = append(tools, notifTools...)

	// --- Task Scheduling ---
	scheduleTools := []map[string]interface{}{
		{
			"name":        "schedule_task",
			"description": "Schedule a task to run at a specific time or on a recurring basis. Supports one-shot (runAt), interval-based (repeatInterval in minutes), and cron expressions.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"title"},
				"properties": map[string]interface{}{
					"title":           map[string]interface{}{"type": "string", "description": "Task prompt"},
					"run_at":          map[string]interface{}{"type": "string", "description": "ISO8601 datetime for one-shot execution (e.g. '2026-03-22T15:00:00Z')"},
					"repeat_interval": map[string]interface{}{"type": "integer", "description": "Repeat every N minutes"},
					"cron":            map[string]interface{}{"type": "string", "description": "Cron expression (minute hour day month weekday), e.g. '0 9 * * 1-5' for weekdays at 9am"},
					"max_runs":        map[string]interface{}{"type": "integer", "description": "Maximum number of runs (0 = unlimited)"},
					"runner":          map[string]interface{}{"type": "string", "description": "Runner ID (claude, codex, aider, etc.)"},
				},
			},
		},
		{
			"name":        "list_schedules",
			"description": "List all scheduled and recurring tasks with their status, next run time, and history.",
			"inputSchema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "cancel_schedule",
			"description": "Cancel/remove a scheduled task by ID.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"schedule_id"},
				"properties": map[string]interface{}{
					"schedule_id": map[string]interface{}{"type": "string", "description": "Schedule ID to cancel"},
				},
			},
		},
	}
	tools = append(tools, scheduleTools...)

	// --- Utility Tools ---
	utilTools := []map[string]interface{}{
		{
			"name":        "search_files",
			"description": "Search for files by name pattern in a directory. Uses glob patterns (e.g. '*.go', 'test_*.py'). Skips node_modules, .git, vendor, etc.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"pattern"},
				"properties": map[string]interface{}{
					"pattern":     map[string]interface{}{"type": "string", "description": "Glob pattern to match filenames (e.g. '*.go', 'README*', '*.test.ts')"},
					"directory":   map[string]interface{}{"type": "string", "description": "Directory to search in (default: agent work dir)"},
					"max_results": map[string]interface{}{"type": "integer", "description": "Max results (default: 50)"},
				},
			},
		},
		{
			"name":        "search_content",
			"description": "Search for text content inside files (like grep/ripgrep). Returns matching lines with file paths and line numbers.",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"query"},
				"properties": map[string]interface{}{
					"query":       map[string]interface{}{"type": "string", "description": "Text or regex to search for"},
					"directory":   map[string]interface{}{"type": "string", "description": "Directory to search in (default: agent work dir)"},
					"max_results": map[string]interface{}{"type": "integer", "description": "Max results (default: 30)"},
				},
			},
		},
		{
			"name":        "screenshot",
			"description": "Take a screenshot of the current screen. Returns base64-encoded PNG. Works on macOS, Linux (with gnome-screenshot/scrot), and Windows.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "system_info",
			"description": "Get system information: hostname, OS, CPU count, disk usage, memory, load average. Useful for monitoring headless machines.",
			"inputSchema": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			"name":        "git_info",
			"description": "Get git repository information. Operations: status (changed files), diff (diff stats), log (last 20 commits), branch (all branches), remote (remote URLs).",
			"inputSchema": map[string]interface{}{
				"type":     "object",
				"required": []string{"operation"},
				"properties": map[string]interface{}{
					"operation": map[string]interface{}{"type": "string", "description": "Git operation: status, diff, log, branch, remote"},
					"directory": map[string]interface{}{"type": "string", "description": "Git repo directory (default: agent work dir)"},
				},
			},
		},
	}
	tools = append(tools, utilTools...)

	// --- Developer Tools ---
	devTools := []map[string]interface{}{
		// Docker
		{"name": "docker_ps", "description": "List running Docker containers.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "docker_logs", "description": "Get logs from a Docker container.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"container"}, "properties": map[string]interface{}{"container": map[string]interface{}{"type": "string", "description": "Container name or ID"}, "tail": map[string]interface{}{"type": "integer", "description": "Number of lines (default: 100)"}}}},
		{"name": "docker_exec", "description": "Execute a command inside a Docker container.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"container", "command"}, "properties": map[string]interface{}{"container": map[string]interface{}{"type": "string", "description": "Container name or ID"}, "command": map[string]interface{}{"type": "string", "description": "Command to execute"}}}},
		{"name": "docker_images", "description": "List Docker images on the machine.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "docker_compose", "description": "Run docker compose actions (up, down, ps, logs, restart).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"action"}, "properties": map[string]interface{}{"action": map[string]interface{}{"type": "string", "description": "Action: up, down, ps, logs, restart"}, "directory": map[string]interface{}{"type": "string", "description": "Directory with docker-compose.yml"}}}},
		// Test runner
		{"name": "run_tests", "description": "Run the project's test suite. Auto-detects framework (go test, jest, vitest, pytest, cargo test, make test) or accepts a custom command.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"command": map[string]interface{}{"type": "string", "description": "Custom test command (auto-detected if empty)"}, "directory": map[string]interface{}{"type": "string", "description": "Project directory (default: agent work dir)"}}}},
		// HTTP client
		{"name": "http_request", "description": "Make an HTTP request (like curl). Returns status code and response body.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"url"}, "properties": map[string]interface{}{"url": map[string]interface{}{"type": "string", "description": "Request URL"}, "method": map[string]interface{}{"type": "string", "description": "HTTP method (default: GET)"}, "headers": map[string]interface{}{"type": "object", "description": "Request headers as key-value pairs"}, "body": map[string]interface{}{"type": "string", "description": "Request body"}}}},
		// Log tail
		{"name": "tail_logs", "description": "Tail log files or system logs (journalctl on Linux, system.log on macOS).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"path": map[string]interface{}{"type": "string", "description": "Log file path (default: system logs)"}, "lines": map[string]interface{}{"type": "integer", "description": "Number of lines (default: 100)"}}}},
		// Clipboard
		{"name": "clipboard_read", "description": "Read the system clipboard contents.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "clipboard_write", "description": "Write text to the system clipboard.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"content"}, "properties": map[string]interface{}{"content": map[string]interface{}{"type": "string", "description": "Text to copy to clipboard"}}}},
		// Process management
		{"name": "process_list", "description": "List running processes. Optionally filter by name.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"filter": map[string]interface{}{"type": "string", "description": "Filter processes by name"}}}},
		{"name": "process_kill", "description": "Kill a process by PID.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"pid"}, "properties": map[string]interface{}{"pid": map[string]interface{}{"type": "integer", "description": "Process ID"}, "signal": map[string]interface{}{"type": "string", "description": "Signal (default: TERM)"}}}},
		{"name": "port_check", "description": "Check what process is using a specific port.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"port"}, "properties": map[string]interface{}{"port": map[string]interface{}{"type": "integer", "description": "Port number to check"}}}},
		// Code quality
		{"name": "lint", "description": "Run linter on the project. Auto-detects: go vet, eslint, ruff/flake8, clippy.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Project directory"}, "tool": map[string]interface{}{"type": "string", "description": "Custom lint command (auto-detected if empty)"}}}},
		{"name": "format_code", "description": "Format code in the project. Auto-detects: gofmt, prettier, ruff/black, cargo fmt.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Project directory"}, "tool": map[string]interface{}{"type": "string", "description": "Custom format command (auto-detected if empty)"}}}},
		{"name": "type_check", "description": "Run type checker. Auto-detects: tsc, go build, mypy/pyright.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Project directory"}, "tool": map[string]interface{}{"type": "string", "description": "Custom type check command (auto-detected if empty)"}}}},
		// Package dependencies
		{"name": "deps_outdated", "description": "Check for outdated dependencies. Auto-detects: npm, yarn, pnpm, pip, cargo, go.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Project directory"}, "manager": map[string]interface{}{"type": "string", "description": "Package manager (auto-detected if empty)"}}}},
		{"name": "deps_audit", "description": "Audit dependencies for security vulnerabilities.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Project directory"}, "manager": map[string]interface{}{"type": "string", "description": "Package manager (auto-detected if empty)"}}}},
		{"name": "deps_list", "description": "List installed project dependencies.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Project directory"}, "manager": map[string]interface{}{"type": "string", "description": "Package manager (auto-detected if empty)"}}}},
		// GitHub
		{"name": "github_prs", "description": "List pull requests from the current repo (requires gh CLI).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Repo directory"}, "state": map[string]interface{}{"type": "string", "description": "Filter: open, closed, merged, all (default: open)"}}}},
		{"name": "github_issues", "description": "List issues from the current repo (requires gh CLI).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Repo directory"}, "state": map[string]interface{}{"type": "string", "description": "Filter: open, closed, all (default: open)"}}}},
		{"name": "github_ci_status", "description": "Show recent GitHub Actions workflow runs and their status (requires gh CLI).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"directory": map[string]interface{}{"type": "string", "description": "Repo directory"}}}},
	}
	tools = append(tools, devTools...)

	// --- Developer Tools 2 ---
	devTools2 := []map[string]interface{}{
		// Database
		{"name": "db_query", "description": "Execute a database query (SQLite, PostgreSQL, MySQL, Redis).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"driver", "query"}, "properties": map[string]interface{}{"driver": map[string]interface{}{"type": "string", "description": "Database: sqlite, postgres, mysql, redis"}, "dsn": map[string]interface{}{"type": "string", "description": "Connection string (or path for SQLite). Uses DATABASE_URL env if empty for postgres."}, "query": map[string]interface{}{"type": "string", "description": "SQL query or Redis command"}}}},
		{"name": "db_schema", "description": "Show database schema/tables.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"driver"}, "properties": map[string]interface{}{"driver": map[string]interface{}{"type": "string", "description": "Database: sqlite, postgres, mysql"}, "dsn": map[string]interface{}{"type": "string", "description": "Connection string"}}}},
		// Network diagnostics
		{"name": "dns_lookup", "description": "DNS lookup for a hostname.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"host"}, "properties": map[string]interface{}{"host": map[string]interface{}{"type": "string", "description": "Hostname to lookup"}, "type": map[string]interface{}{"type": "string", "description": "Record type: A, AAAA, MX, CNAME, TXT (default: A)"}}}},
		{"name": "ping", "description": "Ping a host.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"host"}, "properties": map[string]interface{}{"host": map[string]interface{}{"type": "string", "description": "Host to ping"}, "count": map[string]interface{}{"type": "integer", "description": "Number of pings (default: 4)"}}}},
		{"name": "ssl_check", "description": "Check SSL/TLS certificate for a domain — expiry, issuer, SANs.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"host"}, "properties": map[string]interface{}{"host": map[string]interface{}{"type": "string", "description": "Domain to check (e.g. yaver.io)"}}}},
		{"name": "http_timing", "description": "Measure HTTP response time and get basic info.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"url"}, "properties": map[string]interface{}{"url": map[string]interface{}{"type": "string", "description": "URL to measure"}}}},
		// Data tools
		{"name": "base64", "description": "Base64 encode or decode text.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"action", "input"}, "properties": map[string]interface{}{"action": map[string]interface{}{"type": "string", "description": "encode or decode"}, "input": map[string]interface{}{"type": "string", "description": "Text to encode/decode"}}}},
		{"name": "hash", "description": "Hash text with MD5 or SHA256.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"input"}, "properties": map[string]interface{}{"input": map[string]interface{}{"type": "string", "description": "Text to hash"}, "algorithm": map[string]interface{}{"type": "string", "description": "md5 or sha256 (default: sha256)"}}}},
		{"name": "uuid", "description": "Generate a new UUID v4.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "jq", "description": "Query/transform JSON with jq expressions.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"expression", "input"}, "properties": map[string]interface{}{"expression": map[string]interface{}{"type": "string", "description": "jq expression (e.g. '.data[] | .name')"}, "input": map[string]interface{}{"type": "string", "description": "JSON input"}}}},
		{"name": "regex_test", "description": "Test a regex pattern against input text.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"pattern", "input"}, "properties": map[string]interface{}{"pattern": map[string]interface{}{"type": "string", "description": "Regex pattern"}, "input": map[string]interface{}{"type": "string", "description": "Text to match against"}}}},
		// Archive
		{"name": "archive_create", "description": "Create a zip or tar.gz archive.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"source"}, "properties": map[string]interface{}{"source": map[string]interface{}{"type": "string", "description": "File or directory to archive"}, "output": map[string]interface{}{"type": "string", "description": "Output filename (auto-generated if empty)"}, "format": map[string]interface{}{"type": "string", "description": "zip or tar.gz (default: tar.gz)"}}}},
		{"name": "archive_extract", "description": "Extract a zip or tar.gz archive.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"path"}, "properties": map[string]interface{}{"path": map[string]interface{}{"type": "string", "description": "Archive file path"}, "destination": map[string]interface{}{"type": "string", "description": "Extraction directory (default: current)"}}}},
		// System services
		{"name": "service_status", "description": "Check status of a system service (systemd on Linux, brew services on macOS).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"name"}, "properties": map[string]interface{}{"name": map[string]interface{}{"type": "string", "description": "Service name (e.g. nginx, postgresql, docker)"}}}},
		{"name": "service_action", "description": "Start, stop, restart, enable, or disable a system service.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"name", "action"}, "properties": map[string]interface{}{"name": map[string]interface{}{"type": "string", "description": "Service name"}, "action": map[string]interface{}{"type": "string", "description": "start, stop, restart, enable, disable"}}}},
		{"name": "service_list", "description": "List system services and their status.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		// Benchmark
		{"name": "benchmark", "description": "Run project benchmarks. Auto-detects: go bench, cargo bench, npm bench.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"command": map[string]interface{}{"type": "string", "description": "Custom benchmark command (auto-detected if empty)"}, "directory": map[string]interface{}{"type": "string", "description": "Project directory"}}}},
		// Diff
		{"name": "diff", "description": "Compare two files and show differences.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"path_a", "path_b"}, "properties": map[string]interface{}{"path_a": map[string]interface{}{"type": "string", "description": "First file path"}, "path_b": map[string]interface{}{"type": "string", "description": "Second file path"}}}},
		// Environment
		{"name": "env_list", "description": "List environment variables (secrets are masked).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"filter": map[string]interface{}{"type": "string", "description": "Filter by name (case-insensitive)"}}}},
		{"name": "env_read", "description": "Read a .env file (secrets are masked).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"path": map[string]interface{}{"type": "string", "description": "Path to .env file (default: .env)"}}}},
		// Crontab
		{"name": "crontab", "description": "List or add system crontab entries.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"action": map[string]interface{}{"type": "string", "description": "list or add (default: list)"}, "entry": map[string]interface{}{"type": "string", "description": "Cron entry to add (required for 'add')"}}}},
		// Cloud CLI
		{"name": "cloud_cli", "description": "Run AWS, GCP, or Azure CLI commands.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"provider", "args"}, "properties": map[string]interface{}{"provider": map[string]interface{}{"type": "string", "description": "aws, gcloud, or az"}, "args": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "CLI arguments (e.g. ['s3', 'ls'])"}}}},
	}
	tools = append(tools, devTools2...)

	// --- Lifestyle & Home Automation ---
	lifestyleTools := []map[string]interface{}{
		// Home Assistant
		{"name": "ha_states", "description": "Get Home Assistant entity states. Control Xiaomi, Philips Hue, or any HA-connected device. Filter by entity type (light, switch, vacuum, climate, sensor, etc.).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"filter": map[string]interface{}{"type": "string", "description": "Filter entities (e.g. 'light', 'vacuum', 'switch', 'climate', 'sensor')"}, "url": map[string]interface{}{"type": "string", "description": "HA URL (default: http://homeassistant.local:8123)"}, "token": map[string]interface{}{"type": "string", "description": "HA long-lived access token"}}}},
		{"name": "ha_service", "description": "Call a Home Assistant service — turn on/off lights, start vacuum, set thermostat, trigger scenes. Works with Xiaomi, Hue, IKEA, and all HA integrations.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"domain", "service"}, "properties": map[string]interface{}{"domain": map[string]interface{}{"type": "string", "description": "Service domain (e.g. light, switch, vacuum, climate, scene, automation)"}, "service": map[string]interface{}{"type": "string", "description": "Service name (e.g. turn_on, turn_off, start, set_temperature, toggle)"}, "data": map[string]interface{}{"type": "object", "description": "Service data (e.g. {\"entity_id\": \"vacuum.xiaomi\", \"brightness\": 255})"}, "url": map[string]interface{}{"type": "string", "description": "HA URL"}, "token": map[string]interface{}{"type": "string", "description": "HA token"}}}},
		{"name": "ha_toggle", "description": "Toggle a Home Assistant entity on/off (light, switch, vacuum, etc.).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"entity_id"}, "properties": map[string]interface{}{"entity_id": map[string]interface{}{"type": "string", "description": "Entity ID (e.g. vacuum.xiaomi_roborock, light.living_room, switch.desk_lamp)"}, "url": map[string]interface{}{"type": "string", "description": "HA URL"}, "token": map[string]interface{}{"type": "string", "description": "HA token"}}}},
		// MQTT
		{"name": "mqtt_publish", "description": "Publish an MQTT message (for IoT devices, home automation).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"topic", "message"}, "properties": map[string]interface{}{"topic": map[string]interface{}{"type": "string", "description": "MQTT topic"}, "message": map[string]interface{}{"type": "string", "description": "Message payload"}, "broker": map[string]interface{}{"type": "string", "description": "MQTT broker (default: localhost)"}}}},
		// Desktop control
		{"name": "notify", "description": "Send a desktop notification.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"title", "message"}, "properties": map[string]interface{}{"title": map[string]interface{}{"type": "string", "description": "Notification title"}, "message": map[string]interface{}{"type": "string", "description": "Notification body"}}}},
		{"name": "open_url", "description": "Open a URL in the default browser.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"url"}, "properties": map[string]interface{}{"url": map[string]interface{}{"type": "string", "description": "URL to open"}}}},
		{"name": "volume", "description": "Get or set system volume.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"action"}, "properties": map[string]interface{}{"action": map[string]interface{}{"type": "string", "description": "get, set, mute, or unmute"}, "level": map[string]interface{}{"type": "integer", "description": "Volume level 0-100 (for set)"}}}},
		{"name": "screen_lock", "description": "Lock the screen.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "say", "description": "Text-to-speech — speak text aloud.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"text"}, "properties": map[string]interface{}{"text": map[string]interface{}{"type": "string", "description": "Text to speak"}}}},
		{"name": "brightness", "description": "Get or set screen brightness (macOS).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"action"}, "properties": map[string]interface{}{"action": map[string]interface{}{"type": "string", "description": "get or set"}, "level": map[string]interface{}{"type": "integer", "description": "Brightness 0-100 (for set)"}}}},
		// Music
		{"name": "music", "description": "Control music playback (Spotify on macOS, playerctl on Linux).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"action"}, "properties": map[string]interface{}{"action": map[string]interface{}{"type": "string", "description": "play, pause, next, previous, now_playing"}}}},
		// Weather
		{"name": "weather", "description": "Get current weather for a location.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"location": map[string]interface{}{"type": "string", "description": "City name (default: auto-detect)"}}}},
		// System extras
		{"name": "battery", "description": "Get battery status.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "disk_usage", "description": "Show disk usage.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"path": map[string]interface{}{"type": "string", "description": "Path to check (default: /)"}}}},
		{"name": "wifi_info", "description": "Get WiFi network information.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "public_ip", "description": "Get public IP address.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "uptime", "description": "Show system uptime.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "speed_test", "description": "Run an internet speed test.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "site_check", "description": "Check if a website is up and measure latency.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"url"}, "properties": map[string]interface{}{"url": map[string]interface{}{"type": "string", "description": "URL to check"}}}},
		// Utilities
		{"name": "password_gen", "description": "Generate a secure random password.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"length": map[string]interface{}{"type": "integer", "description": "Password length (default: 24)"}, "no_symbols": map[string]interface{}{"type": "boolean", "description": "Omit special characters"}}}},
		{"name": "qr_code", "description": "Generate a QR code from text.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"text"}, "properties": map[string]interface{}{"text": map[string]interface{}{"type": "string", "description": "Text to encode"}}}},
		{"name": "timer", "description": "Set a timer with desktop notification when done.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"seconds"}, "properties": map[string]interface{}{"seconds": map[string]interface{}{"type": "integer", "description": "Timer duration in seconds"}, "label": map[string]interface{}{"type": "string", "description": "Timer label"}}}},
		{"name": "calculate", "description": "Evaluate a math expression.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"expression"}, "properties": map[string]interface{}{"expression": map[string]interface{}{"type": "string", "description": "Math expression (e.g. '2^10', 'sqrt(144)', '3.14 * 5^2')"}}}},
		{"name": "world_clock", "description": "Show current time in multiple timezones.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"timezones": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Timezone names (default: UTC, New York, London, Istanbul, Tokyo)"}}}},
		{"name": "countdown", "description": "Count down to a specific date.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"date"}, "properties": map[string]interface{}{"date": map[string]interface{}{"type": "string", "description": "Target date (e.g. 2026-04-01)"}}}},
		{"name": "convert_units", "description": "Convert between units (temperature, distance, weight, data sizes).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"value", "from", "to"}, "properties": map[string]interface{}{"value": map[string]interface{}{"type": "number", "description": "Value to convert"}, "from": map[string]interface{}{"type": "string", "description": "Source unit (c, f, km, mi, kg, lb, gb, mb, bytes)"}, "to": map[string]interface{}{"type": "string", "description": "Target unit"}}}},
	}
	tools = append(tools, lifestyleTools...)

	// --- IoT & Smart Devices ---
	iotTools := []map[string]interface{}{
		// Philips Hue (local bridge, no cloud)
		{"name": "hue_lights", "description": "List all Philips Hue lights on your bridge.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"bridge_ip", "api_key"}, "properties": map[string]interface{}{"bridge_ip": map[string]interface{}{"type": "string", "description": "Hue bridge IP"}, "api_key": map[string]interface{}{"type": "string", "description": "Hue API key"}}}},
		{"name": "hue_control", "description": "Control a Philips Hue light — on, off, toggle, brightness, color.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"bridge_ip", "api_key", "light_id", "action"}, "properties": map[string]interface{}{"bridge_ip": map[string]interface{}{"type": "string"}, "api_key": map[string]interface{}{"type": "string"}, "light_id": map[string]interface{}{"type": "string", "description": "Light number (e.g. '1')"}, "action": map[string]interface{}{"type": "string", "description": "on, off, toggle, brightness, color"}, "brightness": map[string]interface{}{"type": "integer", "description": "0-254 for brightness, 0-65535 for color hue"}}}},
		{"name": "hue_scenes", "description": "List Hue scenes.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"bridge_ip", "api_key"}, "properties": map[string]interface{}{"bridge_ip": map[string]interface{}{"type": "string"}, "api_key": map[string]interface{}{"type": "string"}}}},
		// Shelly (local HTTP, no hub)
		{"name": "shelly_status", "description": "Get Shelly device status (smart plug, relay, light).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"ip"}, "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string", "description": "Shelly device IP"}}}},
		{"name": "shelly_control", "description": "Control a Shelly relay/plug — on, off, toggle.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"ip", "action"}, "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string"}, "action": map[string]interface{}{"type": "string", "description": "on, off, toggle"}, "channel": map[string]interface{}{"type": "integer", "description": "Relay channel (default: 0)"}}}},
		{"name": "shelly_power", "description": "Get power consumption from a Shelly device.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"ip"}, "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string"}}}},
		// Elgato Key Light
		{"name": "elgato_status", "description": "Get Elgato Key Light status (for streaming/video calls).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string", "description": "Key Light IP (default: elgato-key-light.local)"}}}},
		{"name": "elgato_control", "description": "Control Elgato Key Light — on/off, brightness, color temperature.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string"}, "on": map[string]interface{}{"type": "boolean", "description": "Turn on/off"}, "brightness": map[string]interface{}{"type": "integer", "description": "Brightness 0-100"}, "temperature": map[string]interface{}{"type": "integer", "description": "Color temp 143-344 (warm to cool)"}}}},
		// Nanoleaf
		{"name": "nanoleaf", "description": "Control Nanoleaf light panels — on, off, brightness, effects.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"ip", "token", "action"}, "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string"}, "token": map[string]interface{}{"type": "string", "description": "Nanoleaf auth token"}, "action": map[string]interface{}{"type": "string", "description": "on, off, brightness, effects, status"}, "brightness": map[string]interface{}{"type": "integer"}}}},
		// Tasmota
		{"name": "tasmota", "description": "Send commands to Tasmota-flashed devices (smart plugs, relays).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"ip", "command"}, "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string"}, "command": map[string]interface{}{"type": "string", "description": "Tasmota command (e.g. Power ON, Status, Power TOGGLE)"}}}},
		// Govee LED strips
		{"name": "govee_devices", "description": "List Govee devices (LED strips, lights).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"api_key"}, "properties": map[string]interface{}{"api_key": map[string]interface{}{"type": "string", "description": "Govee API key"}}}},
		{"name": "govee_control", "description": "Control Govee lights/LED strips — on, off, brightness, color.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"api_key", "device", "model", "action"}, "properties": map[string]interface{}{"api_key": map[string]interface{}{"type": "string"}, "device": map[string]interface{}{"type": "string", "description": "Device address"}, "model": map[string]interface{}{"type": "string", "description": "Device model"}, "action": map[string]interface{}{"type": "string", "description": "on, off, brightness, color"}, "brightness": map[string]interface{}{"type": "integer"}, "color": map[string]interface{}{"type": "object", "description": "{r: 255, g: 0, b: 0}"}}}},
		// Wake on LAN
		{"name": "wake_on_lan", "description": "Send a Wake-on-LAN magic packet to wake up a machine.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"mac"}, "properties": map[string]interface{}{"mac": map[string]interface{}{"type": "string", "description": "MAC address (e.g. AA:BB:CC:DD:EE:FF)"}}}},
		// Apple Shortcuts
		{"name": "run_shortcut", "description": "Run an Apple Shortcut (macOS only).", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"name"}, "properties": map[string]interface{}{"name": map[string]interface{}{"type": "string", "description": "Shortcut name"}, "input": map[string]interface{}{"type": "string", "description": "Input text"}}}},
		{"name": "list_shortcuts", "description": "List available Apple Shortcuts (macOS only).", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		// ADB (Android)
		{"name": "adb_devices", "description": "List connected Android devices/emulators.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "adb_command", "description": "Run a command on an Android device via ADB.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"command"}, "properties": map[string]interface{}{"command": map[string]interface{}{"type": "string", "description": "Shell command"}, "device": map[string]interface{}{"type": "string", "description": "Device serial (optional)"}}}},
		{"name": "adb_screenshot", "description": "Take a screenshot from an Android device.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"device": map[string]interface{}{"type": "string"}}}},
		// Sonos
		{"name": "sonos_discover", "description": "Discover Sonos speakers on the network.", "inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{"name": "sonos_control", "description": "Control a Sonos speaker — play, pause, next, previous, volume.", "inputSchema": map[string]interface{}{"type": "object", "required": []string{"ip", "action"}, "properties": map[string]interface{}{"ip": map[string]interface{}{"type": "string", "description": "Sonos speaker IP"}, "action": map[string]interface{}{"type": "string", "description": "play, pause, next, previous, volume_up, volume_down, status"}}}},
	}
	tools = append(tools, iotTools...)

	return map[string]interface{}{
		"tools": tools,
	}
}
