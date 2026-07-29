#!/usr/bin/env bash
# start-bot.sh — Start only the chat-mirror bot.
#
# This is the recommended entry point for systemd / production.
# It runs ONLY the bot (index.js) which includes the overlay server,
# dashboard, and ClipCurator reverse-proxy on port 2999.
#
# ClipCurator and the clipper backend should be started separately
# (e.g. via dev-both.sh clips, or as their own systemd services).
#
# If ClipCurator isn't running, the proxy shows a friendly "not running"
# page at /clipcurator — the bot continues to work normally.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Load NVM if available (common on Ubuntu servers)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$ROOT"
exec node index.js
