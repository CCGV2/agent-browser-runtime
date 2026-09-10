# Security

## Reporting a vulnerability

Do not open a public issue containing credentials, browser profile data, cookies, tokens, VNC passwords, or exploit details that would put a deployed instance at immediate risk. Contact the repository maintainer privately first. Add a concrete private contact method before publishing the repository.

## Deployment boundary

Native mode's permission MVP gates a fixed MCP surface and stores audit records in a shared local service; see [its boundaries](docs/native-permissions-mvp.md). It is not an OS sandbox against same-user shell/file access, and it does not provide a network firewall or tamper-proof audit. Keep management credentials out of agent context. Site grants do not imply approval for every consequential action on that site.

- Keep host ports 5900 and 6080 bound to `127.0.0.1` and reach noVNC through an authenticated SSH tunnel.
- Do not expose MCP over HTTP or enable a CDP listener.
- Do not add `--no-sandbox`, privileged mode, `SYS_ADMIN`, a Docker socket mount, or a host-home mount.
- Treat the persistent browser profile and all artifacts as sensitive data.
- Enforce the MCP tool allowlist in the client. In particular, do not expose `browser_evaluate` or `browser_run_code_unsafe` to an untrusted Agent.
- Review dependency, browser, and seccomp changes together when upgrading.

## Supported versions

Until a stable release policy is published, only the latest tagged release should be considered supported.
