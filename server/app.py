#!/usr/bin/env python3
"""Doorway backend proxy.

Exists for one reason that cannot be designed away: a QR-distributed web app cannot
hold a Gemini or Places API key. Keys live here, in the environment, never in the
bundle. Everything else the app needs is a static file.

    pip install fastapi uvicorn httpx
    GEMINI_API_KEY=... MAPS_API_KEY=... uvicorn server.app:app --port 8080
"""
import json, os, re
from collections import OrderedDict
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi import Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

def _load_dotenv() -> None:
    """Read .env next to the repo root, without adding a dependency.

    The server was once restarted without its environment and came back up answering
    200 on every route while silently having no keys: routing fell through to "roughly
    this way" and every Gemini call refused. Nothing in the logs said why. Loading the
    file the keys already live in removes the whole class of mistake — however the
    process is started, it finds them.

    Real environment variables win, so a deliberate override still works.
    """
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    except OSError:
        pass


_load_dotenv()

# Keys are read by server/upstream.py at call time, never held here.

# Model IDs verified against ai.google.dev 2026-09-23. gemini-2.0-flash was SHUT DOWN
# on 2026-06-01 — do not reintroduce it. Env-overridable so a model can be swapped
# without a code change (and without a redeploy mid-hackathon).
#
#   look  : single frame -> one spoken sentence. Latency-sensitive, safety-relevant.
#           3.6-flash is the one explicitly tuned for speed + multimodal.
#   lived : review text -> strict JSON, must follow the no-paraphrase rule exactly.
#           3.8-flash is the strongest current instruction-follower in the Flash tier.
MODEL_LOOK  = os.environ.get("GEMINI_MODEL_LOOK",  "gemini-3.6-flash")
MODEL_LIVED = os.environ.get("GEMINI_MODEL_LIVED", "gemini-3.8-flash")
#   speak : dynamic text -> spoken audio. Predictable lines are pre-synthesised at
#           build time (pipeline/synth_speech.py) and played from disk; this endpoint
#           is only for text that could not be known in advance.
MODEL_TTS   = os.environ.get("GEMINI_MODEL_TTS",   "gemini-3.1-flash-tts-preview")
TTS_VOICE   = os.environ.get("GEMINI_TTS_VOICE",   "Kore")

app = FastAPI(title="Doorway")
from server import upstream
from server.surface import router as surface_router
from server.route import router as route_router
from server.approach import router as approach_router

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DATA = None
def data():
    global DATA
    if DATA is None:
        with open("data/berlin-mitte.json") as f:
            DATA = json.load(f)
    return DATA


async def gemini_post(model: str, body: dict, *, timeout: float = 20, tries: int = 3):
    """POST to Gemini, riding out the 429s this tier hands out on a busy minute.

    Vision has no fallback: when /api/look or /api/door-fix gives up, a blind user
    gets silence, and silence is indistinguishable from a crash to someone who cannot
    see the screen. Delegates to server/upstream.py, which retries 429/5xx, answers 503
    naming GEMINI_API_KEY when it is missing, and records the outcome for /api/health.
    """
    return await upstream.gemini(model, body, timeout=timeout, tries=tries)


# /api/route lives in server/route.py and calls the Routes API itself; its outcome is
# recorded here from the response status, so health covers routing without touching it.
@app.middleware("http")
async def _record_route_outcome(request, call_next):
    is_route = request.url.path == "/api/route" and request.method == "POST"
    try:
        resp = await call_next(request)
    except Exception:
        if is_route:
            upstream.record_error("routes", "/api/route crashed")
        raise
    if is_route:
        if resp.status_code == 200:
            upstream.record_ok("routes")
        elif resp.status_code >= 500:
            upstream.record_error("routes", f"/api/route answered {resp.status_code}")
    return resp


@app.get("/api/health")
def health():
    """Server up is not the same as features working. `gemini` and `maps` are false
    when the key is missing OR the last call to that service failed within the last
    few minutes; `deps` says which and why, so the app can tell the user."""
    d = data()
    deps = upstream.status()
    return {"ok": True, "counts": d["meta"]["counts"],
            "gemini": deps["gemini"]["ok"],
            # "maps" is what the banner reads as "routes work": the Routes call is
            # healthy and the Maps key is there. A Places hiccup shows in deps.maps only.
            "maps": deps["routes"]["ok"] and deps["maps"]["key"],
            "deps": deps,
            "models": {"look": MODEL_LOOK, "lived": MODEL_LIVED,
                       "tts": MODEL_TTS, "voice": TTS_VOICE}}


