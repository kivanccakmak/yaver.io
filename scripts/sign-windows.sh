#!/bin/bash
# ============================================
# Sign Windows Executables with Certum Certificate
# ============================================
# Signs one or more .exe files using jsign + SimplySign PKCS#11
#
# Usage:
#   ./scripts/sign-windows.sh <file.exe> [file2.exe ...]
#   ./scripts/sign-windows.sh desktop-app/dist-electron/*.exe
#   ./scripts/sign-windows.sh cli/build/talcli-windows-*.exe
#
# Prerequisites:
#   1. SimplySign Desktop installed and logged in (brew install --cask simplysign)
#   2. jsign JAR at /tmp/jsign.jar (or set JSIGN_JAR env var)
#   3. Java available (uses proCertumSmartSign's bundled JDK)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_info() { echo -e "${CYAN}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[OK]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Java from proCertumSmartSign or system
if [ -d "/Applications/proCertumSmartSign.app/Contents/PlugIns/jdk-25.0.1.jdk/Contents/Home" ]; then
    JAVA_HOME="/Applications/proCertumSmartSign.app/Contents/PlugIns/jdk-25.0.1.jdk/Contents/Home"
else
    JAVA_HOME="${JAVA_HOME:-$(java -XshowSettings:properties -version 2>&1 | grep 'java.home' | awk '{print $3}')}"
fi
JAVA="$JAVA_HOME/bin/java"

# jsign JAR
JSIGN_JAR="${JSIGN_JAR:-/tmp/jsign.jar}"

# PKCS#11 config for SimplySign
PKCS11_CFG="/tmp/simplysign-pkcs11.cfg"
PKCS11_LIB="/usr/local/lib/libSimplySignPKCS.dylib"

# Certificate alias (serial number)
CERT_ALIAS="33F009BCF17FA6764B6A9BCD1664E63E"

# Certum timestamp server
TIMESTAMP_URL="http://time.certum.pl"

# Validate args
if [ $# -eq 0 ]; then
    echo "Usage: $0 <file.exe> [file2.exe ...]"
    echo ""
    echo "Prerequisites:"
    echo "  1. SimplySign Desktop running and logged in"
    echo "  2. jsign JAR at /tmp/jsign.jar"
    echo "  3. proCertumSmartSign installed (for bundled JDK)"
    exit 1
fi

# Check prerequisites
if [ ! -f "$JAVA" ]; then
    print_error "Java not found. Install proCertumSmartSign or set JAVA_HOME."
    exit 1
fi

if [ ! -f "$JSIGN_JAR" ]; then
    print_info "Downloading jsign..."
    curl -sL "https://github.com/ebourg/jsign/releases/download/7.4/jsign-7.4.jar" -o "$JSIGN_JAR"
fi

if [ ! -f "$PKCS11_LIB" ]; then
    print_error "SimplySign PKCS#11 module not found at $PKCS11_LIB"
    print_error "Install SimplySign Desktop: brew install --cask simplysign"
    exit 1
fi

# Create PKCS#11 config if needed
cat > "$PKCS11_CFG" << EOF
name = SimplySign
library = $PKCS11_LIB
EOF

SIGNED=0
FAILED=0

for EXE_FILE in "$@"; do
    if [ ! -f "$EXE_FILE" ]; then
        print_warning "File not found, skipping: $EXE_FILE"
        ((FAILED++)) || true
        continue
    fi

    BASENAME=$(basename "$EXE_FILE")
    print_info "Signing: $BASENAME"

    if "$JAVA" -jar "$JSIGN_JAR" \
        --storetype PKCS11 \
        --storepass "" \
        --keystore "$PKCS11_CFG" \
        --alias "$CERT_ALIAS" \
        --tsaurl "$TIMESTAMP_URL" \
        --alg SHA-256 \
        "$EXE_FILE" 2>&1; then
        print_success "Signed: $BASENAME"
        ((SIGNED++)) || true
    else
        print_error "Failed to sign: $BASENAME"
        ((FAILED++)) || true
    fi
done

echo ""
if [ $FAILED -eq 0 ]; then
    print_success "All $SIGNED file(s) signed successfully"
else
    print_warning "Signed: $SIGNED, Failed: $FAILED"
    exit 1
fi
