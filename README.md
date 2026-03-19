# Yaver

**Your AI coding agent, on your phone.** Yaver is an open-source P2P tool that lets developers use any AI coding agent (Claude Code, Codex, Aider, Ollama, etc.) from their mobile device or any terminal, connecting directly to their development machines. Task data flows peer-to-peer — servers only handle auth and peer discovery.

## How It Works

```
┌─────────────┐     HTTP         ┌──────────────┐    QUIC tunnel    ┌──────────────┐
│  Mobile App │─────────────────►│ Relay Server │◄──────────────────│ Desktop Agent│
│ (React Native)  short-lived    │  (optional)  │  persistent       │  (Go CLI)    │
│  Wi-Fi/5G   │  HTTP requests   │  public IP   │  outbound conn    │  behind NAT  │
└──────┬──────┘                  └──────┬───────┘                   └──────┬───────┘
       │                                │                                  │
       │  Auth only                     │  Platform config                 │  Register device
       ▼                                ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Convex Backend                                       │
│  Auth + Peer Discovery + Platform Config (relay server list)                │
│  Apple / Google / Microsoft Sign-In                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

No code, task data, or AI output ever touches our servers. The relay is a pass-through proxy. When you're on the same network, traffic goes direct.

## Quick Start

```bash
# Install
brew install kivanccakmak/yaver/yaver

# Sign in & start agent
yaver auth
yaver serve
```

## MCP Integration

Yaver implements the Model Context Protocol (MCP) with 30+ tools. Connect from Claude Desktop, Claude Web UI, or any MCP-compatible client.

### Local MCP (stdio) — Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "yaver": {
      "command": "yaver",
      "args": ["mcp"]
    }
  }
}
```

### Network MCP (HTTP) — Remote / Claude Web UI

```bash
yaver mcp --mode http --port 18090
```

Connect from any MCP client at `http://your-machine:18090/mcp`.

### Available MCP Tools

| Category | Tools |
|----------|-------|
| **Tasks** | `create_task`, `list_tasks`, `get_task`, `stop_task`, `continue_task` |
| **System** | `get_info`, `get_system_info`, `get_config`, `set_work_dir`, `list_projects` |
| **Runners** | `list_runners`, `switch_runner` |
| **Relay** | `get_relay_config`, `add_relay_server`, `remove_relay_server` |
| **Filesystem** | `read_file`, `write_file`, `list_directory`, `search_files` |
| **Email** | `email_list_inbox`, `email_get`, `email_send`, `email_sync`, `email_search` |
| **ACL** | `acl_list_peers`, `acl_add_peer`, `acl_remove_peer`, `acl_list_peer_tools`, `acl_call_peer_tool`, `acl_health` |

