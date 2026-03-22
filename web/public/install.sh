#!/bin/sh
# Yaver CLI installer — https://yaver.io
# Usage: curl -fsSL https://yaver.io/install.sh | sh
set -e

REPO="kivanccakmak/yaver.io"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="yaver-${OS}-${ARCH}"
echo "Installing yaver for ${OS}/${ARCH}..."

# Get latest release tag
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
if [ -z "$LATEST" ]; then
  echo "Error: could not determine latest version"
  exit 1
fi
echo "Latest version: ${LATEST}"

URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
echo "Downloading ${URL}..."

TMP=$(mktemp)
curl -fsSL "$URL" -o "$TMP"
chmod +x "$TMP"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/yaver"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMP" "${INSTALL_DIR}/yaver"
fi

echo ""
echo "yaver installed to ${INSTALL_DIR}/yaver"
echo ""
"${INSTALL_DIR}/yaver" version
echo ""
echo "Get started:"
echo "  yaver auth    Sign in & start the agent"
