#!/usr/bin/env bash
# Rebuilds the miro-chat applet bundle and vendors it into static/chat/.
# Usage: scripts/update-chat-applet.sh [path-to-miro-chat-checkout]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
chat_repo="$(cd "${1:-$here/../../miro-chat}" && pwd)"
target="$here/../static/chat"

(cd "$chat_repo" && npm install && npm run build)

mkdir -p "$target"
cp "$chat_repo/dist/miro-chat.applet.js" "$target/miro-chat.applet.js"
echo "Updated $target/miro-chat.applet.js"
