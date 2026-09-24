#!/usr/bin/env bash
# Deploy Doorway to Sami's VPS: static web app via Caddy, backend proxy (server/app.py)
# in a small Docker container on 127.0.0.1:8350. Keys live only in /opt/doorway/.env on
# the server (chmod 600); web/config.js (Maps browser key) is copied next to index.html.
#
#   REPO=~/Desktop/APP/google-doorway ./deploy-vps.sh
set -euo pipefail

VPS=root@5.45.109.195
DEST=/opt/doorway
PORT=8350
URL=https://doorway.5.45.109.195.sslip.io
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$HERE/..}"   # repo root of this branch (server/ and data/, rebased on main)

cd "$HERE"
test -f config.js || { echo "missing web/config.js (copy config.example.js)"; exit 1; }

echo "==> tests + build"
npm test >/dev/null
npm run build >/dev/null
if grep -rqE "AIza[0-9A-Za-z_-]{20}|AKIA[0-9A-Z]{12}|sk-[A-Za-z0-9]{20}" dist/; then echo "key found in dist/, abort"; exit 1; fi

echo "==> upload"
ssh "$VPS" "mkdir -p $DEST/web $DEST/server $DEST/data && test -f $DEST/.env || { echo 'missing $DEST/.env on server'; exit 1; }"
rsync -rlptD --delete --exclude '.DS_Store' dist/ "$VPS:$DEST/web/"
rsync -lt config.js "$VPS:$DEST/web/config.js" && ssh "$VPS" "chmod 644 $DEST/web/config.js"
rsync -rlptD --delete --exclude '__pycache__' "$REPO/server/" "$VPS:$DEST/server/"
rsync -rlptD --delete "$REPO/data/" "$VPS:$DEST/data/"

echo "==> backend container"
ssh "$VPS" "cd $DEST && cat > Dockerfile <<'DOCKER'
FROM python:3.12-slim
RUN pip install --no-cache-dir fastapi uvicorn httpx
WORKDIR /app
COPY server server
COPY data data
CMD [\"sh\", \"-c\", \"uvicorn server.app:app --host 127.0.0.1 --port \$PORT\"]
DOCKER
docker build -q -t doorway:latest . >/dev/null \
  && (docker rm -f doorway >/dev/null 2>&1 || true) \
  && docker run -d --name doorway --restart unless-stopped --network host \
     --env-file $DEST/.env -e PORT=$PORT --memory=128m doorway:latest >/dev/null"

echo "==> check"
sleep 3
echo "    page   : $(curl -s -o /dev/null -w '%{http_code}' $URL/ --max-time 20)"
echo "    health : $(curl -s $URL/api/health --max-time 20 | head -c 300)"
