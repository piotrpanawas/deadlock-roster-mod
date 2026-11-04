#!/usr/bin/env bash
# Manual install of dist/pakNN_dir.vpk into game/citadel/addons/.
# Preferred alternative: Deadlock Mod Manager > Mods Library > Add Local Mod > dist/roster-tools-*.zip.
# Never edits gameinfo.gi; it only checks that citadel/addons is mounted.
# Usage: tools/install.sh [--game /path/to/Deadlock] [--pak 57]
set -euo pipefail
cd "$(dirname "$0")/.."
GAME="${DEADLOCK_ROOT:-}"; PAK=57
while [ $# -gt 0 ]; do
    case "$1" in
        --game) GAME="$2"; shift 2 ;;
        --pak) PAK="$2"; shift 2 ;;
        *) echo "unknown option $1"; exit 2 ;;
    esac
done
if [ -z "$GAME" ]; then
    GAME="$(python3 -I -c 'import sys; sys.path.insert(0, "tools"); from build import find_game; print(find_game(None))')"
fi
CITADEL="$GAME/game/citadel"
SRC="$(ls dist/pak*_dir.vpk 2>/dev/null | head -1)"
DEST="$CITADEL/addons/$(printf 'pak%02d_dir.vpk' "$PAK")"
RECORD=.work/installed.txt

[ -n "$SRC" ] || { echo "No dist/pak*_dir.vpk. Run python3 tools/build.py first."; exit 1; }
if ! grep -Eq '^[[:space:]]*Game[[:space:]]+citadel/addons[[:space:]]*$' "$CITADEL/gameinfo.gi"; then
    echo "gameinfo.gi does not mount citadel/addons. Enable it with Deadlock Mod Manager (or see README), then retry."
    exit 1
fi
if pgrep -f 'deadlock\.exe' >/dev/null; then
    echo "Deadlock is running. Close it first (mods load only at startup)."; exit 1
fi
if [ -e "$DEST" ] && ! { [ -f "$RECORD" ] && grep -qxF "$DEST" "$RECORD"; }; then
    echo "$DEST exists and was not installed by this script. Pick another number: --pak NN"; exit 1
fi
mkdir -p "$CITADEL/addons" .work
cp "$SRC" "$DEST"
echo "$DEST" > "$RECORD"
cmp -s "$SRC" "$DEST" && echo "Installed $DEST ($(sha256sum "$DEST" | cut -c1-16)...)"
echo "Start the game, open the roster screen. Logs: tools/gamelog.sh (needs -condebug in launch options)."
