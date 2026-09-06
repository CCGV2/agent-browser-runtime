#!/bin/sh
set -eu

umask 077
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${AGENT_BROWSER_NATIVE_CONFIG_DIR:-$CONFIG_HOME/agent-browser-native}"
DATA_DIR="${AGENT_BROWSER_NATIVE_DATA_DIR:-}"

if [ -z "$DATA_DIR" ]; then
  if [ ! -r "$CONFIG_DIR/data-dir" ]; then
    echo "Native browser data directory configuration is missing" >&2
    exit 1
  fi
  DATA_DIR="$(cat "$CONFIG_DIR/data-dir")"
fi

mkdir -p "$DATA_DIR/artifacts" "$DATA_DIR/secrets"

TOKEN_FILE="$DATA_DIR/secrets/extension-token"
if [ -s "$TOKEN_FILE" ]; then
  PLAYWRIGHT_MCP_EXTENSION_TOKEN="$(cat "$TOKEN_FILE")"
  export PLAYWRIGHT_MCP_EXTENSION_TOKEN
fi

exec node "$CONFIG_DIR/node_modules/@playwright/mcp/cli.js" \
  --extension \
  --output-dir "$DATA_DIR/artifacts" \
  --timeout-action 10000 \
  --timeout-navigation 90000
