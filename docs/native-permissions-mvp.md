# Native browser permissions MVP

This MVP keeps the official Playwright Chrome extension and the repository's pinned MCP dependency. It adds a shared local permissions service, a management page, a guarded MCP worker, and audit records. It does not require a custom Chrome extension or modify files inside node_modules.

## Install and pair once

From the repository on macOS:

```bash
./install-macos-native.sh
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" open
```

For a custom install directory, use the command printed by the installer. The CLI reads the adjacent `data-dir` file. The management service starts automatically on loopback port 7331. The open command launches the browser with a one-use login code, consumed and removed from the URL by the page; it does not print a permanent credential.

Install the official Playwright extension. In its UI copy `PLAYWRIGHT_MCP_EXTENSION_TOKEN`, then paste it once into **首次配对** in the management page. The server stores it privately and does not return it to the UI or runtime policy API. A newly started MCP worker reads it for automatic connections. Existing workers need to reconnect after token replacement. This MVP does **not** extract tokens from Chrome or implement automatic native-messaging pairing. Without a saved token, the official extension's interactive connection prompt still applies.

Update the client launch command to the installed `playwright-mcp-native-wrapper.sh` and restart the MCP client. Use the updated `codex-native-config-snippet.toml` with a 240-second tool timeout. The worker itself enforces the tool list for any MCP client; client configuration is not the only enforcement point. Existing installations must rerun the installer to get the new worker.

The installer does not open a personal browser, generate login codes in agent output, or overwrite agent client configuration automatically.

## Remote approval

On your remote computer, establish a private tunnel to the browser host:

```bash
ssh -N -L 7331:127.0.0.1:7331 USER@BROWSER_HOST
```

In an operator-controlled terminal on the browser host:

```bash
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" login
```

Open `http://127.0.0.1:7331` on your remote computer and enter the printed code. It expires in ten minutes and works once. The browser management login lasts eight hours and is stored in that tab's sessionStorage. Logout invalidates it server-side. Do not paste this code into an agent conversation: it grants management access.

When an MCP request needs a new site, **等待你的授权** shows the origin, tool, and worker session. Choose a 30-minute session grant, a persistent global grant, or deny. A request that has not started executing waits up to 90 seconds and proceeds once approved. After timeout or cancellation, approval does not replay the old request; the client must issue a fresh call. Pending entries expire in five minutes.

If an already executing click triggers a blocked navigation, the worker reports an uncertain/blocked result and does **not** replay the click after approval. Inspect the current page before continuing. The control UI is a separate admin channel; browser tools cannot approve themselves through it.

## Rules and revocation

- Rules are exact origins: scheme, hostname and effective port. `https://example.com` does not grant its subdomains or `http://example.com`. Paths, wildcard rules, URL credentials, queries and fragments are rejected.
- Empty global rules plus no explicit temporary grant means no sites are permitted. Blank bootstrap pages are permitted to create an initial tab. Management origins are always rejected.
- A user can explicitly grant one worker temporary access to an origin that is not globally allowed. Page content and agent messages never expand permissions automatically.
- Global rules are shared by native workers using the same data directory. Temporary grants bind to a random worker ID, not a model-supplied identity; worker restarts create a new ID.
- Removing a global site or editing global policy also clears temporary grants. Temporary grants can be revoked individually. Pause blocks subsequent operations. Policy checks fetch live state; no browser restart is required for these changes.
- Global edits include a revision check so a stale management tab cannot silently restore a rule another operator removed.
- For conservative iframe handling, every nonblank frame must have an allowed origin before the whole page can be read or operated. This may require granting embedded authentication origins, and unsupported opaque frame origins stop the operation. There is no iframe masking mode in this MVP.
- The guarded tools are navigate, snapshot, find, click, fill/type/key/select/hover, file upload, tabs, wait, screenshot and close. Arbitrary JavaScript, filesystem output arguments, console/network export, downloads and history navigation are not exposed. Incidental browser downloads are cancelled when observed.

## File uploads

`browser_file_upload` accepts `{paths: ["/absolute/path/to/file"]}` after the
agent clicks a page's upload control and a file chooser is pending. Multiple
paths are supported when the input accepts multiple files. Omitting `paths`
cancels the chooser; an empty list clears the selection.

