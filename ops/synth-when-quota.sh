#!/bin/zsh
# TTS is capped at 100 requests/day. Poll for the window to reopen, then synthesise
# only the approach phrase bank (--phrases skips ~300 entrance descriptions).
cd /tmp/dw-repo
set -a; . ./.env; set +a
while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent" \
    -H "Content-Type: application/json" -H "x-goog-api-key: $GEMINI_API_KEY" \
    -d '{"contents":[{"parts":[{"text":"ok"}]}],"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}')
  if [ "$code" = "200" ]; then
    echo "[$(date '+%H:%M')] quota open — synthesising the approach bank"
    python3 -u pipeline/synth_speech.py --lang de --phrases
    exit 0
  fi
  echo "[$(date '+%H:%M')] still $code, retrying in 10 min"
  sleep 600
done
