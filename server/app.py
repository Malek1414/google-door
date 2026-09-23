#!/usr/bin/env python3
"""Doorway backend proxy.

Exists for one reason that cannot be designed away: a QR-distributed web app cannot
hold a Gemini or Places API key. Keys live here, in the environment, never in the
bundle. Everything else the app needs is a static file.

    pip install fastapi uvicorn httpx
    GEMINI_API_KEY=... MAPS_API_KEY=... uvicorn server.app:app --port 8080
"""
import json, os, re, base64
from typing import Optional
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
MAPS_KEY   = os.environ.get("MAPS_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

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

app = FastAPI(title="Doorway")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DATA = None
def data():
    global DATA
    if DATA is None:
        with open("data/berlin-mitte.json") as f:
            DATA = json.load(f)
    return DATA


@app.get("/api/health")
def health():
    d = data()
    return {"ok": True, "counts": d["meta"]["counts"],
            "gemini": bool(GEMINI_KEY), "maps": bool(MAPS_KEY),
            "models": {"look": MODEL_LOOK, "lived": MODEL_LIVED}}


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
    if not GEMINI_KEY:
        raise HTTPException(503, "GEMINI_API_KEY not configured")
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
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 60}}
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{GEMINI_URL}/{MODEL_LOOK}:generateContent?key={GEMINI_KEY}", json=body)
    if r.status_code != 200:
        raise HTTPException(502, f"gemini {r.status_code}")
    try:
        say = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError):
        say = "I can't make out the entrance from here."
    return {"say": say}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


@app.get("/api/lived/{place_id}")
async def lived(place_id: str):
    """Tier 3. Live only, never persisted. See docs/CONTRACT.md."""
    if not (GEMINI_KEY and MAPS_KEY):
        raise HTTPException(503, "keys not configured")

    async with httpx.AsyncClient(timeout=20) as c:
        pr = await c.get(
            f"https://places.googleapis.com/v1/places/{place_id}",
            headers={"X-Goog-Api-Key": MAPS_KEY,
                     "X-Goog-FieldMask": "reviews,displayName"})
    if pr.status_code != 200:
        return {"placeId": place_id, "claims": []}
    reviews = pr.json().get("reviews", []) or []
    corpus = [{"text": (rv.get("text") or {}).get("text", ""),
               "when": rv.get("relativePublishTimeDescription", "")} for rv in reviews]
    corpus = [r for r in corpus if r["text"]]
    if not corpus:
        return {"placeId": place_id, "claims": []}

    prompt = (
        "Below are reviews of a place. Extract ONLY first-hand statements about "
        "physically getting INTO the building: entrances, ramps, steps, doors, lifts.\n\n"
        "Rules:\n"
        "- Every claim MUST include `quote`: text copied EXACTLY, character for "
        "character, from a review below. Never paraphrase.\n"
        "- If nothing in the reviews is about entering the building, return "
        '{\"claims\": []}. That is the correct answer and it is common.\n'
        "- Never invent a location, address, or direction.\n"
        'Return JSON only: {"claims":[{"quote":"...","topic":"step-free-route|door|steps|lift"}]}\n\n'
        + json.dumps(corpus, ensure_ascii=False))

    body = {"contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"}}
    async with httpx.AsyncClient(timeout=25) as c:
        gr = await c.post(f"{GEMINI_URL}/{MODEL_LIVED}:generateContent?key={GEMINI_KEY}", json=body)
    if gr.status_code != 200:
        return {"placeId": place_id, "claims": []}
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
                    "coords": None})          # tier 3 never carries coordinates
    return {"placeId": place_id, "claims": out}
