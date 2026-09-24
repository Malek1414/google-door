#!/usr/bin/env python3
"""The last 10 metres — vision endpoints.

Two prompts, deliberately different jobs:

  /api/door-fix    blind path: where is the door, relative to the camera
  /api/door-check  wheelchair path: can I get through it

Both refuse to guess. At ten metres a hallucinated door is someone walking into a wall,
so "I cannot see it" is a first-class answer here, not a failure — the caller falls back
to the surveyed OSM bearing and says which source is talking.
"""
import base64, glob, json, os
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from server import upstream

router = APIRouter()
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


# A surveyed door can say what it looks like, so vision looks for THAT door and not
# the nearest one (at Google Berlin the main door with steps is six metres from the
# step-free one). Source: data/demo/<place>/route.json, "door.target" and an optional
# small "door.referenceImage". No entry: the prompts stay exactly as they were.
DEMO_ROUTES = "data/demo/*/route.json"
REF_MAX_BYTES = 60_000
_targets: Optional[dict] = None


def door_targets() -> dict:
    """entranceId -> {"name", "en", "de", "ref"}. Read once; a broken file is skipped."""
    global _targets
    if _targets is None:
        out = {}
        for path in sorted(glob.glob(DEMO_ROUTES)):
            try:
                with open(path, encoding="utf-8") as f:
                    d = json.load(f)
                door = d.get("door") or {}
                target = door.get("target") or {}
                eid = d.get("entranceId")
                if not isinstance(eid, str) or not isinstance(target.get("en"), str):
                    continue
                ref = None
                if isinstance(door.get("referenceImage"), str):
                    rp = os.path.join(os.path.dirname(path), door["referenceImage"])
                    if os.path.isfile(rp) and os.path.getsize(rp) <= REF_MAX_BYTES:
                        with open(rp, "rb") as f:
                            ref = base64.b64encode(f.read()).decode()
                out[eid] = {"name": d.get("entranceName"), "en": target["en"],
                            "de": target.get("de"), "ref": ref}
            except (OSError, ValueError):
                continue
        _targets = out
    return _targets


def target_for(door_id: Optional[str], text: str = "") -> Optional[dict]:
    """The surveyed description for a door, by id, or by its name inside a free-text
    target (the /api/look caller sends "entrance, named <name>" and no id)."""
    t = door_targets()
    if door_id and door_id in t:
        return t[door_id]
    for v in t.values():
        if v["name"] and v["name"] in text:
            return v
    return None


def look_target_text(door_id: Optional[str], text: str) -> str:
    """What /api/look tells the model the person is looking for."""
    t = target_for(door_id, text)
    if not t:
        return text
    return f"{text}. Surveyed on site, it is {t['en']}"


FIX_TARGET = """

THE ENTRANCE TO FIND is one specific door, surveyed on site: {target}.
Report only that door. Any other entrance in view (for example a main entrance with
steps) is NOT the target: if only another entrance is visible, return found false."""

FIX_REFERENCE = """

Two images follow. IMAGE 1 is a reference photo of the target door taken on site: use
it only to recognise the door. IMAGE 2 is the live camera. bearingDeg, distanceM and
inside are about IMAGE 2 only. If the door is not visible in IMAGE 2, return found false."""


class FrameReq(BaseModel):
    frame: str          # base64 jpeg
    headingDeg: float = 0.0
    # The door being approached (Entrance.id). Only used to look up its surveyed
    # description; unknown ids are ignored.
    doorId: Optional[str] = Field(default=None, max_length=128)


# The blind path is a live loop: the client abandons a door fix after 5 s and counts it
# as a miss. Under the upstream default (20 s per try) a hung Gemini call answered long
# after anyone was listening; each try now has to land inside the client's budget. The
# default 3 tries stay: a fast 429/503 retry (0.8 s, 1.6 s backoff) still fits in 5 s.
FIX_TIMEOUT_S = 4.5


async def _ask(prompt: str, frame_b64: str, ref_b64: Optional[str] = None, **kw) -> dict:
    parts = [{"text": prompt}]
    if ref_b64:
        parts += [{"text": "IMAGE 1 (reference photo of the target door):"},
                  {"inline_data": {"mime_type": "image/jpeg", "data": ref_b64}},
                  {"text": "IMAGE 2 (live camera):"}]
    parts.append({"inline_data": {"mime_type": "image/jpeg", "data": frame_b64}})
    body = {
        "contents": [{"parts": parts}],
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
    # 503 naming GEMINI_API_KEY when it is missing; 429/5xx retried; outcome recorded.
    r = await upstream.gemini(MODEL_FIX, body, **kw)
    if r.status_code != 200:
        raise HTTPException(502, f"gemini {r.status_code}")
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
    t = target_for(req.doorId)
    prompt, ref = FIX_PROMPT, None
    if t:
        prompt += FIX_TARGET.format(target=t["en"])
        if t["ref"]:
            prompt += FIX_REFERENCE
            ref = t["ref"]
    d = await _ask(prompt, req.frame, ref, timeout=FIX_TIMEOUT_S)
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
