#!/bin/zsh
# Start the Doorway backend. server/app.py loads .env itself, so this is just the
# canonical invocation — no environment to remember and nothing to get wrong.
# PORT overrides the default (e.g. PORT=8081 for a second instance next to a live one).
cd "$(dirname "$0")/.."
PY=.venv/bin/python
[[ -x $PY ]] || PY=python3
# Say at startup which keys are missing, instead of answering 200 while degraded.
for k in GEMINI_API_KEY MAPS_API_KEY; do
  [[ -n ${(P)k} ]] || grep -q "^$k=." .env 2>/dev/null || print -u2 "serve.sh: $k missing (env and .env) - /api/health will report it"
done
exec $PY -m uvicorn server.app:app --host 0.0.0.0 --port "${PORT:-8090}"
