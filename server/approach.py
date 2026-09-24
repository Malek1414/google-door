#!/usr/bin/env python3
"""The last 10 metres — vision endpoints.

Two prompts, deliberately different jobs:

  /api/door-fix    blind path: where is the door, relative to the camera
  /api/door-check  wheelchair path: can I get through it

Both refuse to guess. At ten metres a hallucinated door is someone walking into a wall,
so "I cannot see it" is a first-class answer here, not a failure — the caller falls back
to the surveyed OSM bearing and says which source is talking.
"""
import base64, json, os
from typing import Optional
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"
MODEL_FIX = os.environ.get("GEMINI_MODEL_DOORFIX", "gemini-3.6-flash")

FIX_PROMPT = """You are looking through the camera of a blind person standing outside a
building, a few metres from an entrance they are trying to reach.

Report where the entrance is RELATIVE TO THE CENTRE OF THIS IMAGE.

  bearingDeg   degrees from the centre of frame. NEGATIVE = left, positive = right.
               The camera sees about 70 degrees across, so the left edge is about -35
               and the right edge about +35. A door outside the frame cannot be seen:
               say found false.
  distanceM    rough metres to the entrance.
  kind         sliding | hinged | revolving | opening | unknown
  note         one short German phrase naming what you see, e.g. "Glastür links neben
               der Treppe". Only what is visible.
  inside       true only if this photo was clearly taken INDOORS — a ceiling overhead,
               no sky, interior lighting, the entrance now behind the camera. When in
               any doubt, false. This ends the guidance, so a wrong true abandons
               someone on the pavement.
  confidence   0.0 to 1.0.

Rules you must not break:
- IF YOU CANNOT SEE AN ENTRANCE, return found false. Do not infer one from a wall, a
  window, a sign or the shape of the building. A wrong direction walks a blind person
  into traffic.
- Do not report a door you can only partly see at the very edge of frame.
- Never mention people, vehicles, steps, obstacles or hazards. Another part of the app
  is responsible for saying this feature does not do that, and a half-warning here
  would invite someone to stop using their cane.

Return JSON only:
{"found":true,"bearingDeg":0,"distanceM":0,"kind":"unknown","note":"","inside":false,"confidence":0}"""

CHECK_PROMPT = """You are looking through the camera of a wheelchair user who has
reached an entrance. They can see the door. They need to know whether they can get
through it.

  step         true | false | null   a step, lip or raised threshold at the door
  widthCm      approximate clear width in cm, or null
  opens        automatic | push | pull | revolving | none | unknown
  note         one short German phrase, only what is visible

Rules:
- null and "unknown" are correct answers. Anything you are not sure of MUST be null or
  unknown — never a guess. A wrong "no step" sends someone to a door they cannot enter.
- Judge width only if the frame lets you. Otherwise null.
- Say nothing about people, ramps elsewhere, or other entrances.

Return JSON only:
{"step":null,"widthCm":null,"opens":"unknown","note":"","confidence":0}"""


class FrameReq(BaseModel):
    frame: str          # base64 jpeg
    headingDeg: float = 0.0


async def _ask(prompt: str, frame_b64: str) -> dict:
    if not GEMINI_KEY:
        raise HTTPException(503, "GEMINI_API_KEY not configured")
    body = {
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/jpeg", "data": frame_b64}},
        ]}],
        "generationConfig": {
            "temperature": 0.0,
            # Gemini 3.x reasons by default and thinking is charged against
            # maxOutputTokens; this call wants speed, and a truncated JSON body is
            # indistinguishable from a refusal.
            "thinkingConfig": {"thinkingBudget": 0},
            "responseMimeType": "application/json",
            "maxOutputTokens": 512,
        },
    }
    from server.app import gemini_post
    r = await gemini_post(MODEL_FIX, body)
    if r is None or r.status_code != 200:
        raise HTTPException(502, f"gemini {r.status_code if r else 'no response'}")
    try:
        return json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
    except Exception:
        raise HTTPException(502, "unexpected vision response shape")


def _num(v, lo: float, hi: float) -> Optional[float]:
    if not isinstance(v, (int, float)):
        return None
    f = float(v)
    if f != f:  # NaN
        return None
    return max(lo, min(hi, f))


KINDS = {"sliding", "hinged", "revolving", "opening", "unknown"}
OPENS = {"automatic", "push", "pull", "revolving", "none", "unknown"}


@router.post("/api/door-fix")
async def door_fix(req: FrameReq):
    """Blind path. Bearing is relative to the camera centre, never a compass heading:
    the model sees a picture, not a heading, and converting here would hide that."""
    d = await _ask(FIX_PROMPT, req.frame)
    conf = _num(d.get("confidence"), 0.0, 1.0) or 0.0
    bearing = _num(d.get("bearingDeg"), -60.0, 60.0)
    dist = _num(d.get("distanceM"), 0.0, 60.0)

    # Enforced in code, not by prompt: a fix missing its numbers is not a fix.
    found = bool(d.get("found")) and bearing is not None and dist is not None and conf >= 0.5
    return {
        "found": found,
        "bearingDeg": bearing if found else None,
        "distanceM": dist if found else None,
        "confidence": conf,
        "kind": d.get("kind") if d.get("kind") in KINDS else "unknown",
        "note": str(d.get("note") or "")[:120] if found else None,
        # Ends the guidance, so it must be an explicit true at real confidence — an
        # absent or hedged value is "still outside", never "probably inside".
        "inside": bool(d.get("inside")) and conf >= 0.6,
        "source": "gemini-frame",
    }


@router.post("/api/door-check")
async def door_check(req: FrameReq):
    """Wheelchair path. Unsure is rendered as unknown, never as a guess."""
    d = await _ask(CHECK_PROMPT, req.frame)
    conf = _num(d.get("confidence"), 0.0, 1.0) or 0.0
    step = d.get("step")
    width = _num(d.get("widthCm"), 40.0, 250.0)
    # Below this the model is not confident enough for a wheelchair user to act on.
    if conf < 0.5:
        step, width = None, None
    return {
        "step": step if isinstance(step, bool) else None,
        "widthCm": round(width) if width is not None else None,
        "opens": d.get("opens") if d.get("opens") in OPENS else "unknown",
        "note": str(d.get("note") or "")[:120],
        "confidence": conf,
    }