@app.get("/api/live-url")
def live_url():
    """The public HTTPS address this machine is currently reachable on.

    The tunnel hands out a new subdomain on every reconnect, which leaves the
    installed iOS app pointing at a dead host. The app asks this over the LAN at
    launch and follows whatever it says, so a reconnect costs nothing.
    """
    url = ""
    for path in _TUNNEL_URL_FILES:
        try:
            with open(path, encoding="utf-8") as fh:
                url = fh.read().strip()
            break
        except OSError:
            continue
    return {"url": url if _is_tunnel_url(url) else None}


# ops/tunnel.sh writes here with umask 077. /tmp/tunnel-url.txt is only a migration
# fallback for an old tunnel.sh still running: /tmp is world-writable, which is why
# whatever comes out of either file is validated before the app is told to load it.
_TUNNEL_URL_FILES = (
    os.path.expanduser("~/Library/Application Support/doorway/tunnel-url"),
    "/tmp/tunnel-url.txt",
)
_TUNNEL_SUFFIX = ".serveousercontent.com"


def _is_tunnel_url(url: str) -> bool:
    """Only an https serveo address, no userinfo/port tricks."""
    from urllib.parse import urlsplit
    try:
        u = urlsplit(url)
        host = (u.hostname or "").lower().rstrip(".")
        return (u.scheme == "https" and not u.username and not u.password
                and u.port in (None, 443) and host.endswith(_TUNNEL_SUFFIX))
    except ValueError:
        return False


@app.get("/api/entrances")
def entrances(south: float, west: float, north: float, east: float):
    d = data()
    hits = [e for e in d["entrances"] if south <= e["lat"] <= north and west <= e["lon"] <= east]
    ids  = {e["buildingId"] for e in hits if e["buildingId"]}
    return {"meta": d["meta"], "entrances": hits,
            "buildings": [b for b in d["buildings"] if b["id"] in ids]}


class LookReq(BaseModel):
    frame: str                    # base64 jpeg
    heading: float
    distanceM: float
    target: str

@app.post("/api/look")
async def look(req: LookReq):
    """Opt-in single-frame description. NEVER called from the render loop."""
    upstream.require("gemini")
    prompt = (
        f"You are helping a partially-blind person find a building entrance.\n"
        f"They are about {req.distanceM:.0f} metres away, facing {req.heading:.0f} degrees.\n"
        f"They are looking for: {req.target}.\n\n"
        "Describe in ONE short spoken sentence where that entrance is relative to them "
        "(left / ahead / right, roughly how far). Plain language, no lists, no preamble.\n"
        "If you cannot see an entrance matching that description, say exactly: "
        "'I can't make out the entrance from here.' Do not guess. A wrong direction "
        "can walk someone into traffic."
    )
    body = {"contents": [{"parts": [
        {"text": prompt},
        {"inline_data": {"mime_type": "image/jpeg", "data": req.frame}}]}],
        "generationConfig": {
            "temperature": 0.0,
            # Gemini 3.x reasons by default and thinking tokens are charged against
            # maxOutputTokens, so a small cap silently truncates the sentence
            # ("I can'" instead of "I can't make out the entrance from here").
            # This call wants speed, not reasoning: budget 0, and enough room to speak.
            "thinkingConfig": {"thinkingBudget": 0},
            "maxOutputTokens": 256,
        }}
    r = await gemini_post(MODEL_LOOK, body)
    if r.status_code != 200:
        raise HTTPException(502, f"gemini {r.status_code}")
    try:
        say = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError):
        say = "I can't make out the entrance from here."
    return {"say": say}


# /api/ask: a spoken question about the door the user is heading to. The client answers
# the common questions (steps, door, distance) from its own data first; only the rest
# comes here. Facts in, one or two German sentences out. Nothing may be invented.
ASK_MAX_Q = 300
ASK_MAX_FRAME = 1_500_000        # base64 chars, about a 1.1 MB jpeg; the client sends ~768 px
ASK_FACT_KEYS = {"name", "kind", "stepFree", "door", "automatic", "level",
                 "approachBearing", "description", "warnings", "confidence"}
ASK_FALLBACK = "Das weiß ich leider nicht."

class AskReq(BaseModel):
    question: str
    facts: dict = {}
    distanceM: Optional[float] = None
    heading: Optional[float] = None
    frame: Optional[str] = None


def ask_facts(raw: dict) -> dict:
    """Keep only known keys with small scalar values (or short string lists)."""
    out = {}
    for k, v in (raw or {}).items():
        if k not in ASK_FACT_KEYS:
            continue
        if v is None or isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, str):
            out[k] = v.strip()[:200]
        elif isinstance(v, list):
            out[k] = [str(x)[:60] for x in v[:6] if isinstance(x, (str, int, float))]
    return out


