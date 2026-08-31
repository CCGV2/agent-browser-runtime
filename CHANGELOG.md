# Changelog

## 0.1.0 - 2026-08-31

- Add a headed Chromium desktop with Xvfb, Openbox, x11vnc, and noVNC.
- Keep MCP on STDIO and VNC/noVNC on host loopback.
- Run as non-root with a read-only root filesystem, dropped capabilities, `no-new-privileges`, and the Chromium sandbox enabled.
- Provide a writable ephemeral HOME for Chromium XDG and Crashpad state while preserving the browser profile separately.
- Patch the pinned Playwright seccomp profile to allow sandbox `chroot` after entering an unprivileged user namespace.
- Serialize access to the persistent browser profile with `flock`.
- Add installation, source verification, runtime verification, and a restrictive example Agent tool policy.
