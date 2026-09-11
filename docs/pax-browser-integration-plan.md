> Implementation status: see [Pax browser control MVP](pax-browser-mvp.md) for the implemented interfaces, verification and rollout. This file preserves the broader design; continuous screencast, a dedicated media WebSocket and Docker MCP password filling are not part of this MVP.

# Browser management and viewing in Pax

Status: proposed tasks; no remote endpoints or viewer have been implemented.
Date: 2026-09-10

## User outcome

A user signed into Pax can manage browser permissions and watch the browser on a remote node without an SSH tunnel, copying local management login codes, or opening public ports on the node. Browser execution stays on that node.

Two tasks share a browser session/access layer:

1. Integrate native browser permissions and audit into Pax.
2. Add remote viewing for Docker desktops and the selected personal Chrome tab.

The user has selected Docker noVNC plus an interactive personal-Chrome tab viewer. Personal Chrome should support screenshot/screencast display, pointer input, keyboard input and scrolling. Its first version does not need VNC-equivalent smoothness. Both modes need an explicit human takeover state that excludes concurrent agent browser operations. These are implementation tasks, not shipped capabilities.

## Current implementation evidence

- Native management listens at `127.0.0.1:7331`. Its HTTP service validates loopback Host/Origin, prohibits embedding, and separates runtime credentials from administrator credentials.
- Docker exports noVNC at `127.0.0.1:6080` and VNC at `127.0.0.1:5900`. VNC has a separate password.
- Personal Chrome screenshots through the saved extension token were verified locally. Continuous streaming through that extension was not tested.
- Pax Console uses its same-origin `/api/pax` REST proxy. Manager resolves users/nodes, and paxd has a node-control WebSocket adapter.
- Pax's encrypted agent transport persists commands/events for delivery and replay. Video frames must not be treated as durable chat messages or replayed commands.
- No general-purpose authenticated browser HTTP/WebSocket forwarding implementation was identified in the inspected paths. Existing node control is not a transparent TCP tunnel.
- The local running Docker container predates the repository's session broker. Deployment must build the intended source version; testing a temporary broker in the container did not upgrade that deployed entry point.

## Task 1: permissions in Pax

### User interface

Add a Browser entry to the node page, with a shortcut from a conversation when its browser worker can be identified. Show connection state, exact-origin rules, pending approvals, temporary grants, pause and recent audit events. Offline and disconnected states must be explicit.

Use Pax identity for the remote management workflow. Do not forward the local management HTML as an iframe or expose its administrator token to frontend code. Keep the existing local management page available as a local fallback.

### Data flow and boundaries

`Pax Console -> authenticated Manager routing -> paxd browser adapter -> local permission service`

- Manager must authorize the caller against the target node for every operation and bind requests to that identity; a client-supplied node ID is not authorization.
- paxd maps typed browser-management requests to a fixed set of local operations. It does not accept arbitrary destination URLs, ports, file paths or HTTP headers from the caller.
- The local administrator credential stays on the node. The adapter must not expose token retrieval, login-code generation, or arbitrary control-service endpoints to an agent session.
- Preserve policy revisions, expiration, cancellation and no-replay behavior. Audit remote decisions with an authenticated operator attribution, distinct from worker identity.
- Define whether remote management payloads require application-level E2EE. Do not silently describe Manager-visible traffic as end-to-end encrypted. Any reuse of node-control delivery must preserve the chosen trust model.
- Native worker IDs currently are random local IDs. Add an authenticated association to Pax sessions before providing conversation-scoped links; do not infer ownership from an agent-supplied worker ID.

### Acceptance

From a different device, approve a pending request in Pax and observe exactly one resumed operation. Revoke it and observe later operations fail. Cross-user/node requests fail. Neither extension nor local admin credentials appear in frontend traffic, logs or conversation output.

## Task 2A: Docker remote desktop

Embed a noVNC client owned by Pax Console and connect it to a dedicated authorized live channel. The node-side bridge connects only to its configured local VNC service; it handles the VNC credential locally. Register a fixed browser-view capability instead of exposing arbitrary localhost forwarding.

Use an outbound node connection so users do not configure router port forwarding. Establish viewer sessions with expiration, node ownership checks and explicit close/revocation. Keep frame traffic separate from durable agent messaging, apply backpressure, and drop obsolete frames instead of retaining a backlog. If frames are E2EE, Manager only relays ciphertext and receives no desktop password.

The current Xvfb desktop is shared by visible browser windows. It must be presented as a node desktop restricted to the node owner, not advertised as a session-isolated view. A future conversation-private desktop requires separate displays or a tab-only viewer.

Show distinct states for no running browser, disconnected viewer, VNC authentication failure and waiting for frames. A black canvas must not be the only indication that no browser window is open. Label viewing versus interactive takeover, and prevent agent/human input conflicts when takeover is enabled.

Acceptance: remotely see an actual visible browser, observe navigation, reconnect after a transient disconnect, and exercise pointer/keyboard input if takeover is in scope. HTTP 200 and an RFB greeting alone do not satisfy visual acceptance. Access revocation closes the live channel. Test phone resizing and slow connections.

## Task 2B: personal Chrome preview

Reuse the existing worker's official extension connection and capture the selected controlled tab. Do not launch a second unrestricted browser connection merely for viewing, and do not require sharing the entire macOS desktop.

