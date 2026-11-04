#!/usr/bin/env bash
# Publishes bridge/ to the public GitHub Pages repository that serves it.
# Usage: tools/publish_bridge.sh ["commit message"]
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${BRIDGE_REPO:-piotrpanawas/deadlock-roster-tools-bridge}"
DIR=.work/bridge-repo
MESSAGE="${1:-Update bridge from deadlock-roster-mod $(git rev-parse --short HEAD)}"

if [ ! -d "$DIR/.git" ]; then
    rm -rf "$DIR"
    if gh repo view "$REPO" >/dev/null 2>&1; then
        gh repo clone "$REPO" "$DIR"
    else
        mkdir -p "$DIR" && git -C "$DIR" init -q -b main
        gh repo create "$REPO" --public --description "Storage bridge page for the Roster Tools Deadlock mod (GitHub Pages)"
        git -C "$DIR" remote add origin "git@github.com:$REPO.git"
    fi
fi
git -C "$DIR" pull -q --ff-only origin main 2>/dev/null || true
cp bridge/bridge.html bridge/sw.js bridge/README.md LICENSE "$DIR"/
touch "$DIR/.nojekyll"
git -C "$DIR" add -A
if git -C "$DIR" diff --cached --quiet; then echo "Bridge unchanged."; exit 0; fi
git -C "$DIR" commit -q -m "$MESSAGE"
git -C "$DIR" push -q -u origin main
if ! gh api "repos/$REPO/pages" >/dev/null 2>&1; then
    gh api -X POST "repos/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null
    echo "GitHub Pages enabled."
fi
echo "Published: https://${REPO%%/*}.github.io/${REPO#*/}/bridge.html"
