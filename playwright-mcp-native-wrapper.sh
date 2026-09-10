#!/bin/sh
set -eu

umask 077
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONFIG_DIR="${AGENT_BROWSER_NATIVE_CONFIG_DIR:-}"
if [ -z "$CONFIG_DIR" ]; then
  if [ -r "$SCRIPT_DIR/data-dir" ]; then
    CONFIG_DIR="$SCRIPT_DIR"
  else
    CONFIG_DIR="$CONFIG_HOME/agent-browser-native"
  fi
fi
DATA_DIR="${AGENT_BROWSER_NATIVE_DATA_DIR:-}"

if [ -z "$DATA_DIR" ]; then
  if [ ! -r "$CONFIG_DIR/data-dir" ]; then
    echo "Native browser data directory configuration is missing" >&2
    exit 1
  fi
  DATA_DIR="$(cat "$CONFIG_DIR/data-dir")"
fi

export AGENT_BROWSER_NATIVE_DATA_DIR="$DATA_DIR"
exec node "$CONFIG_DIR/native-worker.cjs"