Start with periodic screenshots as a compatibility prototype. Evaluate CDP `Page.startScreencast` for smoother updates only after verifying support through the pinned extension relay. Screencast carries frames only: implement a separate pointer/keyboard/scroll input path. Bind input to a frame generation and viewport dimensions; reject stale clicks after navigation, tab switches or resize. Acquire exclusive human ownership before input and block new agent operations until the user hands control back. Do not replay uncertain inputs after disconnect. These are page-content views: Chrome's address bar, extension popup, native file picker and OS dialogs are not included. Do not promise this viewer can complete the initial extension installation or pairing UI.

Frames use the separate authorized live transport from Task 2A. They are not chat attachments or audit records. Capture only while a viewer is present, recheck tab/frame permissions around capture, clear stale frames on revocation/navigation, and stop on worker disconnect. Distinguish human viewing permissions from agent operation permissions explicitly; the proposed MVP limits previews to authorized controlled content.

Acceptance: a remote Pax user sees changes in a permitted tab; an unapproved origin, cross-origin iframe or revoked grant yields no new restricted frame. Switching tabs cannot expose unrelated personal tabs. Verify no unbounded frame queue and no persistent screenshots beyond the documented artifact policy.

## Implementation order

1. Define authenticated node/browser identities and the remote access protocol; test cross-user denial and credential handling.
2. Implement permissions operations in paxd/Manager and the Pax Console Browser panel.
3. Implement the separate live viewer channel and Docker noVNC adapter, including remote visual acceptance.
4. Prototype personal Chrome screenshot delivery, then decide whether screencast quality warrants additional work.
5. Complete personal Chrome takeover with agent pause/resume, input ownership and explicit dialog limitations.

## Password entry without disclosure to the model

The user also requested entering a password from a local file without exposing its plaintext to the model. This is a data-flow requirement, not a promise that the local program or destination website never sees plaintext.

Reuse Pax's existing Secret Channel for remote delivery: the user encrypts in the frontend, Manager relays ciphertext, and paxd decrypts into a short-lived local file. Do not pass plaintext through MCP arguments, chat messages, command output or mutation caches.

Correction after inspecting the pinned upstream source: Playwright MCP already supports `--secrets <dotenv-file>` / `PLAYWRIGHT_MCP_SECRETS_FILE`. `browser_type.text` and `browser_fill_form.fields[].value` resolve an exact configured secret name on the server. Text responses use secret substitution/redaction. A new filling tool is therefore not required for the basic model-blind flow. A local synthetic-password test verified both tools filled the actual value while neither captured tool output nor generated text artifacts contained the plaintext. This does not establish screenshot or arbitrary website-reflection safety.

Prefer adapting Pax's raw, short-lived secret delivery into a private dotenv entry and configuring the MCP worker, then reuse its existing input tools with a name such as `LOGIN_PASSWORD`. Upstream loads this configuration at initialization; safe refresh for an already connected worker still needs an integration design. `browser_file_upload` is unrelated: it uploads a file through a file chooser rather than filling a textbox from its contents. Additional interfaces should provision/revoke scoped references or implement operator-only entry where needed, rather than duplicate existing text-entry mechanics. Domain/field binding, expiry and artifact controls below remain additional policy requirements.

Implementation requirements:

- Resolve only registered secret references bound to the authenticated operator and node. Do not accept arbitrary client-supplied filesystem paths. Bind the consumption authorization to the exact origin, browser session and selected password field.
- Read the file inside the trusted browser-side service without shell interpolation. Validate file type, ownership, size, expiry and symlink handling. Delete a single-use transient delivery after consumption, including failure paths; do not delete an unrelated persistent password file unless explicitly designated single-use.
- Execute one fill inside an exclusive browser operation, rechecking the current frame and field before dispatch. Do not automatically submit the form, navigate, or retry after uncertain completion.
- Return only a generic status. Audit operation metadata without secret bytes, file content, previews, hashes or lengths. Disable tracing, input logging and automatic snapshot attachment for the secret-entry operation.
- Suspend preview capture during secret entry and clear cached frames. Protect subsequent model-facing snapshots from password-field values and keep the preview blocked if the secret becomes visibly exposed. Default to an operator-controlled sensitive phase until the user confirms it is safe to resume agent observation; a site's arbitrary reflection of a password cannot be solved by masking only the original input.
- The browser and target site's JavaScript necessarily receive the value. A same-user agent with unrestricted shell can still read the source or inspect the process; current runtime isolation does not prevent deliberate extraction. Stronger guarantees require separating that service from agent shell access.

Acceptance uses synthetic canary passwords only: verify the target input receives the exact bytes while the canary is absent from RPC input/output visible to the model, logs, audit, snapshots, preview frames and stored artifacts. Verify wrong-origin/stale-field requests fail without filling, failed fills remove transient files, and uncertain completion is never replayed. Existing real credentials must not be used as test fixtures.

Repositories involved: `agent-browser-runtime`, `paxd`, `pax-manager`, and `pax-console`. Manager interface changes must follow its Thrift generation workflow. Console changes must follow its existing auth/proxy/runtime boundaries. Completing a design document does not mean these integrations have shipped.

## Protocol references

- [Chrome DevTools Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/) documents screenshot and experimental screencast operations.
- [Chrome extension screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture) documents user-gesture requirements for tab capture; it is not a zero-interaction pairing mechanism.
