#!/bin/sh
set -eu

umask 077
mkdir -p /data/profile /data/artifacts /data/logs /home/node/.cache

if [ ! -r /run/secrets/vnc_password ]; then
  echo "VNC password secret is missing or unreadable" >&2
  exit 1
fi

cleanup() {
  trap - TERM INT EXIT
  for pid in "${NOVNC_PID:-}" "${VNC_PID:-}" "${WM_PID:-}" "${XVFB_PID:-}"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -noreset \
  >>/data/logs/xvfb.log 2>&1 &
XVFB_PID=$!

ready=0
for _ in $(seq 1 100); do
  if DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "Xvfb did not become ready" >&2
  exit 1
fi

DISPLAY=:99 openbox-session >>/data/logs/openbox.log 2>&1 &
WM_PID=$!

x11vnc -display :99 -forever -shared -noxdamage -repeat \
  -rfbport 5900 -listen 0.0.0.0 \
  -passwdfile /run/secrets/vnc_password \
  -o /data/logs/x11vnc.log &
VNC_PID=$!

websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 \
  >>/data/logs/novnc.log 2>&1 &
NOVNC_PID=$!

while kill -0 "$XVFB_PID" "$WM_PID" "$VNC_PID" "$NOVNC_PID" 2>/dev/null; do
  sleep 2
done

echo "A desktop component exited unexpectedly" >&2
exit 1
