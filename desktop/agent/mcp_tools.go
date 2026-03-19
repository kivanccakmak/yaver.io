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

	return map[string]interface{}{
		"tools": tools,
	}
}
