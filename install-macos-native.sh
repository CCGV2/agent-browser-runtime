#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS. Use install.sh for the Docker runtime." >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]]; then
  echo "Run this installer as the intended user, not root." >&2
  exit 1
fi

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_DIR="${AGENT_BROWSER_NATIVE_CONFIG_DIR:-$CONFIG_HOME/agent-browser-native}"
DATA_DIR="${AGENT_BROWSER_NATIVE_DATA_DIR:-$DATA_HOME/agent-browser-native}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 18 )); then
  echo "Node.js 18 or newer is required" >&2
  exit 1
fi

if [[ ! -d "/Applications/Google Chrome.app" && ! -d "$HOME/Applications/Google Chrome.app" ]]; then
  echo "Google Chrome was not found. Install Chrome before using extension mode." >&2
  exit 1
fi

install -d -m 0700 "$CONFIG_DIR" "$DATA_DIR/artifacts" "$DATA_DIR/secrets"
install -m 0600 "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$CONFIG_DIR/"
install -m 0700 "$SOURCE_DIR/playwright-mcp-native-wrapper.sh" "$CONFIG_DIR/"
printf '%s\n' "$DATA_DIR" >"$CONFIG_DIR/data-dir"
chmod 0600 "$CONFIG_DIR/data-dir"

npm ci --omit=dev --prefix "$CONFIG_DIR"

printf 'Native Chrome MCP command: %s/playwright-mcp-native-wrapper.sh\n' "$CONFIG_DIR"
printf 'Artifacts directory: %s/artifacts\n' "$DATA_DIR"
echo "Install the official Playwright Extension in your regular Chrome profile, then add the command to Codex and restart it."
echo "Connection approval remains interactive unless a protected extension-token file is configured."
