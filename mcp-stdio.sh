#!/bin/sh
set -eu

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${AGENT_BROWSER_CONFIG_DIR:-$CONFIG_HOME/agent-browser}"

exec docker compose --project-directory "$CONFIG_DIR" \
  -f "$CONFIG_DIR/compose.yaml" \
  exec -T -e AGENT_BROWSER_SESSION_KEY="${AGENT_BROWSER_SESSION_KEY:-}" \
  desktop /usr/local/bin/playwright-mcp-wrapper.sh
