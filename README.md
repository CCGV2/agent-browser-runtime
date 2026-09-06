# agent-browser-runtime

A hardened, self-hosted desktop runtime for Microsoft Playwright MCP. It runs a headed Chromium browser in Docker with a persistent profile, exposes human takeover through loopback-only VNC/noVNC, and keeps MCP on STDIO.

## Security properties

- Chromium sandbox enabled; no `--no-sandbox`
- non-root container process with all Linux capabilities dropped
- `no-new-privileges` and a reviewed Playwright seccomp profile
- read-only root filesystem and restricted `noexec` tmpfs mounts
- dedicated persistent browser profile; no host home or Docker socket mount
- MCP over STDIO only; no port 8931 or CDP port 9222
- VNC and noVNC published on host loopback only
- single-process lock for the persistent Chromium profile
- example client policy excluding `browser_evaluate` and `browser_run_code_unsafe`

This repository hardens the runtime, but Playwright MCP is not itself a security boundary. The MCP client must enforce an explicit tool allowlist and treat web content as untrusted input.

## Pinned runtime

- `@playwright/mcp`: `0.0.79`
- bundled Playwright Core: `1.63.0-alpha-2026-08-05`
- Chromium revision: `1237`
- tested Chrome for Testing: `152.0.7977.8`
- Node base image: `22.22.2-bookworm-slim`

## Requirements

- Linux with Docker Engine, or macOS with Docker Desktop using Linux containers
- current user allowed to use Docker
- Bash, curl, OpenSSL, Python 3, and either `sha256sum` or `shasum`
- on Linux, unprivileged user namespaces available to Chromium

### macOS

Install and start Docker Desktop, leave it in the default Linux-container mode, then run the same installer from Terminal:

```bash
./install.sh
```

Chromium still runs inside the hardened Linux container. Docker Desktop publishes noVNC only on macOS loopback, so a local operator can open `http://127.0.0.1:6080/vnc.html` directly; no SSH tunnel is needed.

The default profile and artifact directories live below `~/.local/share/agent-browser`, which Docker Desktop normally shares because it is below the macOS home directory. If Docker Desktop reports a bind-mount sharing error, add the selected `AGENT_BROWSER_DATA_DIR` under **Settings → Resources → File sharing**.

### macOS native Chrome extension mode

This mode requires Node.js 18 or newer, npm, Google Chrome, and no Docker. To connect to tabs in the user's regular Chrome profile, install the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm), then run:

```bash
./install-macos-native.sh
```

Merge `codex-native-config-snippet.toml` into Codex configuration, replace `YOUR_USER`, and restart Codex. On the first browser action, Chrome asks the user to approve the connection and select a tab. This mode reuses that tab's cookies and authenticated session; it does not expose every tab without user selection.

By default, the native installation uses:

```text
configuration: $HOME/.config/agent-browser-native
artifacts:     $HOME/.local/share/agent-browser-native/artifacts
token file:    $HOME/.local/share/agent-browser-native/secrets/extension-token
```

Interactive approval is the default and recommended behavior. To allow automatic reconnection, copy the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` shown by the extension into the token file and set its permissions to `0600`. Never commit, log, or send that token to an agent.

Native extension mode has a wider trust boundary than the Docker runtime: the selected tab uses the user's real browser state. Keep the same Codex tool allowlist, treat page content as untrusted, and require explicit user approval before consequential actions.

## Install

Run as the intended non-root service owner:

```bash
git clone <repository-url> agent-browser-runtime
cd agent-browser-runtime
./install.sh
```

Defaults follow the current user's XDG directories:

```text
configuration: ${XDG_CONFIG_HOME:-$HOME/.config}/agent-browser
data:          ${XDG_DATA_HOME:-$HOME/.local/share}/agent-browser
```

Override them when required:

```bash
AGENT_BROWSER_CONFIG_DIR=/srv/example/config \
AGENT_BROWSER_DATA_DIR=/srv/example/data \
./install.sh
```

The installer generates a VNC password if one does not already exist. It never prints the password and does not modify Agent configuration.

## Connect an MCP client

Use the absolute path printed by the installer as a local STDIO MCP command. For Codex, copy `codex-config-snippet.toml`, replace `YOUR_USER`, and merge it into the existing configuration instead of overwriting the file.

The recommended browser policy is in `browser-policy.md`. At minimum, keep these tools unavailable to the Agent:

```text
browser_evaluate
browser_run_code_unsafe
```

Only one MCP client may use the persistent profile at a time.

## Human takeover

For a remote Linux host, create an SSH tunnel from the operator's computer:

```bash
ssh -N -L 6080:127.0.0.1:6080 USER@SERVER
```

Then open `http://127.0.0.1:6080/vnc.html`. Retrieve the VNC password directly on the server from the protected data directory; never put it in source control, logs, or an Agent conversation.

For a runtime installed locally on macOS, open the same URL without the SSH tunnel.

The installer prints the password file path but never its contents. At the default locations, the password file is:

```text
Linux:  ${XDG_DATA_HOME:-$HOME/.local/share}/agent-browser/secrets/vnc-password
macOS:  $HOME/.local/share/agent-browser/secrets/vnc-password
```

If `AGENT_BROWSER_DATA_DIR` was set during installation, use `$AGENT_BROWSER_DATA_DIR/secrets/vnc-password` instead. An operator may read this protected file for manual takeover; agents should not read or disclose its contents.

## Verify

Static source checks:

```bash
./verify-source.sh
```

Deployed runtime checks:

```bash
"${XDG_CONFIG_HOME:-$HOME/.config}/agent-browser/verify-runtime.sh"
```

Functional validation should also initialize MCP, list tools, open `https://example.com`, capture an accessibility snapshot and screenshot, verify the real noVNC WebSocket/RFB path, and confirm cleanup leaves no Chromium process or active profile lock.

## Known limitations

- The Node base image is pinned by tag but not yet by digest. Record and pin a reviewed digest for high-assurance production builds.
- The seccomp profile is based on Playwright `v1.62.0` and is checksum-pinned, then minimally patched to allow `chroot` inside Chromium's unprivileged user namespace. Re-audit it when upgrading Playwright or Chromium.
- VNC/noVNC is intentionally plain HTTP inside a loopback-only SSH tunnel. Do not expose ports 5900 or 6080 publicly.
- Browser profile data is sensitive. Back it up and protect it like credentials.
- Credential-manager integration and an authenticated product-facing VNC WebSocket gateway are future features, not part of this release.

## License

Apache License 2.0. This repository publishes source and build instructions; no public prebuilt container image is provided.

## Release status

`0.1.0` is the first source release candidate. It captures the deployed Chromium/Crashpad and sandbox fixes and has been validated on Ubuntu Server. macOS support uses Docker Desktop's Linux VM and the same source and runtime verification scripts.
