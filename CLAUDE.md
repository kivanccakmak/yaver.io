# Yaver.io — Claude Code Project Guide

## What is Yaver?
Yaver is a P2P tool that lets developers use Claude from their mobile device or any terminal, connecting directly to their development machines. No central relay — all task data flows peer-to-peer between your devices. V1 uses Tailscale for networking; future versions will use a custom QUIC P2P stack.

**Company**: SIMKAB ELEKTRIK — Yunus Emre Mah. Adalar Sokak No:12 Sancaktepe/Istanbul, Turkey

## Architecture Overview
```
┌─────────────┐  Tailscale (V1)  ┌──────────────┐
│  Mobile App │◄───── HTTP ──────►│ Desktop Agent │
│ (React Native)                 │  (Go CLI)     │
└──────┬──────┘                  └──────┬────────┘
       │                                │
       │  Auth only                     │  Register device
       ▼                                ▼
┌──────────────────────────────────────────┐
│         Convex Backend                   │
│  (Auth + Peer Discovery ONLY)            │
│  Apple / Google / Microsoft Sign-In      │
└──────────────────────────────────────────┘
       ▲
       │
┌──────┴──────┐
│  Web (Vercel)│
│  yaver.io    │
│  Landing +   │
│  Sign Up     │
└─────────────┘
```
> **V1**: Networking uses Tailscale. Both devices must be on the same Tailnet.
> **V2+**: Custom QUIC P2P stack (no Tailscale dependency).

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
- `backend/` — Convex backend (auth + peer discovery only)
- `web/` — Next.js landing page, deployed on Vercel at yaver.io

## Tech Stack
- **Networking (V1)**: Tailscale (WireGuard) — HTTP over Tailscale mesh; custom QUIC P2P planned for V2
- **Auth**: Convex + Google Sign-In + Apple Sign-In + Microsoft/Office 365
- **Desktop Agent**: Go with quic-go, runs Claude CLI in tmux
- **Desktop Installer**: Electron (electron-builder for DMG/EXE/DEB)
- **Mobile**: React Native (native builds via xcodebuild/Gradle)
- **Web**: Next.js 15, deployed on Vercel (yaver.io)
- **Backend**: Convex (auth tables + device registry for peer discovery)

## Key Design Decisions
1. **P2P only** — Convex is ONLY for auth and peer discovery. Task data, logs, and output flow directly between mobile and desktop agent.
2. **Desktop = installer + CLI** — The Electron app is only for installation. The actual agent is a Go CLI binary.
3. **Privacy-first** — No code, task data, or AI output ever touches our servers.

## V1 Networking: Tailscale
**Version 1 uses Tailscale as the networking layer.** This is a deliberate decision to ship a functional product quickly while postponing the custom QUIC P2P networking stack to a later version.

V1 assumptions:
- Both the mobile device and desktop machine have Tailscale installed and are on the same Tailnet
- The mobile app connects to the desktop agent via Tailscale IP (HTTP over Tailscale's WireGuard tunnel)
- No custom QUIC, no NAT traversal, no relay servers needed — Tailscale handles all of that
- Device discovery can be manual (enter Tailscale IP) or via QR code pairing from the CLI
- A Hetzner relay server may be used for initial testing

Future versions will replace Tailscale with a custom QUIC P2P stack for zero-dependency networking.

## Conventions
- Go code: standard Go project layout, `gofmt`
- TypeScript/React: functional components, hooks, no class components
- Convex: mutations for writes, queries for reads, HTTP actions for OAuth callbacks
- Mobile: always native builds (xcodebuild for iOS, Gradle for Android), never Expo CLI

## Local Development
- `cd backend && npx convex dev` — Start Convex dev server
- `cd web && npm run dev` — Start web dev server
- `cd mobile/ios && xcodebuild ...` or open in Xcode — Build and run on device/simulator
- `cd desktop/agent && go run . serve` — Run desktop agent (QUIC server)
- `cd desktop/installer && npm run dist` — Build desktop installers (Electron GUI)

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
1. Cross-compile: `GOOS=darwin GOARCH=arm64 go build -o yaver-darwin-arm64 .` (repeat for darwin/amd64, linux/arm64, linux/amd64)
2. Create GitHub release on `kivanccakmak/yaver-cli` with all binaries
3. Update SHA256 hashes in `kivanccakmak/homebrew-yaver` Formula/yaver.rb
4. Users install via: `brew tap kivanccakmak/yaver && brew install yaver`

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
- **Sign in with Apple Key Path**: `web/AuthKey_2563MLJ593.p8`
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
