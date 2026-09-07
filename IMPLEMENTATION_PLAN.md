# Session-scoped browser MCP

## Boundaries

Keep the public MCP transport on stdio. A container-local Unix socket broker
owns one isolated Playwright MCP worker per opaque session key. Workers use
isolated browser contexts, never the shared persistent profile. Retain workers
briefly across disconnects; do not promise recovery across broker restart.
This first implementation uses separate browser processes for fault isolation;
sharing a single browser process is a future optimization.

paxd expands local MCP launch descriptions after decryption using the verified
agent and envelope session identity. It owns no browser resources or API.

## BDD / TDD

1. Given different keys, when clients connect, then workers are distinct.
2. Given a connected key, a duplicate attach fails without stealing ownership.
3. Given a disconnected key, reconnect before expiry retains its worker.
4. Given expiry or worker failure, later attach creates a fresh worker.
5. Given local MCP templates, new/resume injects stable identity and preserves
   unrelated client MCP entries; no templates means unchanged payload.
6. Given E2EE requests, expansion happens only after authenticated decryption.

Write policy tests first, then implement the broker and generic launch expansion.
Run Node tests, shell checks, Go runtime tests and build. Review and include the
existing session-resume configuration changes in the paxd branch commit.
Do not restart or deploy the user's active services during verification.

## Validation

- Pool lifecycle tests and Unix socket broker protocol tests.
- Real Playwright 0.0.79 clients: concurrent pages and cookies isolated,
  disconnected session retained, closing one context leaves the other usable.
- paxd full Go suite and binary build using gvm go1.26.
- Docker source checks and isolated image build where available; no deployment
  of the active browser container or paxd daemon is part of this change.
