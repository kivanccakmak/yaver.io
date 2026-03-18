# Yaver

**Use Claude from anywhere.** Yaver connects your mobile device directly to your development machine — task data flows peer-to-peer between your devices. Our servers only handle auth and peer discovery.

## How It Works

```
┌─────────────┐     HTTP         ┌──────────────┐    QUIC tunnel    ┌──────────────┐
│  Mobile App │─────────────────►│ Relay Server │◄──────────────────│ Desktop Agent│
│ (React Native)  short-lived    │  (Hetzner)   │  persistent       │  (Go CLI)    │
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

No code, task data, or AI output ever touches our servers. The relay is a pass-through proxy — it forwards bytes without inspecting or storing them. When you're on the same network, traffic goes direct and skips the relay entirely.

## Components

| Directory | What | Tech |
|-----------|------|------|
| `desktop/agent/` | CLI agent (QUIC server, Claude SDK runner, tmux manager) | Go |
| `desktop/installer/` | Installation GUI (DMG/EXE/DEB) | Electron |
| `mobile/` | iOS & Android app | React Native |
| `backend/` | Auth, peer discovery, platform config | Convex |
| `relay/` | QUIC relay server for NAT traversal | Go (quic-go) |
| `web/` | Landing page & sign-up | Next.js 15 on Vercel |

## Quick Start

```bash
# On your desktop:
brew tap kivanccakmak/yaver && brew install yaver
yaver auth          # Sign in via browser (Apple/Google/Microsoft)
yaver serve         # Start the agent — connects to relays automatically

# On your phone:
# Download Yaver from the App Store / Google Play
# Sign in with the same account, your desktop appears automatically
```

## Networking

Yaver uses a three-layer networking stack. No Tailscale, no TUN/TAP, no VPN rights — application-layer only, so it won't conflict with your existing VPN.

### Connection Priority

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CONNECTION PRIORITY                               │
│                                                                     │
│  1. LAN Beacon (direct)  ──  ~5ms   ── same WiFi, instant discovery│
│  2. Convex IP (direct)   ──  ~5ms   ── known IP from device registry│
│  3. QUIC Relay (proxied) ──  ~50ms  ── roaming, NAT traversal      │
│                                                                     │
│  Silent roaming: transitions between layers are invisible to user   │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer 1: LAN Beacon Discovery (same network)

Proprietary UDP broadcast protocol for instant same-network device discovery.

- The CLI broadcasts a beacon every 3s on UDP port `19837` (`255.255.255.255`)
- Mobile listens on port `19837` via `react-native-udp`
- **Auth-aware**: beacon includes a token fingerprint (`th` = first 8 hex chars of SHA256(userId)) — only same-user devices match
- Beacon payload (~100 bytes):
  ```json
  {"v":1,"id":"dcbfdc50","p":18080,"n":"MacBook-Air","th":"a1b2c3d4"}
  ```
- Mobile matches beacon `id` against its Convex device list and `th` against its userId fingerprint
- Discovered devices get a `local: true` flag and their IP is used for direct HTTP connection
- If no beacon received for 10s, the device is marked as not local and falls back to relay
- **Graceful degradation**: if UDP socket fails (OS restriction, permission denied), everything works via Convex + relay

### Layer 2: Convex Device Registry (cross-network)

Central presence hub for auth, pairing, and cross-network visibility.

- CLI registers on `yaver serve` start: sends `{deviceId, hostname, platform, localIP, httpPort}` to Convex
- CLI heartbeat every 2 minutes includes current local IP (handles DHCP changes, VPN toggles)
- Mobile polls device list every 3 seconds — sees devices come online within seconds
- A device is "online" if `isOnline=true` AND `lastHeartbeat` within 5 minutes
- On `yaver serve` stop, CLI marks the device offline immediately

### Layer 3: QUIC Relay (NAT traversal / roaming)

Application-layer QUIC relay for when direct connection isn't possible.

- Desktop agent connects outbound to all relay servers via QUIC tunnels on startup (solves NAT — no inbound ports needed)
- Mobile makes short-lived HTTP requests to the relay (IP changes from Wi-Fi/5G roaming don't matter)
- Relay is pass-through — no data is stored
- Multi-relay redundancy: multiple relay servers can be configured. If one goes down, traffic routes through remaining relays
- Reconnection uses exponential backoff (1s → 2s → 4s → 8s → max 30s)

### Connection Flow

```
Mobile connects to a device:
  │
  ├─ On WiFi?
  │   ├─ LAN beacon found? → direct HTTP to beacon IP:port (2s timeout)
  │   │   └─ Success → mode = "direct" ✓
  │   │
  │   ├─ Convex IP is private? → direct HTTP to Convex IP:port (2s timeout)
  │   │   └─ Success → mode = "direct" ✓
  │   │
  │   └─ Direct failed → try relay servers in priority order
  │       └─ Success → mode = "relay" ✓
  │
  ├─ On Cellular? → skip direct, try relay servers immediately
  │   └─ Success → mode = "relay" ✓
  │
  └─ All failed → error, reconnect with exponential backoff (max 15 attempts)

