# Pax browser control MVP

This change spans four repositories: agent-browser-runtime, paxd, pax-manager,
and pax-console. Updating only this repository does not add the Pax page.

## Operator entry

In Pax, open Settings > Devices > Nodes, select the node, then open **Browser**.
The page exposes site approvals, persistent and temporary grants, pause/resume,
recent audit records, native Chrome control, and the Docker desktop.

The browser sends same-origin requests to:

```
POST /api/pax/api/v1/user/{user_id}/nodes/{node_id}/daemon/browser
```

Manager authenticates the user and checks node ownership before forwarding a
transient `browser.control` query. paxd accepts only named operations. It does
not accept a host, port, proxy path, shell command, or extension token from the
browser. Browser admin credentials remain on the node.

These queries use the existing node-control connection. In a multi-instance
Manager deployment, requests must reach the instance holding that connection,
just like existing node daemon queries. This MVP does not introduce a
cross-instance media broker.

## Install and rollout

1. Build and deploy the changed Manager and Console together using their normal
   repository deployment procedures.
2. Build the changed paxd with Go 1.26 and replace/restart the daemon using its
   normal update procedure. A daemon restart interrupts existing MCP processes;
   schedule this with the operator rather than silently restarting an active run.
3. On the native Chrome node, run `./install-macos-native.sh`. Existing pairing,
   policy and tokens are retained. Restart the browser control service and
   reconnect MCP workers to load the new code:

   ```sh
   node ~/.config/agent-browser-native/native-control-cli.cjs stop
   node ~/.config/agent-browser-native/native-control-cli.cjs start
   ```

4. Keep the Docker desktop installed/running via `./install.sh`. No new Docker
   image is required for the Pax VNC bridge. paxd connects to `127.0.0.1:5900`
   and reads `~/.local/share/agent-browser/secrets/vnc-password` locally.

The initial Pax adapter expects the standard native installation path
`~/.config/agent-browser-native/data-dir` and control port 7331. Custom Docker
credential paths and native control ports are not configurable from the web UI.
No loopback service needs to be published to the Internet.

## Native Chrome remote view

Start a browser action in the agent session, then refresh the Pax Browser panel.
Select the connected worker and choose **Take control**. Agent browser tools are
then blocked across the native control service. **Refresh image** captures a
JPEG directly into the operator response, without saving an artifact. Click the
image to click the page; use the key and scroll controls for interaction.

An input consumes its screenshot reference. A stale reference, changed page URL,
wrong session, or lost response is rejected without automatic retry. Refresh the
image before trying again. This is an explicitly refreshed screenshot interface,
not a continuous screencast, and cannot eliminate changes within the same page
between capture and click. Site approval applies to the top-level page origin (the address bar). Embedded
frames and normal API/resource requests are part of that approved page and do
not create separate approval prompts. A top-level redirect, popup or another tab
still needs its own site approval. Approving a page includes the embedded content
it displays; this is not an outbound network allowlist. The local management
origin remains unavailable to agent navigation, including embedded navigation.

**Release control** hands tools back to the agent. Closing the panel or losing
the worker leaves the hold in place, including across control-service restart.
Reconnect and explicitly release it. An already-dispatched browser action
cannot be recalled by takeover.

## Docker desktop

Choose **Connect Docker desktop**. noVNC renders the actual RFB desktop and
supports mouse and keyboard input. It displays all windows on the shared Docker
display, not a session-private desktop. Native Chrome site grants do not restrict
this isolated Docker profile. The VNC password does not reach the frontend.

The MVP transports bounded RFB chunks over transient node queries. It retains
no desktop frames in ACP history, database commands, or audit records. This adds
round trips compared with a direct noVNC WebSocket and is not a guarantee of the
same frame rate. The connection closes on sequence mismatch, buffer overflow,
30 seconds without exchanges, or after 30 minutes. Ambiguous input is never
replayed. Reconnect explicitly after failure.

## One-use passwords

This feature is implemented in the **native wrapper**, not the unrestricted
Docker MCP broker. Upstream Playwright's `--secrets`/`PLAYWRIGHT_MCP_SECRETS_FILE`
loads a static dictionary into the MCP process; its lifetime is too long for
one-use passwords. The wrapper instead exposes:

