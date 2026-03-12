# Yaver.io

**Use Claude from anywhere.** Yaver connects your mobile device directly to your development machine over P2P QUIC — no cloud relay, no SSH, just encrypted peer-to-peer.

## How It Works

1. **Install the agent** on your dev machine (macOS/Windows/Linux)
2. **Sign in** with Google or Microsoft on the mobile app
3. **Your devices discover each other** via Convex (auth + peer discovery only)
4. **Send tasks directly** over QUIC — they run in Claude SDK on your machine
5. **Stream output back** to your phone in real-time

## Components

| Directory | What | Tech |
|-----------|------|------|
| `desktop/` | Installer GUI + CLI Agent | Electron + Go (quic-go) |
| `mobile/` | iOS & Android app | React Native + Expo |
| `backend/` | Auth & peer discovery | Convex |
| `web/` | Landing page & sign up | Next.js on Vercel |

## Quick Start

```bash
# Backend (Convex)
cd backend && npm install && npx convex dev

# Web (Vercel)
cd web && npm install && npm run dev

# Mobile
cd mobile && npm install && npx expo start

# Desktop Agent
cd desktop/agent && go run .
```

## CLI (`yaver`)

The `yaver` CLI lets you use Claude from any terminal — connect to your dev machine remotely.

### Install via Homebrew

```bash
brew tap kivanccakmak/yaver
brew install yaver
```

### Commands

```
yaver auth        Sign in (opens browser — Apple, Google, or Microsoft)
yaver signout     Sign out and clear credentials
yaver connect     Connect to your dev machine
yaver serve       Start the agent on this machine
yaver status      Show auth and connection status
yaver devices     List your registered devices
yaver help        Show help
yaver version     Print version
```

### Local Development

```bash
cd desktop/agent

# Run any command from source:
go run . auth
go run . serve
go run . connect
go run . status
go run . help

# Build a local binary:
go build -o yaver .
./yaver auth
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

- Apple Sign-In
- Google Sign-In
- Microsoft / Office 365

No email/password — OAuth only.

## P2P Architecture

All task data flows directly between your mobile and desktop over QUIC:

```
Mobile ──── QUIC (encrypted) ──── Desktop Agent
                                      │
                                      ├── Claude SDK
                                      ├── tmux sessions
                                      └── File system
```

Convex only stores:
- User accounts (OAuth tokens)
- Device registry (public keys, connection info for peer discovery)

## License

Proprietary — All rights reserved.
