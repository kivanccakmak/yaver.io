#!/bin/bash
set -e

cd "$(dirname "$0")/../mobile/ios"

# App Store Connect API key (simkab team, shared with Talos)
AUTH_KEY="$HOME/Workspace/talos/mobile/ios/AuthKey_77Z6B543D5.p8"
AUTH_KEY_ID="77Z6B543D5"
AUTH_KEY_ISSUER="7bd9329e-49b0-440a-97ed-873c74244c12"

# Bump build number
PLIST="Yaver/Info.plist"
CURRENT_BUILD=$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$PLIST")
NEW_BUILD=$((CURRENT_BUILD + 1))
/usr/libexec/PlistBuddy -c "Set CFBundleVersion $NEW_BUILD" "$PLIST"
echo "Build $CURRENT_BUILD → $NEW_BUILD"

# Archive
echo "Archiving..."
xcodebuild -workspace Yaver.xcworkspace -scheme Yaver -configuration Release \
  -archivePath /tmp/Yaver.xcarchive archive \
  DEVELOPMENT_TEAM=5SJZ4KA39A CODE_SIGN_STYLE=Automatic \
  ENABLE_USER_SCRIPT_SANDBOXING=NO -allowProvisioningUpdates \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_KEY_ISSUER" \
  -derivedDataPath /tmp/YaverBuild 2>&1 | tail -1

# ExportOptions
cat > /tmp/ExportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store</string>
    <key>teamID</key><string>5SJZ4KA39A</string>
    <key>signingStyle</key><string>automatic</string>
    <key>destination</key><string>upload</string>
</dict>
</plist>
EOF

# Export & upload
echo "Exporting & uploading..."
xcodebuild -exportArchive -archivePath /tmp/Yaver.xcarchive \
  -exportOptionsPlist /tmp/ExportOptions.plist \
  -exportPath /tmp/YaverExport -allowProvisioningUpdates \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_KEY_ISSUER" 2>&1 | tail -1

echo "✓ TestFlight build $NEW_BUILD uploaded"