See [MCP Integration Guide](https://yaver.io/docs/mcp) for full documentation.

## Security Sandbox

The command sandbox is enabled by default and blocks dangerous operations:

- **Filesystem destruction**: `rm -rf /`, `rm -rf ~`, etc.
- **Encryption/ransomware**: bulk encryption of home/root
- **Privilege escalation**: `sudo`, `su`, `doas` (unless allowed)
- **Disk manipulation**: `mkfs`, `fdisk`, `dd` to block devices
- **Network exfiltration**: `curl|bash`, piping sensitive files
- **System compromise**: overwriting `/etc/passwd`, disabling services

### Configuration

```json
// ~/.yaver/config.json
{
  "sandbox": {
    "enabled": true,
    "allow_sudo": false,
    "blocked_commands": ["terraform destroy", "kubectl delete namespace"],
    "allowed_paths": ["/home/user/projects"],
    "max_output_size_mb": 100
  }
}
```

```bash
yaver config set sandbox.allow-sudo true    # Allow sudo
yaver config set sandbox.enabled false      # Disable sandbox (not recommended)
```

## Multi-User Support

Multiple users can share the same machine (e.g. shared GPU server with Ollama). Each user runs their own agent:

```bash
# User A
yaver auth && yaver serve --port 18080

# User B
yaver auth && yaver serve --port 18081
```

Each agent instance has:
- Separate auth token and user ID
- Isolated task store (`~/.yaver/tasks.json`)
- Own sandbox configuration
- Independent relay connections
- Auth-aware LAN beacon (only same-user devices discover each other)

## Email Connectors

Connect Office 365 or Gmail for AI-assisted email workflows.

```bash
# Setup
yaver email setup     # Interactive — choose Office 365 or Gmail
yaver email test      # Send a test email
yaver email sync      # Sync emails to local SQLite database

# Available as MCP tools: email_list_inbox, email_get, email_send, email_sync, email_search
```

### Office 365
Requires Azure AD app registration with Microsoft Graph API permissions (`Mail.Read`, `Mail.Send`). Uses client credentials flow.

### Gmail
Requires Google Cloud OAuth2 credentials with Gmail API scope. Uses refresh token flow.

Synced emails are stored locally in `~/.yaver/emails.db` (SQLite) for fast search and retrieval.

## ACL — Agent Communication Layer

Connect Yaver to other MCP servers for agent-to-agent workflows:

```bash
# Connect to local Ollama
yaver acl add ollama http://localhost:11434/mcp

# Connect to a filesystem MCP server (stdio)
yaver acl add files --stdio "npx -y @modelcontextprotocol/server-filesystem /home"

# Connect to a remote database
yaver acl add mydb https://db.example.com/mcp --auth token123

# List / manage peers
yaver acl list
yaver acl tools ollama
yaver acl health
yaver acl remove ollama
```

ACL peers are also accessible via MCP tools (`acl_list_peers`, `acl_call_peer_tool`, etc.), enabling Claude to chain tools across multiple MCP servers.

## Components

| Directory | What | Tech |
|-----------|------|------|
| `desktop/agent/` | CLI agent (QUIC server, MCP, runner, sandbox) | Go |
| `desktop/installer/` | Installation GUI (DMG/EXE/DEB) | Electron |
| `mobile/` | iOS & Android app | React Native |
| `backend/` | Auth, peer discovery, platform config | Convex |
| `relay/` | QUIC relay server for NAT traversal | Go (quic-go) |
| `web/` | Landing page & docs | Next.js 15 on Vercel |

## CLI Commands

```
yaver auth          Sign in (opens browser — Apple, Google, or Microsoft)
yaver serve         Start the agent
yaver mcp           Start MCP server (--mode stdio|http)
yaver email         Email connector (setup, test, sync, status)
yaver acl           Agent Communication Layer (add, list, remove, tools, health)
yaver connect       Connect to a remote agent
yaver attach        Interactive terminal
yaver set-runner    Set default AI agent (claude/codex/aider/custom)
yaver relay         Manage relay servers
yaver config        Get/set configuration
yaver status        Show auth and connection status
yaver devices       List registered devices
yaver stop          Stop the agent
yaver logs          View agent logs
yaver version       Print version
```

### Install

```bash
# macOS / Linux
brew install kivanccakmak/yaver/yaver

# Windows
scoop bucket add yaver https://github.com/kivanccakmak/scoop-yaver
scoop install yaver
```

## Networking

Three-layer stack — no Tailscale, no TUN/TAP, no VPN rights. Application-layer only.

```
1. LAN Beacon (direct)  ──  ~5ms   ── same WiFi, instant discovery
2. Convex IP (direct)   ──  ~5ms   ── known IP from device registry
3. QUIC Relay (proxied) ──  ~50ms  ── roaming, NAT traversal
```

See [CLAUDE.md](CLAUDE.md) for detailed networking architecture.

## Development

```bash
cd backend && npm install && npx convex dev    # Convex dev server
cd web && npm install && npm run dev           # Web (localhost:3000)
cd desktop/agent && go run . serve --debug     # Desktop agent
cd relay && go run . serve --password secret   # Relay server (local)
```

### Tests

```bash
cd desktop/agent && go test -v ./...
```

Tests cover: health, auth, CORS, task CRUD, agent status, MCP protocol, sandbox validation, and server-client integration.

## Auth

- Apple Sign-In, Google Sign-In, Microsoft/Office 365
- `yaver auth` opens `https://yaver.io/auth?client=desktop` → OAuth → callback to `http://127.0.0.1:19836/callback?token=<token>`

## Self-Hosting

### Relay Server

```bash
# Docker
cd relay && RELAY_PASSWORD=secret docker compose up -d

# Or use the setup script
./scripts/setup-relay.sh <server-ip> <domain> --password <relay-password>
```

### No Relay (Tailscale)

```bash
yaver serve --no-relay  # Connect directly via Tailscale IP
```

## Legal

- [Privacy Policy](https://yaver.io/privacy)
- [Terms of Service](https://yaver.io/terms)

Developed by **SIMKAB ELEKTRIK** — Istanbul, Turkey

Contact: support@yaver.io

## License

MIT — Free and open source.
