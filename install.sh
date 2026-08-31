#!/bin/bash
set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_DIR="${AGENT_BROWSER_CONFIG_DIR:-$CONFIG_HOME/agent-browser}"
DATA_DIR="${AGENT_BROWSER_DATA_DIR:-$DATA_HOME/agent-browser}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SECCOMP_URL="https://raw.githubusercontent.com/microsoft/playwright/v1.62.0/utils/docker/seccomp_profile.json"
SECCOMP_SHA256="cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849"

if [[ "$(id -u)" == "0" ]]; then
  echo "Run this installer as the non-root service owner, not root." >&2
  exit 1
fi

command -v docker >/dev/null
command -v curl >/dev/null
command -v openssl >/dev/null
command -v python3 >/dev/null
command -v sha256sum >/dev/null
docker compose version >/dev/null

install -d -m 0700 "$CONFIG_DIR"
install -d -m 0700 \
  "$DATA_DIR/profile" \
  "$DATA_DIR/artifacts" \
  "$DATA_DIR/logs" \
  "$DATA_DIR/secrets"

for file in Dockerfile package.json package-lock.json compose.yaml; do
  install -m 0600 "$SOURCE_DIR/$file" "$CONFIG_DIR/$file"
done
for file in desktop-entrypoint.sh playwright-mcp-wrapper.sh mcp-stdio.sh verify-runtime.sh; do
  install -m 0700 "$SOURCE_DIR/$file" "$CONFIG_DIR/$file"
done

tmp_seccomp="$(mktemp "$CONFIG_DIR/.seccomp.XXXXXX")"
trap 'rm -f -- "$tmp_seccomp"' EXIT
curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  --output "$tmp_seccomp" "$SECCOMP_URL"
actual_seccomp_sha256="$(sha256sum "$tmp_seccomp")"
actual_seccomp_sha256="${actual_seccomp_sha256%% *}"
if [[ "$actual_seccomp_sha256" != "$SECCOMP_SHA256" ]]; then
  echo "Downloaded Playwright seccomp profile failed SHA-256 verification" >&2
  exit 1
fi
python3 - "$tmp_seccomp" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as stream:
    profile = json.load(stream)

for rule in profile.get("syscalls", []):
    if rule.get("comment") == "Allow create user namespaces":
        names = rule.get("names")
        if not isinstance(names, list):
            raise SystemExit("Playwright user namespace seccomp rule has invalid names")
        if "chroot" not in names:
            names.append("chroot")
        rule["comment"] = "Allow create user namespaces and chroot inside them"
        break
else:
    raise SystemExit("Playwright user namespace seccomp rule not found")

with open(path, "w", encoding="utf-8") as stream:
    json.dump(profile, stream, indent="\t")
    stream.write("\n")
PY
python3 -m json.tool "$tmp_seccomp" >/dev/null
install -m 0600 "$tmp_seccomp" "$CONFIG_DIR/seccomp_profile.json"
rm -f -- "$tmp_seccomp"
trap - EXIT

if [[ ! -s "$DATA_DIR/secrets/vnc-password" ]]; then
  openssl rand -base64 -out "$DATA_DIR/secrets/vnc-password" 6
fi
chmod 0600 "$DATA_DIR/secrets/vnc-password"

{
  printf 'AGENT_BROWSER_UID=%s\n' "$(id -u)"
  printf 'AGENT_BROWSER_GID=%s\n' "$(id -g)"
  printf 'AGENT_BROWSER_CONFIG_DIR=%s\n' "$CONFIG_DIR"
  printf 'AGENT_BROWSER_DATA_DIR=%s\n' "$DATA_DIR"
} >"$CONFIG_DIR/.env"
chmod 0600 "$CONFIG_DIR/.env"

docker compose --project-directory "$CONFIG_DIR" -f "$CONFIG_DIR/compose.yaml" build
docker compose --project-directory "$CONFIG_DIR" -f "$CONFIG_DIR/compose.yaml" up -d

printf 'Desktop stack started. MCP command: %s/mcp-stdio.sh\n' "$CONFIG_DIR"
echo "Merge the client configuration separately after backing up the existing configuration."
