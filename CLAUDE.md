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
│  yaver.io    │
│  Landing +   │
│  Sign Up     │
└─────────────┘
```

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
- `mobile/` — React Native (Expo) mobile app (iOS + Android)
- `backend/` — Convex backend (auth + peer discovery only)
- `web/` — Next.js landing page, deployed on Vercel at yaver.io

## Tech Stack
- **P2P Transport**: QUIC (quic-go on desktop, react-native-quic on mobile)
- **Auth**: Convex + Google Sign-In + Apple Sign-In + Microsoft/Office 365
- **Desktop Agent**: Go with quic-go, runs Claude CLI in tmux
- **Desktop Installer**: Electron (electron-builder for DMG/EXE/DEB)
- **Mobile**: React Native + Expo SDK 52
- **Web**: Next.js 15, deployed on Vercel (yaver.io)
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

## Local Development
- `cd backend && npx convex dev` — Start Convex dev server
- `cd web && npm run dev` — Start web dev server
- `cd mobile && npx expo start` — Start mobile dev server
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
- **API Key ID**: `77Z6B543D5`
- **API Key Issuer ID**: `7bd9329e-49b0-440a-97ed-873c74244c12`
- **API Key Path**: `~/Workspace/talos/mobile/ios/AuthKey_77Z6B543D5.p8` (shared with Talos)

Both Yaver and Talos are developed under the simkab Apple Developer team.

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
- `OAUTH_APPLE_CLIENT_ID` / `OAUTH_APPLE_CLIENT_SECRET`

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
