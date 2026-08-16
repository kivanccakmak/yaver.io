#!/usr/bin/env bash
set -euo pipefail

# Prepare a dedicated SSH key for incident investigation.
# This script only creates a local key and prints the public key. It does not
# contact or modify the remote server.

SERVER_NAME="${1:-ubuntu-4gb-hel1-1}"
HCLOUD_CONTEXT="${HCLOUD_CONTEXT:-my-hertzner}"
KEY_PATH="${YAVER_INCIDENT_SSH_KEY:-$HOME/.ssh/yaver-incident}"
ENV_FILE="${YAVER_INCIDENT_ENV_FILE:-.env.incident}"

if [[ "$SERVER_NAME" == "-h" || "$SERVER_NAME" == "--help" ]]; then
  echo "Usage: $0 [hcloud-server-name]"
  echo "Creates a dedicated local key and writes metadata to $ENV_FILE."
  echo "The metadata file is gitignored; private key material is never copied into it."
  exit 0
fi

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "Error: ssh-keygen is required." >&2
  exit 1
fi

mkdir -p "$(dirname "$KEY_PATH")"
chmod 700 "$(dirname "$KEY_PATH")"

if [[ -e "$KEY_PATH" || -e "$KEY_PATH.pub" ]]; then
  echo "Key already exists: $KEY_PATH"
  echo "Refusing to overwrite it. Use YAVER_INCIDENT_SSH_KEY for another path." >&2
else
  umask 077
  ssh-keygen -t ed25519 -f "$KEY_PATH" -C "yaver-incident-$(date +%Y%m%d)" -N ""
  chmod 600 "$KEY_PATH"
  chmod 644 "$KEY_PATH.pub"
fi

SERVER_IP=""
if command -v hcloud >/dev/null 2>&1; then
  SERVER_IP="$(hcloud --context "$HCLOUD_CONTEXT" server ip "$SERVER_NAME" 2>/dev/null || true)"
fi

echo
echo "Public key (copy this into the Hetzner console):"
echo
cat "$KEY_PATH.pub"
echo
echo "Install it on the server as root in: /root/.ssh/authorized_keys"
if [[ -n "$SERVER_IP" ]]; then
  echo "Server: $SERVER_NAME ($SERVER_IP)"
  echo "Test after installation:"
  echo "  ssh -i '$KEY_PATH' root@$SERVER_IP 'hostname; date -Is; uptime'"
else
  echo "Server IP could not be resolved by HCloud CLI."
  echo "Set HCLOUD_CONTEXT or pass the server IP manually when testing."
fi

umask 077
{
  echo "# Local-only incident access metadata; do not commit."
  echo "YAVER_INCIDENT_SERVER_NAME=$SERVER_NAME"
  echo "YAVER_INCIDENT_SERVER_IP=$SERVER_IP"
  echo "YAVER_INCIDENT_SERVER_USER=root"
  echo "YAVER_INCIDENT_HCLOUD_CONTEXT=$HCLOUD_CONTEXT"
  echo "YAVER_INCIDENT_SSH_KEY_PATH=$KEY_PATH"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Connection metadata saved to: $ENV_FILE (mode 600, gitignored)"
echo
echo "Private key remains at: $KEY_PATH"
