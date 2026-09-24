#!/bin/zsh
# Keep a serveo tunnel up on a FIXED hostname and record it.
# A bare "-R doorway:80" asks for doorway.serveo.net, which serveo refuses until the
# SSH key is registered. Asking for the full host under serveousercontent.com is
# granted anonymously, so the address survives every reconnect.
while true; do
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
      -R doorway.serveousercontent.com:80:localhost:8090 serveo.net 2>&1 | while IFS= read -r line; do
        echo "$line"
        case "$line" in *"Forwarding HTTP traffic from"*)
          echo "$line" | grep -oE "https://[a-z0-9.-]+" | tail -1 > /tmp/tunnel-url.txt ;;
        esac
      done
  echo "[tunnel] dropped, reconnecting in 3s"
  sleep 3
done
