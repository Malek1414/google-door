#!/usr/bin/env python3
"""Pre-synthesise spoken guidance with Gemini TTS.

Why build-time and not runtime: the walking loop must never wait on a network call.
Almost every line Doorway says is predictable — turn left, thirty metres, revolving
door, you have arrived — so it is synthesised once, committed as WAV, and played from
disk with zero latency. Works with no signal, which matters on a street.

Only genuinely dynamic text (the opt-in "what am I looking at?" reply) hits
POST /api/speak at runtime. Browser speechSynthesis stays as the last-resort fallback:
a blind user must never be left in silence because a CDN blinked.

    GEMINI_API_KEY=... python3 pipeline/synth_speech.py --lang de
    GEMINI_API_KEY=... python3 pipeline/synth_speech.py --probe   # dump raw response
"""
import base64, json, os, struct, sys, time, urllib.error, urllib.parse, urllib.request

KEY   = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("GEMINI_MODEL_TTS", "gemini-3.1-flash-tts-preview")
VOICE = os.environ.get("GEMINI_TTS_VOICE", "Kore")       # "Firm" — right register for guidance
URL   = "https://generativelanguage.googleapis.com/v1beta/models"
OUTDIR = "data/audio"

# Stage language is German; English kept for the recording and for judges.
PHRASES = {
    "de": {
        "turn_left":        "Links.",
        "turn_right":       "Rechts.",
        "straight":         "Geradeaus.",
        "arrived":          "Sie haben den Eingang erreicht.",
        "off_route":        "Stopp. Der Eingang liegt hinter Ihnen.",
        "confirmed":        "Stufenloser Eingang bestätigt.",
        "reported_only":    "Dieses Gebäude meldet einen stufenlosen Zugang, aber ich weiß nicht, welche Tür.",
        "unknown":          "Ich habe keine Daten zu den Eingängen dieses Gebäudes.",
        "warn_revolving":   "Achtung: Drehtür.",
        "warn_steps":       "Achtung: Stufen.",
        "door_automatic":   "Die Tür öffnet automatisch.",
        "low_accuracy":     "Ungefähr in diese Richtung. Das Signal ist ungenau.",
    },
    "en": {
        "turn_left":        "Left.",
        "turn_right":       "Right.",
        "straight":         "Straight ahead.",
        "arrived":          "You have reached the entrance.",
        "off_route":        "Stop. The entrance is behind you.",
        "confirmed":        "Step-free entrance confirmed.",
        "reported_only":    "This building reports step-free access, but I don't know which door.",
        "unknown":          "I have no entrance data for this building.",
        "warn_revolving":   "Careful: revolving door.",
        "warn_steps":       "Careful: steps.",
        "door_automatic":   "The door opens automatically.",
        "low_accuracy":     "Roughly this way. The signal is imprecise.",
    },
}
DISTANCES = [5, 10, 15, 20, 30, 40, 50, 75, 100]


def wav(pcm: bytes, rate=24000, ch=1, width=2) -> bytes:
    """Gemini returns raw PCM. A browser needs a RIFF header in front of it."""
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, ch, rate, rate*ch*width, ch*width, width*8) +
            b"data" + struct.pack("<I", len(pcm)) + pcm)


def synth(text: str, tries: int = 5) -> bytes:
    """Synthesise one clip. Backs off on 429 — the free tier rate-limits hard."""
    for attempt in range(tries):
        try:
            return _synth_once(text)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == tries - 1:
                raise
            wait = 5 * (2 ** attempt)          # 5, 10, 20, 40s
            print(f"      429 — waiting {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def _synth_once(text: str) -> bytes:
    body = {"contents": [{"parts": [{"text": text}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}}}}
    req = urllib.request.Request(
        f"{URL}/{MODEL}:generateContent", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.load(r)
    if "--probe" in sys.argv:
        print(json.dumps(payload, indent=2)[:2000]); sys.exit(0)
    try:
        b64 = payload["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    except (KeyError, IndexError):
        raise RuntimeError("unexpected TTS response shape; run with --probe to inspect:\n"
                           + json.dumps(payload)[:500])
    return wav(base64.b64decode(b64))


def main():
    if not KEY:
        sys.exit("GEMINI_API_KEY not set")
    lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "de"
    outdir = os.path.join(OUTDIR, lang)
    os.makedirs(outdir, exist_ok=True)

    jobs = dict(PHRASES[lang])
    for m in DISTANCES:
        jobs[f"dist_{m}"] = (f"{m} Meter." if lang == "de" else f"{m} metres.")

    # Per-entrance descriptions, if the Gemini description pass has run.
    doc = json.load(open("data/berlin-mitte.json"))
    described = [e for e in doc["entrances"] if e.get("description")]
    for e in described:
        jobs["ent_" + e["id"].replace("/", "_")] = e["description"]
    print(f"{len(jobs)} clips ({len(described)} entrance descriptions) -> {outdir}")

    manifest, done, failed = {}, 0, 0
    for key, text in jobs.items():
        path = os.path.join(outdir, f"{key}.wav")
        if os.path.exists(path):                     # resumable
            manifest[key] = {"file": f"audio/{lang}/{key}.wav", "text": text}
            continue
        try:
            data = synth(text)
        except Exception as ex:
            failed += 1
            print(f"  FAIL {key}: {ex}", file=sys.stderr, flush=True)
            continue
        with open(path, "wb") as f:
            f.write(data)
        time.sleep(2.0)                        # stay under the per-minute cap
        manifest[key] = {"file": f"audio/{lang}/{key}.wav", "text": text}
        done += 1
        print(f"  {key:22s} {len(data)//1024:4d} KB", flush=True)

    with open(os.path.join(OUTDIR, f"manifest.{lang}.json"), "w") as f:
        json.dump({"lang": lang, "voice": VOICE, "model": MODEL, "clips": manifest},
                  f, indent=1, ensure_ascii=False)
    print(f"\nsynthesised {done}, cached {len(manifest)-done}, failed {failed}")
    print(f"manifest: {OUTDIR}/manifest.{lang}.json")


if __name__ == "__main__":
    main()
