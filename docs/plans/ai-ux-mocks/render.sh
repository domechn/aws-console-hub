#!/usr/bin/env bash
# Render mock screens to png/ at 2x. Usage: render.sh [name W H]...  (no args: every screen)
# Chromium from Playwright's cache; override with CHROME=/path/to/chrome.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p png
CHROME=${CHROME:-$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)}

ALL=(
  01-before-after 888 900
  02-empty 400 860
  03-conversation 400 860
  04-activity-expanded 400 860
  05-approval 400 860
  06-proposal 888 1200
  07-composer 1316 640
  08-conversations 400 860
  09-widths 930 920
  10-error 400 860
  11-dark 460 920
)
set -- "${@:-${ALL[@]}}"
while [ $# -ge 3 ]; do
  name=$1 w=$2 h=$3
  shift 3
  "$CHROME" --no-sandbox --disable-gpu --headless=new --hide-scrollbars --force-device-scale-factor=2 \
    --allow-file-access-from-files --window-size="$w,$h" --screenshot="png/$name.png" "file://$PWD/$name.html" 2>/dev/null
  echo "png/$name.png"
done
