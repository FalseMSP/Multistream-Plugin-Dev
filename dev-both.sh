#!/usr/bin/env bash
# dev-both.sh — Run all services: bot, clipper backend, and ClipCurator.
#
# Usage:
#   ./dev-both.sh           # start all services
#   ./dev-both.sh bot       # start only the chat-mirror bot
#   ./dev-both.sh clips     # start only ClipCurator + clipper
#   ./dev-both.sh clipper   # start only the Python clipper backend
#
# The chat-mirror bot runs on port 2999 (overlay + dashboard + ClipCurator proxy).
# The clipper backend runs on port 8100 (Python FastAPI).
# ClipCurator runs on port 3001 (Next.js, proxied to /clipcurator on port 2999).
#
# Access ClipCurator at: http://localhost:2999/clipcurator/
# Access the dashboard at: http://localhost:2999/dashboard
#
# For systemd / production, use start-bot.sh instead of this script.
# This script is for local development only.

set -euo pipefail

# Load NVM if available (common on Ubuntu servers — fixes "node not found")
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

ROOT="$(cd "$(dirname "$0")" && pwd)"
BOT_PID=""
CLIPS_PID=""
CLIPPER_PID=""
CLIPPER_PORT="${CLIPPER_PORT:-8100}"
CLIPCURATOR_PORT="${CLIPCURATOR_PORT:-3001}"

# Kill stale processes on common ports before starting
kill_stale() {
  local port=$1
  local pid
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "[dev-both] Killing stale process on port $port (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
}

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$BOT_PID" ]    && kill "$BOT_PID"    2>/dev/null || true
  [ -n "$CLIPPER_PID" ] && kill "$CLIPPER_PID" 2>/dev/null || true
  [ -n "$CLIPS_PID" ]  && kill "$CLIPS_PID"   2>/dev/null || true
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

start_bot() {
  kill_stale 2999
  echo "[dev-both] Starting chat-mirror bot (port 2999, ClipCurator at /clipcurator)..."
  (cd "$ROOT" && node --watch index.js) &
  BOT_PID=$!
}

start_clipper() {
  kill_stale "$CLIPPER_PORT"
  echo "[dev-both] Starting clipper backend (port ${CLIPPER_PORT})..."
  # Check if Python venv exists, create if not
  if [ ! -d "$ROOT/clipper/.venv" ]; then
    echo "[dev-both] Creating Python venv for clipper..."
    python3 -m venv "$ROOT/clipper/.venv"
    echo "[dev-both] Installing clipper dependencies..."
    "$ROOT/clipper/.venv/bin/pip" install -r "$ROOT/clipper/requirements.txt"
  fi

  (cd "$ROOT/clipper" && .venv/bin/python clipper.py) &
  CLIPPER_PID=$!
}

start_clips() {
  kill_stale "$CLIPCURATOR_PORT"
  echo "[dev-both] Starting ClipCurator (internal port ${CLIPCURATOR_PORT}, proxied to /clipcurator on 2999)..."

  # Ensure ClipCurator can read the parent .env by creating a symlink.
  if [ ! -L "$ROOT/clipcurator/.env" ] && [ ! -f "$ROOT/clipcurator/.env" ]; then
    if [ -f "$ROOT/.env" ]; then
      ln -s "$ROOT/.env" "$ROOT/clipcurator/.env"
      echo "[dev-both] Linked .env → clipcurator/.env"
    fi
  fi

  # Ensure Prisma is set up
  (cd "$ROOT/clipcurator" && npx prisma db push --accept-data-loss 2>/dev/null || true)

  # Install dependencies if node_modules is missing
  if [ ! -d "$ROOT/clipcurator/node_modules" ]; then
    echo "[dev-both] Installing ClipCurator dependencies..."
    (cd "$ROOT/clipcurator" && npm install)
  fi

  # Start Next.js on the internal port (3001).
  # The bot's overlay server on port 2999 reverse-proxies /clipcurator/* here.
  (cd "$ROOT/clipcurator" && npx next dev -p "$CLIPCURATOR_PORT") &
  CLIPS_PID=$!
}

case "${1:-all}" in
  bot)
    start_bot
    ;;
  clips|clipcurator)
    start_clipper
    start_clips
    ;;
  clipper)
    start_clipper
    ;;
  all)
    start_bot
    start_clipper
    start_clips
    ;;
  *)
    echo "Usage: $0 [bot|clips|clipper|all]" >&2
    exit 1
    ;;
esac

echo "[dev-both] Running. Press Ctrl+C to stop."
echo ""
echo "  Dashboard:  http://localhost:2999/dashboard"
echo "  ClipCurator: http://localhost:2999/clipcurator/"
echo "  Clipper API: http://localhost:${CLIPPER_PORT}/health"
echo ""
wait
