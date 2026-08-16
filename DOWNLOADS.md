# Yaver — Downloads

## Desktop Agent

Install the Yaver agent on your development machine to connect with your mobile device.

### macOS
- **Apple Silicon (M1/M2/M3/M4)**: [Download DMG (arm64)](https://yaver.io/download/macos-arm64)
- **Intel**: [Download DMG (x64)](https://yaver.io/download/macos-x64)

### Windows
- **Windows 10/11 (64-bit)**: [Download Installer (exe)](https://yaver.io/download/windows-x64)

### Linux
- **Debian/Ubuntu (amd64)**: [Download .deb](https://yaver.io/download/linux-deb-amd64)
- **Debian/Ubuntu (arm64)**: [Download .deb](https://yaver.io/download/linux-deb-arm64)
- **AppImage (amd64)**: [Download AppImage](https://yaver.io/download/linux-appimage-amd64)

## Mobile App

### iOS
- [App Store](https://apps.apple.com/app/yaver/id0000000000) *(coming soon)*
- [TestFlight Beta](https://testflight.apple.com/join/XXXXXXXX) *(coming soon)*

### Android
- [Google Play](https://play.google.com/store/apps/details?id=io.yaver.mobile) *(coming soon)*
- [Direct APK](https://yaver.io/download/android-apk) *(coming soon)*

## CLI (Advanced)

If you prefer to install the agent without the GUI installer:

```bash
# macOS / Linux
curl -fsSL https://yaver.io/install.sh | sh

# Or with Homebrew
brew install yaver-io/tap/yaver

# Windows (PowerShell)
irm https://yaver.io/install.ps1 | iex
```

## System Requirements

### Desktop Agent
- macOS 12+ / Windows 10+ / Ubuntu 20.04+
- 512 MB RAM
- Claude CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Internet connection (for initial auth + peer discovery)

### Mobile App
- iOS 16+ / Android 12+
