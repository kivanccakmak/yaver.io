---
name: yaver-io-project
description: Yaver.io is a P2P tool for developers to use Claude SDK from mobile/terminal, connecting directly to dev machines over QUIC
type: project
---

Yaver.io is a commercial product (not internal like Talos) that lets developers use Claude SDK from their mobile device, connecting P2P over QUIC to their development machine.

**Why:** Developers need to run Claude tasks on their dev machines when away from their desk. P2P avoids cloud relay costs and latency.

**How to apply:**
- 4 directories: desktop/ (Electron installer + Go agent), mobile/ (React Native/Expo), backend/ (Convex auth-only), web/ (Next.js on Vercel)
- Auth: Google Sign-In + Microsoft/Office 365 via Convex ONLY
- No SSH (unlike Talos) — QUIC for all P2P communication
- Convex is ONLY for auth + peer discovery, NOT for task data
- Reference Talos project at /Users/kivanccakmak/Workspace/talos/ for patterns but different stack
- Go agent runs Claude CLI in tmux, streams output back over QUIC
- Desktop installer creates DMG (macOS), EXE (Windows), DEB (Linux)