def ask_prompt(question: str, facts: dict, distance_m, heading, has_frame: bool) -> str:
    step = facts.get("stepFree")
    step_txt = "ja" if step is True else "nein" if step is False else "unbekannt"
    lines = [
        "Du hilfst einer blinden, sehbehinderten oder Rollstuhl fahrenden Person, einen Gebäudeeingang zu finden.",
        "Antworte auf Deutsch in EINEM oder ZWEI kurzen gesprochenen Sätzen. Keine Listen, keine Einleitung.",
        "Nutze NUR die folgenden Fakten" + (" und das Bild." if has_frame else "."),
        "Gib keine Wegbeschreibung, außer sie ist im Bild eindeutig zu sehen.",
        "Wenn du etwas nicht sicher weißt, sag, dass du es nicht weißt. Erfinde nichts.",
        "",
        "Fakten zum Eingang (unbekannt heißt: wir wissen es nicht):",
        f"- Name: {facts.get('name') or 'unbekannt'}",
        f"- Stufenlos: {step_txt}",
        f"- Tür: {facts.get('door') or 'unbekannt'}" + (", automatisch" if facts.get("automatic") is True else ""),
        f"- Warnungen: {', '.join(facts.get('warnings') or []) or 'keine bekannt'}",
    ]
    if facts.get("description"):
        lines.append(f"- Beschreibung: {facts['description']}")
    if distance_m is not None:
        lines.append(f"- Entfernung: etwa {max(0, distance_m):.0f} Meter")
    if heading is not None:
        lines.append(f"- Blickrichtung der Person: {heading % 360:.0f} Grad")
    lines += ["", f"Frage: {question}"]
    return "\n".join(lines)


@app.post("/api/ask")
async def ask(req: AskReq):
    """Spoken question about one door. Opt-in, from the Fragen button only."""
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(422, "empty question")
    q = q[:ASK_MAX_Q]
    if req.frame is not None and len(req.frame) > ASK_MAX_FRAME:
        raise HTTPException(413, "frame too large")
    upstream.require("gemini")
    facts = ask_facts(req.facts)
    parts = [{"text": ask_prompt(q, facts, req.distanceM, req.heading, bool(req.frame))}]
    if req.frame:
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": req.frame}})
    body = {"contents": [{"parts": parts}],
            "generationConfig": {"temperature": 0.0,
                                 "thinkingConfig": {"thinkingBudget": 0},
                                 "maxOutputTokens": 256}}
    r = await gemini_post(MODEL_LOOK, body)
    if r.status_code != 200:
        raise HTTPException(502, f"gemini {r.status_code}")
    try:
        say = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, ValueError):
        say = ""
    return {"say": say or ASK_FALLBACK}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


@app.get("/api/lived/{place_id}")
async def lived(place_id: str):
    """Tier 3. Live only, never persisted. See docs/CONTRACT.md."""
    maps_key = upstream.require("maps")
    upstream.require("gemini")

    pr = await upstream.request(
        "maps", "GET", f"https://places.googleapis.com/v1/places/{place_id}",
        headers={"X-Goog-Api-Key": maps_key, "X-Goog-FieldMask": "reviews,displayName"})
    # An unknown place id honestly has no claims. A refused key, quota or outage is not
    # "nobody mentioned access" and must not be rendered as that.
    if pr.status_code in (400, 404):
        return {"placeId": place_id, "claims": []}
    if pr.status_code != 200:
        raise HTTPException(502, f"places {pr.status_code}")
    reviews = pr.json().get("reviews", []) or []
    corpus = [{"text": (rv.get("text") or {}).get("text", ""),
               "when": rv.get("relativePublishTimeDescription", "")} for rv in reviews]
    corpus = [r for r in corpus if r["text"]]
    if not corpus:
        return {"placeId": place_id, "claims": []}

    prompt = (
        "Below are reviews of a place. Extract ONLY first-hand statements about "
        "PHYSICAL ACCESS: getting into the building, and moving through it.\n\n"
        "In scope: entrances, which door to use, ramps, steps, stairs, doors, lifts, "
        "escalators (including broken ones), level changes, accessible toilets, step-free "
        "routes, and anything a wheelchair user, a blind person or someone with a pram "
        "would need to know before arriving.\n"
        "Out of scope: food, staff, prices, cleanliness, architecture, crowds, trains.\n\n"
        "Rules:\n"
        "- Every claim MUST include `quote`: text copied EXACTLY, character for character, "
        "from a review below. Never paraphrase, never repair grammar, never trim mid-word.\n"
        "- `topic` must be one of: entrance, door, steps, ramp, lift, escalator, toilet, "
        "step-free-route.\n"
        "- `blocksAccess` is true only when the reviewer describes something that would "
        "stop or seriously hinder a disabled person, false when it is merely informative.\n"
        "- If nothing in the reviews is about physical access, return {\"claims\": []}. "
        "That is the correct answer and it is common.\n"
        "- Never invent a location, address, direction or detail not in the text.\n"
        'Return JSON only: {"claims":[{"quote":"...","topic":"...","blocksAccess":true|false}]}\n\n'
        + json.dumps(corpus, ensure_ascii=False))

    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"}}
    gr = await gemini_post(MODEL_LIVED, body, timeout=25)
    if gr.status_code != 200:
        raise HTTPException(502, f"gemini {gr.status_code}")
    try:
        parsed = json.loads(gr.json()["candidates"][0]["content"]["parts"][0]["text"])
    except Exception:
        return {"placeId": place_id, "claims": []}

    # ---- anti-hallucination enforced in CODE, not by prompt ----
    # A quote survives only if it literally appears in a source review.
    haystack = _norm(" || ".join(r["text"] for r in corpus))
    out = []
    for cl in parsed.get("claims", [])[:5]:
        q = (cl.get("quote") or "").strip()
        if len(q) < 12:
            continue
        if _norm(q) not in haystack:        # model invented or paraphrased it -> drop
            continue
        when = next((r["when"] for r in corpus if _norm(q) in _norm(r["text"])), "")
        out.append({"quote": q,
                    "author": f"Google review{', ' + when if when else ''}",
                    "topic": cl.get("topic", "step-free-route"),
                    "blocksAccess": bool(cl.get("blocksAccess")),
                    "coords": None})          # tier 3 never carries coordinates
    return {"placeId": place_id, "claims": out}


