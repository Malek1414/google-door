#!/bin/zsh
# Start the Doorway backend. server/app.py loads .env itself, so this is just the
# canonical invocation — no environment to remember and nothing to get wrong.
cd "$(dirname "$0")/.."
exec .venv/bin/python -m uvicorn server.app:app --host 0.0.0.0 --port 8090
