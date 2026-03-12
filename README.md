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

## Auth

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
