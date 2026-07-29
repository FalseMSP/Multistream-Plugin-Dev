#!/usr/bin/env bash
# apply-patch.sh — Apply the ClipCurator v2 patch (real pipeline + subtitles
# + backing tracks + channel config + download button).
#
# Usage:
#   bash apply-patch.sh /home/ubuntu/discord-chat-mirror2
#
# This script:
#   1. Backs up the files being replaced (to *.bak.v2)
#   2. Copies in the patched files
#   3. Removes the obsolete /api/seed endpoint
#   4. Runs prisma db push to apply schema changes
#   5. Restarts the clip-curator systemd service
#   6. Tails the logs so you can see it come up

set -euo pipefail

PROJECT_ROOT="${1:-/home/ubuntu/discord-chat-mirror2}"
CLIP_DIR="$PROJECT_ROOT/clipcurator"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$CLIP_DIR/src" ]; then
  echo "ERROR: $CLIP_DIR does not look like the clipcurator project (no src/ dir)"
  echo "Usage: $0 /path/to/project-root  (parent of clipcurator/)"
  exit 1
fi

echo "[patch] Project root: $PROJECT_ROOT"
echo "[patch] ClipCurator:  $CLIP_DIR"
echo "[patch] Patch source: $PATCH_DIR"
echo ""

# ── 1. Back up existing files ──
echo "[patch] Backing up existing files to *.bak.v2 ..."
backup_files=(
  "src/lib/queue.ts"
  "src/lib/pipeline.ts"
  "src/lib/constants.ts"
  "src/lib/clipper-client.ts"
  "src/types/index.ts"
  "src/store/queue.ts"
  "src/hooks/use-clipcurator.ts"
  "src/components/clipcurator/app-shell.tsx"
  "src/components/clipcurator/dashboard-view.tsx"
  "src/components/clipcurator/queue-view.tsx"
  "src/app/api/streams/route.ts"
  "src/app/api/queue/next/route.ts"
  "src/app/api/queue/[id]/review/route.ts"
  "prisma/schema.prisma"
  "next.config.ts"
  "../clipper/clipper.py"
)
for f in "${backup_files[@]}"; do
  if [ -f "$CLIP_DIR/$f" ]; then
    cp "$CLIP_DIR/$f" "$CLIP_DIR/$f.bak.v2"
    echo "  backed up $f"
  fi
done

# ── 2. Copy patched files ──
echo ""
echo "[patch] Copying patched files ..."

# Prisma schema
cp "$PATCH_DIR/prisma/schema.prisma" "$CLIP_DIR/prisma/schema.prisma"
echo "  wrote prisma/schema.prisma"

# next.config.ts
cp "$PATCH_DIR/next.config.ts" "$CLIP_DIR/next.config.ts"
echo "  wrote next.config.ts"

# lib/
cp "$PATCH_DIR/src/lib/clipper-client.ts" "$CLIP_DIR/src/lib/clipper-client.ts"
cp "$PATCH_DIR/src/lib/constants.ts"      "$CLIP_DIR/src/lib/constants.ts"
cp "$PATCH_DIR/src/lib/pipeline.ts"       "$CLIP_DIR/src/lib/pipeline.ts"
cp "$PATCH_DIR/src/lib/queue.ts"          "$CLIP_DIR/src/lib/queue.ts"
echo "  wrote src/lib/*"

# types
cp "$PATCH_DIR/src/types/index.ts" "$CLIP_DIR/src/types/index.ts"
echo "  wrote src/types/index.ts"

# store
cp "$PATCH_DIR/src/store/queue.ts" "$CLIP_DIR/src/store/queue.ts"
echo "  wrote src/store/queue.ts"

# hooks
cp "$PATCH_DIR/src/hooks/use-clipcurator.ts" "$CLIP_DIR/src/hooks/use-clipcurator.ts"
echo "  wrote src/hooks/use-clipcurator.ts"

