#!/usr/bin/env python3
"""POST /api/surface — ground surface analysis from a walk video. Answers BRIEF-FLOOR.

Its own module rather than app.py: multipart upload, size caps and temp files are a
different shape from the JSON endpoints.

Two rules this file exists to enforce, both in code rather than by prompt:

  1. The video is deleted the moment analysis returns. People walk through station
     entrances without consenting to be filmed.
  2. Surface data may only DOWNGRADE. It can never make a door step-free, raise a tier,
     or produce an arrow. See docs/CONTRACT.md.
"""
import json, os, sys, tempfile, base64
from typing import Optional
import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

sys.path.insert(0, "pipeline")
from surface_align import align  # noqa: E402

router = APIRouter()

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("GEMINI_MODEL_SURFACE", "gemini-3.8-flash")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

MAX_BYTES = 50 * 1024 * 1024
OK_TYPES = {"video/mp4", "video/quicktime", "video/mov"}

TYPES = ["smooth", "paving", "cobblestone", "gravel", "grass", "carpet", "tiles", "metal_grate", "unknown"]
CONDITIONS = ["good", "uneven", "damaged", "wet_slippery", "unknown"]
SLOPES = ["flat", "gentle", "steep", "unknown"]
OBSTACLES = ["threshold", "step", "kerb", "narrow_passage", "door_mat", "ramp"]

PROMPT = """You are analysing a video of someone walking from the street to a building entrance.
Report the GROUND SURFACE along the way, for a wheelchair user deciding whether they can get in.

Return one segment per stretch where the surface materially changes. For each:
  t0, t1        seconds into the video
  type          one of: smooth, paving, cobblestone, gravel, grass, carpet, tiles, metal_grate, unknown
  condition     one of: good, uneven, damaged, wet_slippery, unknown
  slope         one of: flat, gentle, steep, unknown
  obstacles     any of: threshold, step, kerb, narrow_passage, door_mat, ramp
  note          one short plain sentence, in German
  confidence    0.0 to 1.0

Rules you must not break:
- IF THE FLOOR IS NOT CLEARLY VISIBLE, ANSWER unknown. Never guess a surface.
- Never report smooth unless you can actually see that it is smooth. A wrong "smooth"
  sends a wheelchair user onto ground they cannot cross.
- Only report obstacles you can see. Do not infer a kerb because a street is present.
- Cobblestone is common in Berlin and is NOT smooth, however well laid.
- summary: smooth if every segment is smooth and good; difficult if any segment is
  cobblestone, gravel, grass, damaged, steep, or has a step or kerb; mixed otherwise;
  unknown if most of the way is not visible.

Return JSON only:
{"segments":[{"t0":0,"t1":0,"type":"","condition":"","slope":"","obstacles":[],"note":"","confidence":0}],
 "summary":"smooth|mixed|difficult|unknown"}"""


def _clean(seg: dict) -> Optional[dict]:
    """Drop anything that does not validate; coerce low confidence to unknown."""
    try:
        t0, t1 = float(seg.get("t0", -1)), float(seg.get("t1", -1))
    except (TypeError, ValueError):
        return None
    if t0 < 0 or t1 < t0:
        return None
    conf = seg.get("confidence", 0)
    conf = float(conf) if isinstance(conf, (int, float)) else 0.0
    conf = min(1.0, max(0.0, conf))
    typ = seg.get("type") if seg.get("type") in TYPES else "unknown"
    # CONTRACT: below 0.6 renders as unknown, never as smooth.
    if conf < 0.6:
        typ = "unknown"
    return {
        "t0": round(t0, 2), "t1": round(t1, 2), "type": typ,
        "condition": seg.get("condition") if seg.get("condition") in CONDITIONS else "unknown",
        "slope": seg.get("slope") if seg.get("slope") in SLOPES else "unknown",
        "obstacles": [o for o in (seg.get("obstacles") or []) if o in OBSTACLES],
        "note": str(seg.get("note") or "")[:160],
        "confidence": round(conf, 2),
    }


DIFFICULT_TYPES = {"cobblestone", "gravel", "grass"}
# A step or a kerb stops a wheelchair outright.
BLOCKING_OBSTACLES = {"step", "kerb"}
# These do not stop anyone but must be mentioned, so they force "mixed" not "smooth".
MINOR_OBSTACLES = {"threshold", "door_mat", "narrow_passage"}
# A ramp is an accessibility FEATURE. It appears in the obstacle list because the model
# reports what it sees, but it must never downgrade a route.


def derive_summary(segs: list[dict]) -> str:
    if not segs or all(s["type"] == "unknown" for s in segs):
        return "unknown"
    hard = any(
        s["type"] in DIFFICULT_TYPES
        or s["condition"] in ("damaged", "wet_slippery")
        or s["slope"] == "steep"
        or BLOCKING_OBSTACLES & set(s["obstacles"])
        for s in segs
    )
    if hard:
        return "difficult"
    minor = any(MINOR_OBSTACLES & set(s["obstacles"]) for s in segs)
    if not minor and all(s["type"] == "smooth" and s["condition"] == "good" for s in segs):
        return "smooth"
    return "mixed"


@router.post("/api/surface")
async def surface(video: UploadFile = File(...), track: str = Form("")):
    if not GEMINI_KEY:
        raise HTTPException(503, "GEMINI_API_KEY not configured")
    if video.content_type not in OK_TYPES:
        raise HTTPException(415, f"expected mp4/mov, got {video.content_type}")

    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    try:
        size = 0
        while chunk := await video.read(1 << 20):
            size += len(chunk)
            if size > MAX_BYTES:
                raise HTTPException(413, "video over 50 MB")
            tmp.write(chunk)
        tmp.close()

        with open(tmp.name, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()

        body = {
            "contents": [{"parts": [
                {"text": PROMPT},
                {"inline_data": {"mime_type": "video/mp4", "data": b64}},
            ]}],
            "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"},
        }
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{GEMINI_URL}/{MODEL}:generateContent",
                             json=body, headers={"x-goog-api-key": GEMINI_KEY})
        if r.status_code != 200:
            raise HTTPException(502, f"gemini {r.status_code}")
        try:
            parsed = json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
        except Exception:
            raise HTTPException(502, "unexpected surface response shape")

        segs = [s for s in (_clean(x) for x in parsed.get("segments", [])) if s]

        pts = None
        if track:
            try:
                pts = json.loads(track)
                if not isinstance(pts, list):
                    pts = None
            except json.JSONDecodeError:
                pts = None
        segs = align(segs, pts)

        return {
            "segments": segs,
            "summary": derive_summary(segs),
            "source": "gemini_video",
            "confirmed": False,          # never true from analysis alone
        }
    finally:
        # The video goes, always — success, failure, or upload abort.
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