Upload only the files the user has requested for the intended site. Site
approval is not approval to choose arbitrary local files. The runtime validates
absolute paths, resolves symbolic links, rejects missing files and directories,
and retains the pinned upstream workspace/output-root restrictions. It does not
enable unrestricted file access. Files must exist on the browser worker's host;
a remote client's local path is not automatically transferred to that host.
Stage user-provided attachments in the worker workspace when necessary.

Policy is checked again immediately before the chooser receives files. Pause,
revocation and human takeover still block uploading. Uploads may send bytes as
soon as files are selected, before a separate form submission. Never replay an
uncertain upload automatically; inspect the page first. This is ordinary file
access governed by user instructions, not an operator-issued per-file grant or
a sandbox against another process changing a file during an operation.

Reinstall the native runtime and reconnect MCP after updating; clients with an
`enabled_tools` allowlist must include `browser_file_upload`.

## Audit

Records are appended and fsynced by one service to:

```text
~/.local/share/agent-browser-native/control/audit.jsonl
```

The management page shows the last 200 records. Records include timestamps, worker session IDs, request IDs, tool names, origins, permission decisions, outcomes and duration. Upload preparation and completion also include file count and total bytes, without file contents or complete local paths. Policy changes, grants, revocations, management login and pairing are also recorded. Input bodies, page titles/content, screenshot bytes, URL paths/query strings and credentials are not included in the audit schema.

The worker requires a successful start audit before executing. If completion logging fails, it returns an uncertain-completion error instead of reporting success. A missing completion record may mean crash/disconnection; do not infer the action did not execute. Logs are local append-only-by-convention files, not cryptographically tamper-proof storage. Retention/rotation and external archival are not implemented; monitor disk use.

Playwright's authorized page snapshot/screenshot artifacts remain separate from audit records and may contain page data. They live under `artifacts/<worker-id>/`. The console-history links and historical snapshot events are suppressed by this adapter.

## Implementation and limits

`native-control.cjs` owns policy, approvals and audit. Runtime and admin APIs use different locally stored credentials. Browser admin requests are protected by exact loopback Host/Origin checks, no CORS, a restrictive CSP, and bearer authentication. The service listens only on 127.0.0.1; remote use is through SSH forwarding with the same local port, not a public HTTP deployment.

`native-playwright-hook.cjs` verifies the SHA-256 of Playwright Core's exact locked bundle before compiling a few method adapters in memory. It gates backend calls, target resolution, each supported locator/keyboard action, snapshots and tab headers; checks permissions again before returning results; and installs navigation request interception. Unknown bundles or changed hook signatures refuse startup. Upgrading Playwright requires reviewing and testing this adapter, not just changing its hash.

The adapter protects the supported MCP surface, not unrestricted local code execution. An agent with same-user shell access can read credentials, edit files, launch the upstream CLI directly, or control the browser another way. For that threat model, put the service, credentials and browser worker behind an OS account/container boundary and expose only the restricted tools. The MVP does not establish that isolation itself.

It is a site-operation policy, not a network firewall. Ordinary page resources are not domain-filtered. Redirect traffic, pre-existing service workers, background page activity and already-dispatched actions cannot be promised to stop before any network effect. Navigation observation plus output checks prevent the tested restricted content from being returned through tools; this is not a proof against all browser races. Revocation cannot undo an operation already sent to Chrome.

Native extension connection compatibility uses the locked official MCP runtime. Automated browser tests launch an isolated local Chromium profile and exercise the real MCP adapter and management UI; they do not prove the installed Chrome extension's personal-profile pairing/reconnection flow. Complete that one-time interactive acceptance locally before unattended use. Docker mode retains its existing runtime and does not yet share these permission rules.

## Verification and lifecycle

```bash
npm ci --ignore-scripts
npm test

# Optional real Chromium + management UI integration test, using a fresh profile:
AGENT_BROWSER_TEST_EXECUTABLE=/absolute/path/to/chrome npm run test:native-browser

# Operator lifecycle commands after installation:
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" start
node "$HOME/.config/agent-browser-native/native-control-cli.cjs" stop
```

The integration test covers management-page approval resuming a pending MCP call, tool filtering, allowed clicks, blocked link navigation, cross-origin iframe and redirect responses, revocation, management-origin denial, audit metadata and restricted snapshot artifact suppression. It uses local synthetic pages, not your personal browser profile or login state.

The service stays available after MCP disconnects so pending requests and logs can be inspected. Stopping it makes worker checks fail closed; the next worker/CLI start can start it again. Persistent policy and audit survive restart; temporary grants, pending requests and management login sessions do not.
