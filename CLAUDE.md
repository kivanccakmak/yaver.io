# Yaver.io — Claude Code Project Guide

## Important Rules
- **Never push or commit without explicit user permission.** Vercel auto-deploys on push to main, which costs money.

## What is Yaver?
Yaver is a P2P tool that lets developers use Claude from their mobile device or any terminal, connecting directly to their development machines. Task data flows peer-to-peer between your devices — our servers only handle auth and peer discovery.

**Company**: SIMKAB ELEKTRIK — Yunus Emre Mah. Adalar Sokak No:12 Sancaktepe/Istanbul, Turkey

## Architecture Overview
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
       ▲
       │
┌──────┴──────┐
│  Web (Vercel)│
│  yaver.io    │
│  Landing +   │
│  Sign Up     │
└─────────────┘
```

### Connection strategy (direct-first, relay-fallback)
1. Mobile tries **direct connection** to desktop agent (3s timeout) — lowest latency
2. If direct fails, tries **each relay server** in priority order (5s timeout each)
3. Desktop agent connects outbound to **all** relay servers via QUIC tunnels on startup
4. If a relay goes down, traffic automatically routes through remaining relays

## Domain & URLs
- **Domain**: `yaver.io`
- **Website**: `https://yaver.io` (Next.js on Vercel)
- **Convex Site**: `https://shocking-echidna-394.eu-west-1.convex.site`
- **Apple Sign-In Notifications**: `https://shocking-echidna-394.eu-west-1.convex.site/auth/apple-notifications`
- **OAuth Callback (web)**: `https://yaver.io/api/auth/callback`
- **Deep Link Scheme**: `yaver://`

## Directory Structure
- `desktop/` — Electron installer (DMG/EXE/DEB) + Go CLI agent
  - `desktop/installer/` — Electron app for installation GUI
  - `desktop/agent/` — Go binary (QUIC server, Claude SDK runner, tmux manager)
- `mobile/` — React Native mobile app (iOS + Android)
- `backend/` — Convex backend (auth + peer discovery + platform config)
- `relay/` — QUIC relay server for NAT traversal (Go, deployed to Hetzner)
  - `relay/deploy/` — Deployment scripts (up.sh, down.sh, systemd unit)
- `web/` — Next.js landing page, deployed on Vercel at yaver.io

## Tech Stack
- **Networking**: Application-layer QUIC relay (direct-first, relay-fallback). No TUN/TAP, no VPN rights — won't conflict with user's VPN.
- **Relay Server**: Go with `quic-go`, deployed to Hetzner VPS via Docker. Agents connect outbound via QUIC tunnels; mobile makes short-lived HTTP requests.
- **Auth**: Convex + Google Sign-In + Apple Sign-In + Microsoft/Office 365
- **Desktop Agent**: Go with quic-go, runs Claude CLI in tmux
- **Desktop Installer**: Electron (electron-builder for DMG/EXE/DEB)
- **Mobile**: React Native (native builds via xcodebuild/Gradle)
- **Web**: Next.js 15, deployed on Vercel (yaver.io)
- **Backend**: Convex (auth tables + device registry + platform config for relay servers)

