#!/bin/bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

bash -n \
  "$ROOT/install.sh" \
  "$ROOT/install-macos-native.sh" \
  "$ROOT/verify-runtime.sh" \
  "$ROOT/verify-source.sh"
sh -n \
  "$ROOT/desktop-entrypoint.sh" \
  "$ROOT/mcp-stdio.sh" \
  "$ROOT/playwright-mcp-wrapper.sh" \
  "$ROOT/playwright-mcp-native-wrapper.sh"

test_uid="$(id -u)"
test_gid="$(id -g)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p \
  "$test_root/config" \
  "$test_root/data/profile" \
  "$test_root/data/artifacts" \
  "$test_root/data/logs" \
  "$test_root/data/secrets"
: >"$test_root/data/secrets/vnc-password"
: >"$test_root/config/seccomp_profile.json"

AGENT_BROWSER_UID="$test_uid" \
AGENT_BROWSER_GID="$test_gid" \
AGENT_BROWSER_CONFIG_DIR="$test_root/config" \
AGENT_BROWSER_DATA_DIR="$test_root/data" \
docker compose --project-directory "$ROOT" -f "$ROOT/compose.yaml" config >/dev/null

if grep -R -n -E -- \
  '--no-sandbox|privileged:[[:space:]]*true|SYS_ADMIN|/var/run/docker.sock|0\.0\.0\.0:5900:5900|0\.0\.0\.0:6080:6080' \
  "$ROOT/Dockerfile" "$ROOT/compose.yaml" "$ROOT/install.sh" "$ROOT/install-macos-native.sh" \
  "$ROOT/desktop-entrypoint.sh" "$ROOT/mcp-stdio.sh" "$ROOT/playwright-mcp-wrapper.sh" \
  "$ROOT/playwright-mcp-native-wrapper.sh" "$ROOT/verify-runtime.sh"; then
  echo "Unsafe runtime configuration detected" >&2
  exit 1
fi

echo "Source checks passed"
