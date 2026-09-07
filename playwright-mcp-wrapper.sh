#!/bin/sh
set -eu

umask 077
exec node /opt/agent-browser/browser-client.cjs
