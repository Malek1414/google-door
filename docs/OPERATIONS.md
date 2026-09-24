# Running Doorway

What has to be up, how to start it, and the traps that cost us hours tonight.
Written 2026-09-24, after a night of finding each of these the hard way.

## The four processes

| | start | what breaks without it |
|---|---|---|
| backend | `ops/serve.sh` | everything |
| tunnel | `ops/tunnel.sh` | the phone, the QR, the Swift app |
| QR watcher | `ops/qr-watch.sh` | nothing, now that the hostname is fixed — insurance |
| TTS synth | `/tmp/synth-when-quota.sh` | the good voice; falls back to the browser's |

Health in one line:

    curl -s localhost:8090/api/health

`gemini` and `maps` must both be `true`. If either is `false` the app still answers
200 on every path and simply does the wrong thing quietly — see the first trap.

## Addresses

- public: **https://doorway.serveousercontent.com** (fixed, no account needed)
- LAN: `http://192.168.12.158:8090`
- the app asks the Mac for the current public address at launch: `GET /api/live-url`

## Traps, in the order they bit us

**1. A keyless server looks healthy.** uvicorn restarted without its environment
answers 200 everywhere. Routing silently falls through to the crow-flight line
("Roughly this way") and every Gemini call refuses. Nothing in the UI can say why.
`server/app.py` loads `.env` itself now, before the routers import, so this cannot
recur — but if directions ever read "roughly", check `/api/health` first, not the
routing code.

**2. `vite build` empties `dist/`, and `config.js` lives outside it.** That file
carries the Maps key, so every rebuild used to ship an app with no map until someone
remembered to copy it back. `vite.config.ts` emits it as a build asset now.

**3. The serveo subdomain.** `-R doorway:80` asks for `doorway.serveo.net`, which
serveo refuses until an SSH key is registered — that is why we spent a night on a new
random URL every ten minutes. Asking for the full host under `serveousercontent.com`
is granted anonymously:

    ssh -R doorway.serveousercontent.com:80:localhost:8090 serveo.net

**4. Gemini 429s are routine on this tier.** `/api/speak`, `/api/look`, `/api/door-fix`
and `/api/door-check` all back off and retry now. Vision has no fallback: when it gives
up, a blind user gets silence, and silence is indistinguishable from a crash to someone
who cannot see the screen.

**5. TTS is capped at 100 requests/day** and is shared with every other synthesis.
The approach bank is 16 clips (`approachClipBank()` in `core/instruct.ts`) and none of
them exist yet. `clipKeyFor()` returns `null` when a clip is missing, which is
silent-but-safe: the line goes to `/api/speak` and costs one request.

## Known unverified

- **`DoorFix.inside === true` has never been seen on a real interior frame.** The
  stillness route to `through` is the one exercised end to end. Needs a five-second
  clip walking through any door — questions.md Q8.
- **The wheelchair verdict card has only met fixtures**, never a real doorway photo,
  so the confidence floor is a guess.
- **iOS provisioning expires 2026-09-30.** Free provisioning is seven days; after that
  the app stops launching until rebuilt and reinstalled.

## Rebuilding

    cd web && npm test && npm run build        # 306 tests
    cd ios && xcodebuild -project Doorway.xcodeproj -scheme Doorway \
      -configuration Debug -destination 'id=<UDID>' -derivedDataPath /tmp/dw-dd build
    xcrun devicectl device install app --device <UDID> \
      /tmp/dw-dd/Build/Products/Debug-iphoneos/Doorway.app

The Swift app is a WKWebView over the public host, so **web changes need no iOS
rebuild** — only a change to the Swift source itself does.