```json
{
  "name": "browser_fill_secret",
  "arguments": {
    "secret_ref": "opaque one-use reference",
    "origin": "https://example.com",
    "target": "e12"
  }
}
```

1. Select the browser session, exact allowed origin, and password field reference
   (or selector) in Pax.
2. Use the embedded secret sender. Pax encrypts it to a fresh paxd secret channel.
   Manager relays ciphertext; paxd drops it into its transient directory.
3. Pax registers that file with the browser controller. Only regular, private,
   same-user files directly inside `~/.paxd/secrets/transient` are accepted.
   The source is removed, and the controller owns a short-lived private copy.
4. Give the returned tool instruction to the agent. It contains no plaintext.
   The reference binds the worker session, exact origin and password target.
   The UI uses a 60-second TTL; the API maximum is 120 seconds, further limited
   by the original file's ten-minute expiry.
5. The controller consumes/deletes the copy before returning the value to the
   local worker. The worker validates the current page and password input, fills
   it directly, and produces no upstream snapshot or explicit submit action. The
   website may still react to input events. Failure
   does not make the reference reusable.
6. All native agent tools stay blocked until the operator confirms that the
   page no longer exposes sensitive content and chooses **Page is safe; resume
   agent**. Human remote viewing remains available under explicit takeover.

Expiry is swept every second while the control service runs. Restart deletes
orphaned copies and retains observation holds. When the service is stopped,
expired files cannot be consumed; physical deletion occurs at next startup.
JavaScript strings and browser protocol buffers cannot be reliably zeroized;
values become eligible for collection after the operation. The target website
necessarily receives plaintext. This is an audit and workflow boundary, not
isolation from an agent with unrestricted shell access under the same OS user.

Admin endpoints used by the node adapter:

- `POST /admin/secret`: `{fileRef, session, origin, target, ttlMs}` ->
  `{secret_ref, expires}`. Requires operator authentication.
- `POST /admin/resume-sensitive`: `{session}`.
- `POST /admin/view`: `{session, action}`; actions are takeover, release,
  screenshot, click, key, scroll, text.

Only `/runtime/consume-secret` returns a credential, to the local worker.
That route is not exposed by the Pax bridge or listed as an MCP tool.

## Verification

- `npm test`: policy, audit, secret expiry, replay, invalid file and binding tests.
- `AGENT_BROWSER_TEST_EXECUTABLE=/path/to/chrome npm run test:native-browser`:
  real MCP approvals/revocation plus operator screenshot/key/stale-frame checks;
  synthetic password verified by the local fixture, cleanup checked, and tool
  output, stderr, audit and snapshot artifacts checked for disclosure.
- paxd: `go test ./internal/browsercontrol ./internal/control ./internal/daemon`.
- Optional actual Docker handshake:
  `PAX_BROWSER_VNC_TEST=1 go test -v ./internal/browsercontrol`.
- Manager: full Go tests/build, node-ownership and forbidden-operation tests.
- Console: typecheck/build and transport tests. The actual noVNC canvas rendered
  the Docker fixture at 1920x1080, and a click was confirmed by the Docker page.
  A read-only reproduction lives in `pax-console/scripts/browser-control-smoke`. Network errors close the noVNC
  stream without replay; native input has no automatic retry.

No production Manager, Console, daemon or installed MCP worker is updated merely
by changing this source tree. The rollout above is required.

Native Chrome Watch browser is a read-only preview available without takeover.
Selecting a worker starts sequential refreshes with a two-second delay between
requests. Hidden pages suspend capture; closing the panel stops polling.
Preview failures retry after five seconds and preserve the last valid frame,
with the error and last-capture time shown beside the viewer. Browser inventory
refreshes automatically. Captures are serialized; input is never replayed.
Runtime heartbeats continue while capture waits for an agent operation, and
expired queued operations are discarded before execution.
A single connected worker is selected automatically; multiple workers require
selection unless a current operator already identifies the worker. It retains page approval checks and the global pause switch;
it neither changes operator ownership nor releases sensitive observation holds.
Preview pixels remain transient. Clicking or typing still requires explicit
takeover and a fresh interaction frame captured during takeover.
