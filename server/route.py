#!/usr/bin/env python3
"""POST /api/route — walking directions to a door.

Guidance was a straight-line bearing to the entrance, which points through buildings,
across tracks, and understates the walk. For the Hauptbahnhof test door that is 88 m of
pavement reported as ~50 m of nothing, with a left turn omitted entirely.

This proxies the Routes API so the Maps key stays on the server, and returns only what
the guidance loop needs: the decoded path, the steps, and their maneuvers.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server import upstream

router = APIRouter()
# The Routes API only takes classic API keys (AIza...). An AQ. key (the Gemini kind)
# gets a 401 "API keys are not supported by this API", which is what silently turned
# every route into a grey straight line. ROUTES_API_KEY lets the server use a Maps key
# with the Routes API enabled even when MAPS_API_KEY holds something else.
# The key is read per request through server/upstream.py (dependency "routes":
# ROUTES_API_KEY, then MAPS_API_KEY), which also retries 429/5xx with backoff.
ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELDS = (
    "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,"
    "routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,"
    "routes.legs.steps.startLocation,routes.legs.steps.endLocation"
)


def decode_polyline(enc: str) -> list[list[float]]:
    """Google's encoded polyline -> [[lat, lon], ...]. Decoded here so the client does
    not have to, and so a malformed string fails on the server rather than in the
    render loop."""
    pts: list[list[float]] = []
    lat = lon = idx = 0
    while idx < len(enc):
        for target in ("lat", "lon"):
            shift = result = 0
            while True:
                if idx >= len(enc):
                    return pts
                b = ord(enc[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if target == "lat":
                lat += delta
            else:
                lon += delta
        pts.append([lat / 1e5, lon / 1e5])
    return pts


class RouteReq(BaseModel):
    fromLat: float
    fromLon: float
    toLat: float
    toLon: float
    lang: str = "de-DE"


@router.post("/api/route")
async def route(req: RouteReq):
    key = upstream.key("routes")
    if not key:
        upstream.record_error("routes", "ROUTES_API_KEY / MAPS_API_KEY not configured")
        raise HTTPException(503, {"code": "not_configured", "message": "ROUTES_API_KEY / MAPS_API_KEY not configured"})
    body = {
        "origin": {"location": {"latLng": {"latitude": req.fromLat, "longitude": req.fromLon}}},
        "destination": {"location": {"latLng": {"latitude": req.toLat, "longitude": req.toLon}}},
        # WALK, always. A wheelchair user is not being sent down a slip road.
        "travelMode": "WALK",
        "languageCode": req.lang,
        "units": "METRIC",
    }
    try:
        r = await upstream.request("routes", "POST", ROUTES_URL, json=body,
                                   headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS})
    except HTTPException:
        # upstream raises 504 only after every try failed at the network level.
        raise HTTPException(504, {"code": "network", "message": "Routes API unreachable"})
    if r.status_code != 200:
        # Say WHY, so the client can tell "key cannot call Routes" from "no path".
        # Google's message names the problem and never contains the key.
        try:
            reason = (r.json().get("error") or {}).get("message", "")
        except ValueError:
            reason = ""
        code = "auth" if r.status_code in (401, 403) else "quota" if r.status_code == 429 else "upstream"
        raise HTTPException(502, {"code": code, "status": r.status_code, "message": reason[:200]})
    data = r.json()
    routes = data.get("routes") or []
    if not routes:
        # No walkable route is a real answer: the caller falls back to straight-line
        # bearing and says so, rather than inventing a path.
        return {"found": False, "path": [], "steps": [], "distanceM": None}

    top = routes[0]
    path = decode_polyline((top.get("polyline") or {}).get("encodedPolyline", ""))
    steps = []
    for leg in top.get("legs", []):
        for s in leg.get("steps", []):
            ni = s.get("navigationInstruction") or {}
            end = (s.get("endLocation") or {}).get("latLng") or {}
            steps.append({
                "distanceM": s.get("distanceMeters"),
                "maneuver": ni.get("maneuver"),
                "text": ni.get("instructions"),
                "endLat": end.get("latitude"),
                "endLon": end.get("longitude"),
            })
    return {
        "found": True,
        "distanceM": top.get("distanceMeters"),
        "duration": top.get("duration"),
        "path": path,
        "steps": steps,
    }