## Key Design Decisions
1. **P2P only** — Convex is ONLY for auth, peer discovery, and platform config. Task data, logs, and output flow directly between mobile and desktop agent (via relay if needed, but relay doesn't store anything).
2. **Desktop = installer + CLI** — The Electron app is only for installation. The actual agent is a Go CLI binary.
3. **Privacy-first** — No code, task data, or AI output ever touches our servers. The relay is a pass-through proxy.
4. **Relay is Yaver infrastructure** — Relay servers are managed by us, not by customers. Config is stored centrally in Convex `platformConfig` and auto-fetched by CLI/mobile.
5. **Multi-relay redundancy** — Multiple relay servers can be configured. If one goes down, traffic routes through others. Clients try all relays in priority order.
6. **Application-layer only** — No TUN/TAP, no VPN rights. Won't conflict with user's existing VPN (SurfShark, NordVPN, etc.).

## Networking: QUIC Relay

Yaver uses application-layer QUIC relay servers for NAT traversal and roaming. No Tailscale, no TUN/TAP, no VPN rights required.

### How it works
- **Desktop agent** connects outbound to all relay servers via QUIC tunnels on startup (solves NAT — no inbound ports needed)
- **Mobile app** makes short-lived HTTP requests to relay (IP changes from Wi-Fi/5G roaming don't matter)
- **Direct connection** is tried first (3s timeout) for lowest latency when on the same network
- **Relay fallback** kicks in automatically if direct fails, trying each relay in priority order
- **Reconnection** uses exponential backoff (1s → 2s → 4s → 8s → max 30s)

### Relay server config
Relay servers are stored in Convex `platformConfig` under the key `relay_servers` (JSON array). Clients auto-fetch from `GET /config` endpoint.

```bash
# View current relay servers
cd backend && npx convex run platformConfig:get '{"key":"relay_servers"}'

# Update relay servers
cd backend && npx convex run platformConfig:set '{"key":"relay_servers","value":"[{\"id\":\"hel1\",\"quicAddr\":\"37.27.184.85:4433\",\"httpUrl\":\"http://37.27.184.85:8443\",\"region\":\"eu-hel\",\"priority\":1}]"}'
```

### Current relay servers

| ID | IP | Ports | Region | Provider |
|---|---|---|---|---|
| `hel1` | `37.27.184.85` | QUIC 4433/udp, HTTP 8443/tcp | Helsinki (eu-hel) | Hetzner CAX11 (ARM64) |

## Conventions
- Go code: standard Go project layout, `gofmt`
- TypeScript/React: functional components, hooks, no class components
- Convex: mutations for writes, queries for reads, HTTP actions for OAuth callbacks
- Mobile: always native builds (xcodebuild for iOS, Gradle for Android), never Expo CLI

## Scripts

### Cleanup user data from Convex
Remove all data (user, sessions, devices) for specific emails:
```bash
cd backend && node cleanup-user.mjs                  # dry-run
cd backend && node cleanup-user.mjs --confirm        # actually delete
```
Edit `backend/cleanup-user.mjs` to change the target emails. Uses `backend/convex/admin.ts` functions.

## Local Development
- `cd backend && npx convex dev` — Start Convex dev server
- `cd web && npm run dev` — Start web dev server
- `cd mobile/ios && xcodebuild ...` or open in Xcode — Build and run on device/simulator
- `cd desktop/agent && go run . serve` — Run desktop agent (auto-connects to relays from Convex)
- `cd desktop/installer && npm run dist` — Build desktop installers (Electron GUI)
- `cd relay && go run . serve` — Run relay server locally

### CLI Development (`desktop/agent/`)
The `yaver` CLI is a Go binary in `desktop/agent/`. Run from source during development:
```bash
cd desktop/agent
go run . auth       # Sign in via browser (Apple/Google/Microsoft)
go run . serve      # Start QUIC agent server
go run . connect    # Connect to a remote agent
go run . status     # Show auth status
go run . devices    # List registered devices
go run . help       # Show all commands
```

Build a local binary: `cd desktop/agent && go build -o yaver .`

### CLI Release Process
1. Cross-compile: `GOOS=darwin GOARCH=arm64 go build -o yaver-darwin-arm64 .` (repeat for darwin/amd64, linux/arm64, linux/amd64, windows/amd64)
2. Sign Windows .exe: `./scripts/sign-windows.sh yaver-windows-amd64.exe` (requires SimplySign Desktop logged in)
3. Create GitHub release on `kivanccakmak/yaver-cli` with all binaries
4. Update SHA256 hashes in `kivanccakmak/homebrew-yaver` Formula/yaver.rb
5. Update Scoop manifest in `kivanccakmak/scoop-yaver` bucket/yaver.json
6. Upload binaries to Convex storage for download page (see `scripts/upload-downloads.mjs`)
7. Users install via:
   - macOS/Linux: `brew tap kivanccakmak/yaver && brew install yaver`
   - Windows: `scoop bucket add yaver https://github.com/kivanccakmak/scoop-yaver && scoop install yaver`

### Windows Code Signing (Certum / SimplySign)
We use **Certum** (Polish CA) with **SimplySign** cloud-based PKCS#11 signing. NOT Azure Sign Tool.

**Prerequisites:**
1. SimplySign Desktop installed: `brew install --cask simplysign`
2. proCertumSmartSign installed (provides bundled JDK)
3. jsign at `/tmp/jsign.jar` (auto-downloaded by script)

**Signing flow:**
1. Generate OTP: `./scripts/certum-otp.sh`
2. Open SimplySign Desktop and log in (email: kivanccakmak@gmail.com + password + OTP from script above)
3. Run: `./scripts/sign-windows.sh <file.exe>`
4. Script uses jsign + PKCS#11 to sign with Certum certificate (serial: `33F009BCF17FA6764B6A9BCD1664E63E`)
5. Timestamp server: `http://time.certum.pl`

**Key paths:**
- PKCS#11 library: `/usr/local/lib/libSimplySignPKCS.dylib`
- Signing script: `scripts/sign-windows.sh`
- OTP generator: `scripts/certum-otp.sh`
- TOTP secret: `~/Downloads/otpauthuri.txt`

### CLI Auth Flow
`yaver auth` opens `https://yaver.io/auth?client=desktop` in the browser. The web app handles OAuth (Apple/Google/Microsoft) and redirects back to `http://127.0.0.1:19836/callback?token=<token>`. The CLI's local HTTP server receives the token and saves it to `~/.config/yaver/config.json`.

---

## Apple Developer (simkab team)
- **Team ID**: `5SJZ4KA39A`
- **Bundle ID**: `io.yaver.mobile`
- **App Store Connect API Key ID**: `77Z6B543D5`
- **App Store Connect API Key Issuer ID**: `7bd9329e-49b0-440a-97ed-873c74244c12`
- **App Store Connect API Key Path**: `~/Workspace/talos/mobile/ios/AuthKey_77Z6B543D5.p8` (shared with Talos)
- **Sign in with Apple Key ID**: `2563MLJ593`
- **Sign in with Apple Key Path**: `keys/AuthKey_2563MLJ593.p8`
- **Apple Services ID (web OAuth)**: `io.yaver.web`

Both Yaver and Talos are developed under the SIMKAB ELEKTRIK Apple Developer team.

---

## Deployments

### Convex Backend
```bash
cd backend

# Push to dev (shocking-echidna-394)
npx convex dev --once

# Push to prod (perceptive-minnow-557)
npx convex deploy --yes
```
- **Dev**: `https://shocking-echidna-394.eu-west-1.convex.site`
- **Prod**: `https://perceptive-minnow-557.eu-west-1.convex.cloud`

### Web (Vercel)
Deploys automatically on push to main. Domain: `yaver.io`

Required Vercel env vars:
- `CONVEX_SITE_URL` — `https://shocking-echidna-394.eu-west-1.convex.site`
- `NEXT_PUBLIC_BASE_URL` — `https://yaver.io`
- `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET`
- `OAUTH_MICROSOFT_CLIENT_ID` / `OAUTH_MICROSOFT_CLIENT_SECRET` / `OAUTH_MICROSOFT_TENANT_ID`
- `OAUTH_APPLE_CLIENT_ID` — `io.yaver.web` (Apple Services ID)
- `OAUTH_APPLE_TEAM_ID` — `5SJZ4KA39A`
- `OAUTH_APPLE_KEY_ID` — `2563MLJ593`
- `OAUTH_APPLE_PRIVATE_KEY` — contents of `web/AuthKey_2563MLJ593.p8` (with `\n` for newlines)

### Relay Server (Hetzner)

Current server: `37.27.184.85` (Hetzner CAX11, ARM64, Ubuntu 24.04, 4GB RAM, 40GB SSD)

```bash
# Deploy via Docker (recommended)
cd relay && ./deploy/up.sh 37.27.184.85 --docker

# Deploy via binary + systemd
cd relay && ./deploy/up.sh 37.27.184.85

# Stop relay
cd relay && ./deploy/down.sh 37.27.184.85

# Stop + purge everything
cd relay && ./deploy/down.sh 37.27.184.85 --purge

# Logs (Docker)
ssh root@37.27.184.85 docker logs -f yaver-relay

# Logs (systemd)
ssh root@37.27.184.85 journalctl -u yaver-relay -f

# Health check
curl http://37.27.184.85:8443/health

# Active tunnels
curl http://37.27.184.85:8443/tunnels

# Server resources
ssh root@37.27.184.85 'df -h / && free -h && docker ps'
```

Adding a new relay server:
1. Deploy relay to new VPS: `./deploy/up.sh <new-ip> --docker`
2. Verify: `curl http://<new-ip>:8443/health`
3. Add to Convex: `npx convex run platformConfig:set '{"key":"relay_servers","value":"[...existing...,{\"id\":\"new1\",\"quicAddr\":\"<ip>:4433\",\"httpUrl\":\"http://<ip>:8443\",\"region\":\"<region>\",\"priority\":2}]"}'`
4. Clients pick it up automatically on next startup

### iOS — TestFlight (Local, No EAS, No Fastlane)

#### First-time setup
```bash
cd mobile
npx expo prebuild --platform ios
cd ios && pod install
```
> **Warning**: `npx expo prebuild --clean` resets CFBundleVersion to 1. Restore manually.

#### Deploy to TestFlight
```bash
./scripts/deploy-testflight.sh
```

This script:
1. Bumps CFBundleVersion in Info.plist
2. Archives with `xcodebuild` (automatic signing, API key auth)
3. Exports and uploads to App Store Connect
4. Build appears in TestFlight within 5-15 minutes

Manual build command (if script needs debugging):
```bash
cd mobile/ios
xcodebuild -workspace Yaver.xcworkspace -scheme Yaver -configuration Release \
  -archivePath /tmp/Yaver.xcarchive archive \
  DEVELOPMENT_TEAM=5SJZ4KA39A CODE_SIGN_STYLE=Automatic \
  ENABLE_USER_SCRIPT_SANDBOXING=NO -allowProvisioningUpdates \
  -authenticationKeyPath ~/Workspace/talos/mobile/ios/AuthKey_77Z6B543D5.p8 \
  -authenticationKeyID 77Z6B543D5 \
  -authenticationKeyIssuerID 7bd9329e-49b0-440a-97ed-873c74244c12 \
  -derivedDataPath /tmp/YaverBuild
```

Export & upload:
```bash
xcodebuild -exportArchive -archivePath /tmp/Yaver.xcarchive \
  -exportOptionsPlist /tmp/ExportOptions.plist \
  -exportPath /tmp/YaverExport -allowProvisioningUpdates \
  -authenticationKeyPath ~/Workspace/talos/mobile/ios/AuthKey_77Z6B543D5.p8 \
  -authenticationKeyID 77Z6B543D5 \
  -authenticationKeyIssuerID 7bd9329e-49b0-440a-97ed-873c74244c12
```

Key xcodebuild flags:
- `CODE_SIGN_STYLE=Automatic` — no manual cert/profile management
- `ENABLE_USER_SCRIPT_SANDBOXING=NO` — prevents sandbox errors during archive
- `-allowProvisioningUpdates` — lets xcodebuild create/refresh profiles via API key
- `-authenticationKey*` — App Store Connect API key auth (no Xcode account needed)

### Android — Google Play (Local)

#### First-time setup
```bash
cd mobile
npx expo prebuild --platform android
```

#### Build release AAB
Requires Java 17 (Gradle 8.10 does not support Java 24):
```bash
cd mobile/android
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew bundleRelease
```

Output: `mobile/android/app/build/outputs/bundle/release/app-release.aab`

Upload to Google Play Console manually or via:
```bash
# TODO: add bundletool / Google Play API upload script
```

### Version Bumping (before releases)
Update version in **three** places:
1. `mobile/app.json` → `expo.version` (e.g. "1.0.1")
2. `mobile/ios/Yaver.xcodeproj/project.pbxproj` → `MARKETING_VERSION` (e.g. 1.0.1)
3. `mobile/android/app/build.gradle` → `versionName` (e.g. "1.0.1")

Build numbers (CFBundleVersion / versionCode) are auto-incremented by deploy scripts.
