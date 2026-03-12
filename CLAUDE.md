# Yaver.io — Claude Code Project Guide

## What is Yaver?
Yaver is a P2P tool that lets developers use Claude SDK from their mobile device or any terminal, connecting directly to their development machines. No central relay — all task data flows peer-to-peer over QUIC.

## Architecture Overview
```
┌─────────────┐         ┌──────────────┐
│  Mobile App │◄──QUIC──►│ Desktop Agent │
│ (React Native)        │  (Go CLI)     │
└──────┬──────┘         └──────┬────────┘
       │                       │
       │  Auth only            │  Register device
       ▼                       ▼
┌──────────────────────────────────────┐
│       Convex Backend                 │
│  (Auth + Peer Discovery ONLY)        │
│  Google Sign-In / Office 365         │
└──────────────────────────────────────┘
       ▲
       │
┌──────┴──────┐
│  Web (Vercel)│
│  Landing +   │
│  Sign Up     │
└─────────────┘
```

## Directory Structure
- `desktop/` — Electron installer (DMG/EXE/DEB) + Go CLI agent
  - `desktop/installer/` — Electron app for installation GUI
  - `desktop/agent/` — Go binary (QUIC server, Claude SDK runner, tmux manager)
- `mobile/` — React Native (Expo) mobile app (iOS + Android)
- `backend/` — Convex backend (auth + peer discovery only)
- `web/` — Next.js landing page on Vercel

## Tech Stack
- **P2P Transport**: QUIC (quic-go on desktop, react-native-quic on mobile)
- **Auth**: Convex + Google Sign-In + Microsoft/Office 365
- **Desktop Agent**: Go with quic-go, runs Claude CLI in tmux
- **Desktop Installer**: Electron (electron-builder for DMG/EXE/DEB)
- **Mobile**: React Native + Expo SDK 52
- **Web**: Next.js 15, deployed on Vercel
- **Backend**: Convex (auth tables + device registry for peer discovery)

## Key Design Decisions
1. **P2P only** — Convex is ONLY for auth and peer discovery. Task data, logs, and output flow directly over QUIC between mobile and desktop agent.
2. **No SSH** — Unlike Talos, we use QUIC for all communication. No SSH tunnels.
3. **QUIC for everything** — Connection establishment, task submission, log streaming, file transfer.
4. **Desktop = installer + CLI** — The Electron app is only for installation. The actual agent is a Go CLI binary.

## Conventions
- Go code: standard Go project layout, `gofmt`
- TypeScript/React: functional components, hooks, no class components
- Convex: mutations for writes, queries for reads, HTTP actions for OAuth callbacks
- Mobile: Expo managed workflow where possible

## Commands
- `cd backend && npx convex dev` — Start Convex dev server
- `cd web && npm run dev` — Start web dev server
- `cd mobile && npx expo start` — Start mobile dev server
- `cd desktop/agent && go run .` — Run desktop agent
- `cd desktop/installer && npm run dist` — Build desktop installers