class SpeakReq(BaseModel):
    text: str
    lang: str = "de"


# Route instructions are new text with no pre-made clip, so they would hit Gemini on
# every turn and get rate-limited. They also repeat constantly ("Links abbiegen auf
# Invalidenstrasse"), so a small cache removes almost all of that traffic.
_SPEAK_CACHE: "OrderedDict[str, bytes]" = OrderedDict()
_SPEAK_CACHE_MAX = 64


@app.post("/api/speak")
async def speak(req: SpeakReq):
    """Runtime TTS for text that could not be pre-synthesised.

    Everything predictable lives in data/audio/ as WAV and is played from disk with
    no network. This endpoint exists for the opt-in /api/look reply only. If it fails,
    the client MUST fall back to browser speechSynthesis — a blind user is never left
    in silence because a request timed out.
    """
    upstream.require("gemini")
    if len(req.text) > 400:
        raise HTTPException(413, "text too long for the walking loop")

    body = {"contents": [{"parts": [{"text": req.text}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": TTS_VOICE}}}}}
    key = f"{TTS_VOICE}|{req.lang}|{req.text}"
    hit = _SPEAK_CACHE.get(key)
    if hit is not None:
        _SPEAK_CACHE.move_to_end(key)
        return Response(content=hit, media_type="audio/wav",
                        headers={"Cache-Control": "public, max-age=86400"})

    # 429 is routine on this tier and is not a failure; back off rather than give up,
    # because the client falling through to speechSynthesis is a worse voice.
    r = await upstream.gemini(MODEL_TTS, body, dep="tts", backoff=1.5)
    if r.status_code != 200:
        raise HTTPException(502, f"tts {r.status_code}")
    try:
        b64 = r.json()["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    except (KeyError, IndexError):
        raise HTTPException(502, "unexpected TTS response shape")

    # Gemini returns raw PCM; a browser needs a RIFF header.
    import base64 as _b64, struct as _st
    pcm = _b64.b64decode(b64)
    rate, ch, width = 24000, 1, 2
    hdr = (b"RIFF" + _st.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
           _st.pack("<IHHIIHH", 16, 1, ch, rate, rate*ch*width, ch*width, width*8) +
           b"data" + _st.pack("<I", len(pcm)))
    wav = hdr + pcm
    _SPEAK_CACHE[key] = wav
    if len(_SPEAK_CACHE) > _SPEAK_CACHE_MAX:
        _SPEAK_CACHE.popitem(last=False)
    return Response(content=wav, media_type="audio/wav",
                    headers={"Cache-Control": "public, max-age=86400"})


# Serve the built PWA from the same origin as /api/*, so there is ONE url to open and
# no CORS in the way. Mounted last: every /api route above wins over a static path.
# DOORWAY_WEB points at web/dist; if it isn't built yet the API still runs.
app.include_router(surface_router)
app.include_router(route_router)
app.include_router(approach_router)   # /api/door-fix, /api/door-check      # POST /api/route — walking directions   # POST /api/surface — see server/surface.py

_web = os.environ.get("DOORWAY_WEB", "web/dist")
if os.path.isdir(_web):
    app.mount("/", StaticFiles(directory=_web, html=True), name="web")
