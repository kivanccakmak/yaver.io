# Yaver

**Use Claude from anywhere.** Yaver connects your mobile device directly to your development machine — no cloud relay, just encrypted peer-to-peer.

## V1: Tailscale Networking

**Version 1 uses Tailscale as the networking layer.** This is a deliberate choice to ship a functional product quickly while postponing the custom QUIC P2P networking stack.

### Prerequisites

- [Tailscale](https://tailscale.com) installed on both mobile and desktop
- Both devices on the same Tailnet
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed on desktop

### How It Works

```
Phone (Tailscale) ◄──── HTTP ────► Desktop Agent (Tailscale)
                                        │
                                   Claude CLI
                                        │
                                   Your Codebase
```

Tailscale provides encrypted WireGuard tunnels. The Yaver desktop agent listens for HTTP requests and runs Claude CLI tasks. The mobile app connects via the desktop's Tailscale IP.

Our backend (Convex) is used **only** for authentication and device discovery. Your code, prompts, and AI outputs never touch our servers.

## Components

| Directory | What | Tech |
|-----------|------|------|
| `desktop/` | Installer GUI + CLI Agent | Electron + Go |
| `mobile/` | iOS & Android app | React Native |
| `backend/` | Auth & peer discovery | Convex |
| `web/` | Landing page & auth | Next.js 15 on Vercel |

## Quick Start

```bash
# On your desktop machine:
brew tap kivanccakmak/yaver && brew install yaver
yaver auth          # Sign in via browser (Apple/Google/Microsoft)
yaver serve         # Start the agent

# On your phone:
# Download Yaver from the App Store / Google Play
# Sign in, enter your desktop's Tailscale IP, and start sending tasks
```

## Development

```bash
cd backend && npm install && npx convex dev    # Convex dev server
cd web && npm install && npm run dev           # Web (localhost:3000)
cd mobile/ios && pod install && xcodebuild ...  # Mobile (native build)
cd desktop/agent && go run . serve             # Desktop agent
```

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

### Cross-compile & Release

```bash
cd desktop/agent
GOOS=darwin GOARCH=arm64 go build -o yaver-darwin-arm64 .
GOOS=darwin GOARCH=amd64 go build -o yaver-darwin-amd64 .
GOOS=linux  GOARCH=arm64 go build -o yaver-linux-arm64 .
GOOS=linux  GOARCH=amd64 go build -o yaver-linux-amd64 .
```

Upload to [yaver-cli releases](https://github.com/kivanccakmak/yaver-cli/releases), then update SHA256 hashes in the [homebrew-yaver tap](https://github.com/kivanccakmak/homebrew-yaver).

## Auth

- Apple Sign-In (native on iOS, web OAuth on Android)
- Google Sign-In
- Microsoft / Office 365

No email/password — OAuth only.

## Admin Scripts

```bash
# Remove user data from Convex (dry-run first, then --confirm)
cd backend && node cleanup-user.mjs
cd backend && node cleanup-user.mjs --confirm
```

## Future (V2+)

- Custom QUIC P2P networking (no Tailscale dependency)
- Passkey/QR code pairing between devices
- NAT traversal and relay fallback
- Multi-device task routing

## Legal

- [Privacy Policy](https://yaver.io/privacy)
- [Terms of Service](https://yaver.io/terms)

Developed by **SIMKAB ELEKTRIK** — Yunus Emre Mah. Adalar Sokak No:12, Sancaktepe, Istanbul, Turkey

Contact: support@yaver.io

## License

Proprietary — All rights reserved.
