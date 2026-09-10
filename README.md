# agent-browser-runtime

## Native MCP MVP：使用入口与验证状态

连接现有 macOS Chrome 的版本请从 [中文快速上手](docs/native-quickstart.zh-CN.md) 开始，包含安装、MCP 客户端配置、首次配对、远程审批、验收和排错。详细机制见 [Native permissions MVP](docs/native-permissions-mvp.md)。这一路径使用 `install-macos-native.sh`，不是下方 Docker 模式的 `install.sh`。

目前已验证独立 Chromium 上的真实 MCP 调用、管理页批准后继续执行、站点限制和审计。2026-09-10 本机验收还确认了现有 Chrome 的官方扩展 token 自动连接，以及允许站点的导航、快照和截图。新环境仍需按教程验收。它是功能原型：同一用户下有 shell 权限的 agent 可以绕过本地代理，当前实现不提供这类隔离。

A hardened, self-hosted desktop runtime for Microsoft Playwright MCP. It runs session-isolated headed Chromium workers in Docker, exposes human takeover through loopback-only VNC/noVNC, and keeps client MCP on STDIO.

## Security properties

- Chromium sandbox enabled; no `--no-sandbox`
- non-root container process with all Linux capabilities dropped
- `no-new-privileges` and a reviewed Playwright seccomp profile
- read-only root filesystem and restricted `noexec` tmpfs mounts
- isolated browser context per session; no host home or Docker socket mount
- MCP over STDIO only; no port 8931 or CDP port 9222
- VNC and noVNC published on host loopback only
- private container-local Unix socket broker; no shared profile lock contention
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

Native mode now includes a site-permission and audit MVP. Open its local management page after installation:

```bash
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" open
```

The global allowlist starts empty. Add exact origins (for example `https://github.com`), or approve a pending request for one session (30 minutes) or globally. Changes apply to subsequent checks without restarting the browser. The management page can also save the official extension token once for automatic connections; you do not need to create or edit its file. First-time token copying from the official extension is still required for automatic reconnection. Without it, official interactive connection approval remains available. Never send the token to an agent.

For remote approval, forward port 7331 through SSH and run the operator-only `native-control-cli.cjs login` command on the browser host to obtain a one-time management login code. See [Native permissions MVP](docs/native-permissions-mvp.md) for the complete flow, compatibility constraints, and limits. Docker mode does not yet use this permission service.

Native extension mode has a wider trust boundary than the Docker runtime: the selected tab uses the user's real browser state. The native worker enforces its own small tool allowlist; use the updated client snippet too. Site approval permits actions within that site; consequential actions still require your agent's separate approval policy. The MVP is not a sandbox against an agent with unrestricted same-user shell or filesystem access.

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

For Claude Code and Claude Desktop, follow [docs/CLAUDE.md](docs/CLAUDE.md). It includes native Chrome and Docker setup, macOS configuration paths, verification, and a restrictive tool policy.

The recommended browser policy is in `browser-policy.md`. At minimum, keep these tools unavailable to the Agent:

```text
browser_evaluate
browser_run_code_unsafe
```

Multiple clients can connect concurrently. Each gets a separate isolated
Playwright MCP worker (and browser process). The persistent profile directory
from older installations is left intact but is no longer used by this mode.
Existing logins are not imported. Native Chrome extension mode is unchanged.

Optionally set `AGENT_BROWSER_SESSION_KEY` in the MCP process environment to
reuse a logical browser session. Without it, each connection gets a random key.
The key is an opaque identifier for trusted local clients, not authentication.
Do not set the same fixed key globally for unrelated Codex sessions.

Only one active connection is allowed per key; a duplicate gets a clear attach
error. After an idle disconnect, the worker and selected tab are retained for
five minutes. Reconnecting with the same key retains cookies and pages. If a
request was in flight, disconnect retires the worker instead: potentially
completed clicks are never replayed. Broker restart loses in-memory sessions.
`browser_close` affects only that session; later browser use starts fresh.
Artifacts are placed in a SHA-256-keyed subdirectory and are not auto-deleted.

The broker reads `AGENT_BROWSER_GRACE_MS` (default 300000) for retention and
`AGENT_BROWSER_SOCKET` (default `/tmp/agent-browser.sock`) for its internal
socket. These are container settings, not public HTTP endpoints.

For Pax, use the optional local `~/.paxd/mcp.json` launch template documented in
the paxd repository (`docs/local_session_mcp.md`), substituting
`${PAX_SESSION_KEY}` into `AGENT_BROWSER_SESSION_KEY`. E2EE identity is injected
on the node after decryption. No browser-specific manager logic is required.

Run `npm test` for broker and pool tests. To include real browser isolation
tests, set `AGENT_BROWSER_REAL_MCP_CLI` to an installed `@playwright/mcp/cli.js`
and optionally `AGENT_BROWSER_EXECUTABLE_PATH` to an installed Chromium binary.
The test creates separate contexts, verifies cookie/page isolation, reconnects,
and verifies closing one session leaves the other usable.

## Human takeover

Docker mode launches its own Chromium workers directly, so it needs neither Chrome extension pairing nor an extension token. It does not currently use the native site's allowlist or audit service. Its separate browser state does not include your personal Chrome logins; once you sign into a site there, actions use that account's permissions. The VNC password below authenticates human desktop access and is unrelated to extension pairing.

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

Functional validation should also initialize MCP, list tools, capture an accessibility snapshot and screenshot, verify the real noVNC WebSocket/RFB path, and confirm expired workers leave no Chromium processes.

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
