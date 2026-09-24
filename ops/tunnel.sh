#!/bin/zsh
# Keep a serveo tunnel up on a FIXED hostname and record it.
# A bare "-R doorway:80" asks for doorway.serveo.net, which serveo refuses until the
# SSH key is registered. Asking for the full host under serveousercontent.com is
# granted anonymously, so the address survives every reconnect.
#
# serveo.net's host key is pinned in ops/known_hosts_serveo (captured 2026-09-24,
# ED25519 SHA256:GnmVK+70U6GqbupoV+gg7LnHHUsW1IjrK0cLqvDJxIk). If serveo ever rotates
# it, ssh refuses to connect: re-capture it deliberately, never switch checking off.
#
# The live address goes to a file only this user can write. /api/live-url reads it
# from there; /tmp was world-writable, so anyone on the Mac could have redirected the app.
HERE=${0:A:h}
STATE="$HOME/Library/Application Support/doorway"
mkdir -p "$STATE" && chmod 700 "$STATE"
umask 077
while true; do
  ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$HERE/known_hosts_serveo" \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
      -R doorway.serveousercontent.com:80:localhost:8090 serveo.net 2>&1 | while IFS= read -r line; do
        echo "$line"
        case "$line" in *"Forwarding HTTP traffic from"*)
          echo "$line" | grep -oE "https://[a-z0-9.-]+" | tail -1 > "$STATE/tunnel-url" ;;
        esac
      done
  echo "[tunnel] dropped, reconnecting in 3s"
  sleep 3
done