Network changes (WiFi ↔ cellular):
  → Full reconnect with new strategy
  → WiFi→Cellular: relay (direct skipped)
  → Cellular→WiFi: direct first (beacon rediscovered), relay fallback
  → All transitions are silent — no UI disruption
```

### Key Networking Files

| File | Purpose |
|------|---------|
| `desktop/agent/beacon.go` | UDP broadcast beacon (send every 3s) |
| `desktop/agent/httpserver.go` | HTTP server on `0.0.0.0:18080` |
| `desktop/agent/quic.go` | QUIC server on `0.0.0.0:4433` |
| `mobile/src/lib/beacon.ts` | UDP beacon listener + auth matching |
| `mobile/src/lib/quic.ts` | Connection strategy (direct-first, relay-fallback) |
| `mobile/src/context/DeviceContext.tsx` | Device list, beacon integration, auto-connect |
| `relay/` | QUIC relay server (Go, deployed to Hetzner) |

## CLI (`yaver`)

```
yaver auth        Sign in (opens browser — Apple, Google, or Microsoft)
yaver signout     Sign out and clear credentials
yaver serve       Start the agent on this machine
yaver connect     Connect to your dev machine
yaver status      Show auth and connection status
yaver devices     List your registered devices
yaver help        Show help
yaver version     Print version
```

### Install

```bash
# macOS / Linux
brew tap kivanccakmak/yaver && brew install yaver

# Windows
scoop bucket add yaver https://github.com/kivanccakmak/scoop-yaver
scoop install yaver
```

### Cross-compile & Release

```bash
cd desktop/agent
GOOS=darwin GOARCH=arm64 go build -o yaver-darwin-arm64 .
GOOS=darwin GOARCH=amd64 go build -o yaver-darwin-amd64 .
GOOS=linux  GOARCH=arm64 go build -o yaver-linux-arm64 .
GOOS=linux  GOARCH=amd64 go build -o yaver-linux-amd64 .
GOOS=windows GOARCH=amd64 go build -o yaver-windows-amd64.exe .
```

Upload to [yaver-cli releases](https://github.com/kivanccakmak/yaver-cli/releases), then update SHA256 hashes in the [Homebrew tap](https://github.com/kivanccakmak/homebrew-yaver) and [Scoop manifest](https://github.com/kivanccakmak/scoop-yaver).

## Auth

- Apple Sign-In (native on iOS, web OAuth on desktop/Android)
- Google Sign-In
- Microsoft / Office 365
- Email/password (test accounts only)

`yaver auth` opens `https://yaver.io/auth?client=desktop` in the browser. The web app handles OAuth and redirects back to `http://127.0.0.1:19836/callback?token=<token>`. The CLI's local HTTP server receives the token and saves it to `~/.config/yaver/config.json`.

## Development

```bash
cd backend && npm install && npx convex dev    # Convex dev server
cd web && npm install && npm run dev           # Web (localhost:3000)
cd desktop/agent && go run . serve             # Desktop agent
cd relay && go run . serve                     # Relay server (local)
cd mobile/ios && pod install                   # iOS (then build via Xcode)
```

### Tests

```bash
cd desktop/agent && go test -v ./...
```

Tests spin up real HTTP servers on random ports — no mocks, no external dependencies. Covers health, auth, CORS, task CRUD, agent status, ping/pong, shutdown, server-client integration, and MCP protocol.

## Admin Scripts

```bash
# Remove user data from Convex (dry-run first, then --confirm)
cd backend && node cleanup-user.mjs
cd backend && node cleanup-user.mjs --confirm
```

## Legal

- [Privacy Policy](https://yaver.io/privacy)
- [Terms of Service](https://yaver.io/terms)

Developed by **SIMKAB ELEKTRIK** — Yunus Emre Mah. Adalar Sokak No:12, Sancaktepe, Istanbul, Turkey

Contact: support@yaver.io

## License

Proprietary — All rights reserved.
