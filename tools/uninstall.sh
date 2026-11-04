#!/usr/bin/env bash
# Removes the VPK installed by tools/install.sh (only that file).
set -euo pipefail
cd "$(dirname "$0")/.."
RECORD=.work/installed.txt
[ -f "$RECORD" ] || { echo "Nothing installed by tools/install.sh."; exit 0; }
DEST="$(cat "$RECORD")"
if pgrep -f 'deadlock\.exe' >/dev/null; then echo "Close Deadlock first."; exit 1; fi
[ -f "$DEST" ] && rm -- "$DEST" && echo "Removed $DEST"
rm -- "$RECORD"
