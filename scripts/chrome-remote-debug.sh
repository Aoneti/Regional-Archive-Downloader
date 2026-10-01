#!/usr/bin/env bash
# Launch Chrome with DevTools remote debugging, a copy of the default profile
# (incl. all extensions) and expose the port to the LAN.
#
# Usage: ./chrome-remote-debug.sh [LAN_PORT] [--fresh]
#   LAN_PORT  port exposed to the LAN (default 9222)
#   --fresh   re-copy the default profile even if the copy already exists
#
# Requires: socat (for LAN exposure). Close all Chrome windows first.
set -euo pipefail

LAN_PORT="${1:-9222}"
LOCAL_PORT=9223
FRESH=0
for a in "$@"; do [[ "$a" == "--fresh" ]] && FRESH=1; done

case "$(uname -s)" in
  Darwin)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    SRC="$HOME/Library/Application Support/Google/Chrome" ;;
  *)
    CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)"
    SRC="$HOME/.config/google-chrome"
    [[ -d "$SRC" ]] || SRC="$HOME/.config/chromium" ;;
esac
DST="$HOME/.chrome-remote-debug-profile"

if pgrep -x "chrome|Google Chrome|chromium" >/dev/null 2>&1; then
  echo "Chrome is running - close it completely first." >&2; exit 1
fi

# Chrome 136+ ignores --remote-debugging-port on the default user-data-dir,
# so we run on a copy of it.
if [[ $FRESH -eq 1 || ! -d "$DST" ]]; then
  echo "Copying profile $SRC -> $DST ..."
  rm -rf "$DST"; mkdir -p "$DST"
  rsync -a --exclude 'Singleton*' --exclude '*/Cache' --exclude '*/Code Cache' \
        --exclude '*/GPUCache' --exclude '*/Service Worker/CacheStorage' "$SRC/" "$DST/"
fi

"$CHROME" \
  --user-data-dir="$DST" \
  --profile-directory=Default \
  --remote-debugging-port="$LOCAL_PORT" \
  --remote-allow-origins='*' \
  --no-first-run --no-default-browser-check >/dev/null 2>&1 &
CHROME_PID=$!

# Headful Chrome binds DevTools to 127.0.0.1 only -> forward from LAN.
if command -v socat >/dev/null; then
  socat TCP-LISTEN:"$LAN_PORT",fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:"$LOCAL_PORT" &
  SOCAT_PID=$!
  trap 'kill $SOCAT_PID 2>/dev/null' EXIT
else
  echo "socat not found - port only available locally on $LOCAL_PORT" >&2
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0)"
echo "DevTools: http://$IP:$LAN_PORT/json/version"
echo "From another PC: chromium.connect_over_cdp('http://$IP:$LAN_PORT')"
wait $CHROME_PID
