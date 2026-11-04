#!/usr/bin/env bash
# Follows the game console log, filtered to Roster Tools and script errors.
# Requires "-condebug" in Deadlock's Steam launch options (writes game/citadel/console.log).
# Usage: tools/gamelog.sh [--all]   (--all: print the whole filtered log and exit)
set -euo pipefail
cd "$(dirname "$0")/.."
GAME="${DEADLOCK_ROOT:-$(python3 -I -c 'import sys; sys.path.insert(0, "tools"); from build import find_game; print(find_game(None))')}"
LOG="$GAME/game/citadel/console.log"
[ -f "$LOG" ] || { echo "No $LOG yet. Add -condebug to the launch options and start the game."; exit 1; }
PATTERN='RosterTools|roster_tools|Panorama Script Error|JavaScript|Uncaught|vjs_c|citadel_popup_roster_select'
if [ "${1:-}" = "--all" ]; then grep -aE "$PATTERN" "$LOG"; else tail -n 0 -F "$LOG" | grep -aE --line-buffered "$PATTERN"; fi
