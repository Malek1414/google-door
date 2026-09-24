#!/bin/zsh
# The serveo subdomain changes on every reconnect until the SSH key is registered.
# Until then, keep the Desktop QR pointing at whatever the tunnel currently is.
last=""
while true; do
  u=$(cat "$HOME/Library/Application Support/doorway/tunnel-url" 2>/dev/null || cat /tmp/tunnel-url.txt 2>/dev/null)
  if [[ -n "$u" && "$u" != "$last" ]]; then
    if curl -s -o /dev/null -m 8 -w '%{http_code}' "$u/config.js" | grep -q 200; then
      qrencode -o /Users/malekhassan/Desktop/doorway-qr.png -s 12 -m 3 -l M "$u"
      echo "$u" > /Users/malekhassan/Desktop/doorway-url.txt
      echo "[$(date +%H:%M)] QR -> $u"
      last="$u"
    fi
  fi
  sleep 20
done
