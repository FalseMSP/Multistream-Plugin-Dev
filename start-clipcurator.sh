#!/usr/bin/env bash
# start-clipcurator.sh — Start ClipCurator Next.js dev server + clipper backend.
#
# This is the recommended entry point for systemd / production.
# ClipCurator runs on an internal port (default 3001) and is reverse-proxied
# to /clipcurator on port 2999 by the chat-mirror bot's overlay server.
#
# If the bot isn't running, ClipCurator can still be accessed directly at
# http://localhost:3001/clipcurator/ (but auth won't work without the bot).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLIPPER_PORT="${CLIPPER_PORT:-8100}"
CLIPCURATOR_PORT="${CLIPCURATOR_PORT:-3001}"

# Load NVM if available
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Kill stale processes before starting
kill_stale() {
  local port=$1
  local pid
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "[clipcurator] Killing stale process on port $port (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
}

BOT_PID=""
CLIPPER_PID=""
CLIPS_PID=""

cleanup() {
  [ -n "$CLIPPER_PID" ] && kill "$CLIPPER_PID" 2>/dev/null || true
  [ -n "$CLIPS_PID" ]  && kill "$CLIPS_PID"   2>/dev/null || true
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# ── Clipper backend (Python FastAPI) ──
kill_stale "$CLIPPER_PORT"
echo "[clipcurator] Starting clipper backend (port ${CLIPPER_PORT})..."
if [ ! -d "$ROOT/clipper/.venv" ]; then
  echo "[clipcurator] Creating Python venv..."
  python3 -m venv "$ROOT/clipper/.venv"
  "$ROOT/clipper/.venv/bin/pip" install -r "$ROOT/clipper/requirements.txt"
fi
(cd "$ROOT/clipper" && .venv/bin/python clipper.py) &
CLIPPER_PID=$!

# ── ClipCurator Next.js ──
kill_stale "$CLIPCURATOR_PORT"
echo "[clipcurator] Starting ClipCurator (port ${CLIPCURATOR_PORT})..."

# Ensure .env symlink for ClipCurator
if [ ! -L "$ROOT/clipcurator/.env" ] && [ ! -f "$ROOT/clipcurator/.env" ]; then
  if [ -f "$ROOT/.env" ]; then
    ln -s "$ROOT/.env" "$ROOT/clipcurator/.env"
  fi
fi

# Ensure Prisma client is generated
(cd "$ROOT/clipcurator" && npx prisma db push --accept-data-loss 2>/dev/null || true)

# Install deps if missing
if [ ! -d "$ROOT/clipcurator/node_modules" ]; then
  (cd "$ROOT/clipcurator" && npm install)
fi

(cd "$ROOT/clipcurator" && npx next dev -p "$CLIPCURATOR_PORT") &
CLIPS_PID=$!

echo "[clipcurator] Running. ClipCurator at http://localhost:${CLIPCURATOR_PORT}/clipcurator/"
echo "[clipcurator] Proxied at http://localhost:2999/clipcurator/ (if bot is running)"
wait