# components
cp "$PATCH_DIR/src/components/clipcurator/app-shell.tsx"      "$CLIP_DIR/src/components/clipcurator/app-shell.tsx"
cp "$PATCH_DIR/src/components/clipcurator/dashboard-view.tsx" "$CLIP_DIR/src/components/clipcurator/dashboard-view.tsx"
cp "$PATCH_DIR/src/components/clipcurator/queue-view.tsx"     "$CLIP_DIR/src/components/clipcurator/queue-view.tsx"
cp "$PATCH_DIR/src/components/clipcurator/settings-view.tsx"  "$CLIP_DIR/src/components/clipcurator/settings-view.tsx"
cp "$PATCH_DIR/src/components/clipcurator/subtitle-editor.tsx" "$CLIP_DIR/src/components/clipcurator/subtitle-editor.tsx"
echo "  wrote src/components/clipcurator/*"

# API routes
cp "$PATCH_DIR/src/app/api/streams/route.ts"                "$CLIP_DIR/src/app/api/streams/route.ts"
cp "$PATCH_DIR/src/app/api/queue/next/route.ts"             "$CLIP_DIR/src/app/api/queue/next/route.ts"
cp "$PATCH_DIR/src/app/api/queue/[id]/review/route.ts"      "$CLIP_DIR/src/app/api/queue/[id]/review/route.ts"
echo "  wrote src/app/api/{streams,queue/*}"

# New API routes
mkdir -p "$CLIP_DIR/src/app/api/channels/[id]"
cp "$PATCH_DIR/src/app/api/channels/route.ts"      "$CLIP_DIR/src/app/api/channels/route.ts"
cp "$PATCH_DIR/src/app/api/channels/[id]/route.ts" "$CLIP_DIR/src/app/api/channels/[id]/route.ts"
echo "  wrote src/app/api/channels/*"

mkdir -p "$CLIP_DIR/src/app/api/backing-tracks/[id]"
cp "$PATCH_DIR/src/app/api/backing-tracks/route.ts"      "$CLIP_DIR/src/app/api/backing-tracks/route.ts"
cp "$PATCH_DIR/src/app/api/backing-tracks/[id]/route.ts" "$CLIP_DIR/src/app/api/backing-tracks/[id]/route.ts"
echo "  wrote src/app/api/backing-tracks/*"

mkdir -p "$CLIP_DIR/src/app/api/clips/[id]/{download,render-preview,subtitles}"
cp "$PATCH_DIR/src/app/api/clips/[id]/download/route.ts"        "$CLIP_DIR/src/app/api/clips/[id]/download/route.ts"
cp "$PATCH_DIR/src/app/api/clips/[id]/render-preview/route.ts"  "$CLIP_DIR/src/app/api/clips/[id]/render-preview/route.ts"
cp "$PATCH_DIR/src/app/api/clips/[id]/subtitles/route.ts"       "$CLIP_DIR/src/app/api/clips/[id]/subtitles/route.ts"
echo "  wrote src/app/api/clips/[id]/*"

mkdir -p "$CLIP_DIR/src/app/api/sources/[id]/transcript"
cp "$PATCH_DIR/src/app/api/sources/[id]/transcript/route.ts" "$CLIP_DIR/src/app/api/sources/[id]/transcript/route.ts"
echo "  wrote src/app/api/sources/[id]/transcript/route.ts"

# ── 3. Remove obsolete seed endpoint ──
echo ""
echo "[patch] Removing obsolete /api/seed endpoint ..."
rm -f "$CLIP_DIR/src/app/api/seed/route.ts"
rmdir "$CLIP_DIR/src/app/api/seed" 2>/dev/null || true
echo "  removed src/app/api/seed/route.ts"

# ── 4. Update clipper.py ──
echo ""
echo "[patch] Updating clipper.py ..."
cp "$PATCH_DIR/clipper/clipper.py" "$PROJECT_ROOT/clipper/clipper.py"
echo "  wrote clipper/clipper.py"

# ── 5. Apply Prisma schema ──
echo ""
echo "[patch] Applying Prisma schema changes ..."
cd "$CLIP_DIR"
npx prisma generate
npx prisma db push --accept-data-loss
echo "  schema applied"

# ── 6. Nuke .next cache ──
echo ""
echo "[patch] Clearing .next cache ..."
rm -rf "$CLIP_DIR/.next"

# ── 7. Restart service ──
echo ""
echo "[patch] Restarting clip-curator service ..."
if command -v sudo &>/dev/null; then
  sudo systemctl restart clip-curator
else
  systemctl restart clip-curator
fi

echo ""
echo "[patch] Done. Tailing logs (Ctrl+C to stop) ..."
echo ""
sleep 2
journalctl -u clip-curator -f --no-pager -n 30
