#!/bin/zsh
# The serveo subdomain changes on every reconnect until the SSH key is registered.
# Until then, keep the Desktop QR pointing at whatever the tunnel currently is.
#
# The URL is only read from the server user's own 0600 file (not world-writable /tmp),
# must be an https serveo host, and is passed after `--` so it can never become a flag.
url_file="$HOME/Library/Application Support/doorway/tunnel-url"
out_dir="$HOME/Desktop"
last=""
while true; do
  u=$(head -n 1 "$url_file" 2>/dev/null | tr -d '[:space:]')
  if [[ "$u" =~ '^https://[a-z0-9-]+\.serveousercontent\.com/?$' && "$u" != "$last" ]]; then
    if curl -s -o /dev/null -m 8 -w '%{http_code}' -- "${u%/}/config.js" | grep -q 200; then
      qrencode -o "$out_dir/doorway-qr.png" -s 12 -m 3 -l M -- "$u"
      print -r -- "$u" > "$out_dir/doorway-url.txt"
      print -r -- "[$(date +%H:%M)] QR -> $u"
      last="$u"
    fi
  fi
  sleep 20
done
