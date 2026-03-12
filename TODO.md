# Yaver.io — TODO

## Phase 1: Foundation
- [x] Project structure and documentation
- [x] CLAUDE.md, README.md, DOWNLOADS.md
- [x] Convex backend setup (auth schema, Google + Microsoft OAuth)
- [x] Web landing page (Next.js on Vercel)
- [x] Mobile app scaffold (React Native + Expo)
- [x] Desktop agent scaffold (Go + QUIC)
- [x] Desktop installer scaffold (Electron)

## Phase 2: Auth Flow
- [ ] Convex: Google OAuth mutation/action
- [ ] Convex: Microsoft/Office 365 OAuth mutation/action
- [ ] Convex: Session management (token generation, validation)
- [ ] Convex: Device registration (peer discovery)
- [ ] Web: OAuth callback routes
- [ ] Mobile: OAuth deep link handling (Google + Microsoft)
- [ ] Desktop agent: Auth token exchange via CLI

## Phase 3: P2P / QUIC Layer
- [ ] Go agent: QUIC server with TLS
- [ ] Go agent: Peer authentication (verify Convex token)
- [ ] Go agent: Task protocol over QUIC streams
- [ ] Go agent: Log streaming over QUIC
- [ ] Mobile: QUIC client (react-native-quic or native module)
- [ ] Mobile: Peer discovery via Convex device registry
- [ ] Mobile: Connection management (reconnect, keepalive)
- [ ] NAT traversal / hole punching for P2P

## Phase 4: Task Execution
- [ ] Go agent: Claude SDK integration (run claude CLI)
- [ ] Go agent: tmux session management
- [ ] Go agent: Task lifecycle (create, queue, run, done, failed)
- [ ] Go agent: Output capture and streaming
- [ ] Mobile: Task creation UI
- [ ] Mobile: Real-time output display
- [ ] Mobile: Task list (running, queued, completed)
- [ ] Mobile: Continue/stop task actions

## Phase 5: Desktop Installer
- [ ] Electron installer UI
- [ ] macOS DMG build (electron-builder)
- [ ] Windows EXE/NSIS build
- [ ] Linux DEB/AppImage build
- [ ] Auto-install Go agent binary
- [ ] System service registration (launchd/systemd)

## Phase 6: Web Landing Page
- [ ] Hero section with product demo
- [ ] Feature highlights
- [ ] Download section (links to installers)
- [ ] Sign up / Sign in page
- [ ] Dashboard (device management)
- [ ] Pricing page

## Phase 7: App Store & Distribution
- [ ] iOS: Apple Developer account, App Store listing
- [ ] iOS: Push notification setup (APNs)
- [ ] Android: Google Play Console, Play Store listing
- [ ] Android: Firebase Cloud Messaging
- [ ] Desktop: Code signing (macOS notarization, Windows Authenticode)
- [ ] Auto-update mechanism

## Phase 8: Polish & Launch
- [ ] End-to-end encryption audit
- [ ] Performance optimization (QUIC tuning)
- [ ] Error handling and offline mode
- [ ] Analytics and crash reporting
- [ ] Documentation site
- [ ] Beta testing program
