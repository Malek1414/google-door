#!/usr/bin/env python3
"""Pytest-free check of the upstream rules. Run from the repo root:

    python -m server.check_upstream

No network, no real keys: Google is replaced by an httpx MockTransport.
"""
import asyncio, os, sys

# Before the app imports: fake keys only, and never the real .env.
os.environ["GEMINI_API_KEY"] = "test-gemini"
os.environ["MAPS_API_KEY"] = "test-maps"
os.environ.pop("ROUTES_API_KEY", None)

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server import upstream  # noqa: E402
from server.app import app  # noqa: E402

_real_client = httpx.AsyncClient
_replies: list = []
_calls: list = []


def _handler(req: httpx.Request) -> httpx.Response:
    _calls.append(str(req.url))
    nxt = _replies.pop(0) if _replies else 200
    if isinstance(nxt, Exception):
        raise nxt
    if nxt == 200:
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "Ahead, 5 m."}]}}]})
    return httpx.Response(nxt, json={"error": {"code": nxt, "message": f"mock {nxt}"}})


upstream.httpx.AsyncClient = lambda **kw: _real_client(transport=httpx.MockTransport(_handler), **kw)  # type: ignore
_real_sleep = asyncio.sleep
upstream._sleep = lambda s: _real_sleep(0)  # type: ignore

client = TestClient(app)
LOOK = {"frame": "AA==", "heading": 0, "distanceM": 5, "target": "Haupteingang"}
failed = 0


def check(name: str, cond: bool, extra=""):
    global failed
    print(("ok   " if cond else "FAIL ") + name + (f"  ({extra})" if extra and not cond else ""))
    failed += 0 if cond else 1


def reset(replies=()):
    upstream.reset()
    _replies[:] = list(replies)
    _calls.clear()


# 1. 429 twice, then success: retried, 200, health ok with a fresh success.
reset([429, 429, 200])
r = client.post("/api/look", json=LOOK)
check("look retries 429 and succeeds", r.status_code == 200 and len(_calls) == 3, r.text)
h = client.get("/api/health").json()
check("health gemini true after success", h["gemini"] is True and h["deps"]["gemini"]["lastSuccessAgeS"] == 0, h["deps"])

# 2. Persistent 503: gives up after 3 tries with 502, health flips to false and says why.
reset([503, 503, 503])
r = client.post("/api/look", json=LOOK)
check("look gives up with 502 after 3 tries", r.status_code == 502 and len(_calls) == 3, r.text)
h = client.get("/api/health").json()
check("health gemini false after upstream failure", h["gemini"] is False and h["deps"]["gemini"]["lastError"] == "upstream 503", h["deps"])

# 3. Network down: 504 naming the dependency.
reset([httpx.ConnectError("x")] * 3)
r = client.post("/api/door-fix", json={"frame": "AA=="})
check("door-fix network error is 504", r.status_code == 504 and "gemini" in r.text, r.text)

# 4. Missing key: 503 naming the variable, no call made, health says key false.
reset()
saved = os.environ.pop("GEMINI_API_KEY")
for path, body in (("/api/look", LOOK), ("/api/door-check", {"frame": "AA=="}), ("/api/speak", {"text": "Hallo"})):
    r = client.post(path, json=body)
    check(f"{path} 503 names GEMINI_API_KEY", r.status_code == 503 and "GEMINI_API_KEY" in r.json()["detail"], r.text)
check("no upstream call without key", _calls == [], _calls)
h = client.get("/api/health").json()
check("health reports missing gemini key", h["gemini"] is False and h["deps"]["gemini"]["key"] is False, h["deps"])
os.environ["GEMINI_API_KEY"] = saved

# 5. lived: Places 403 is an error, not "no claims".
reset([403])
r = client.get("/api/lived/abc")
check("lived places 403 is 502, not empty claims", r.status_code == 502, r.text)
h = client.get("/api/health").json()
check("health deps.maps false after places 403", h["deps"]["maps"]["ok"] is False, h["deps"]["maps"])

# 6. lived: unknown place id stays an honest empty answer.
reset([404])
r = client.get("/api/lived/nope")
check("lived places 404 is empty claims", r.status_code == 200 and r.json()["claims"] == [], r.text)

# 7. Missing maps key: lived 503 names MAPS_API_KEY.
reset()
saved = os.environ.pop("MAPS_API_KEY")
r = client.get("/api/lived/abc")
check("lived 503 names MAPS_API_KEY", r.status_code == 503 and "MAPS_API_KEY" in r.json()["detail"], r.text)
check("health maps false without key", client.get("/api/health").json()["maps"] is False)
os.environ["MAPS_API_KEY"] = saved

# 8. /api/route (server/route.py, not routed through upstream) is still seen by health.
reset([500])
r = client.post("/api/route", json={"fromLat": 52.52, "fromLon": 13.4, "toLat": 52.53, "toLon": 13.41})
h = client.get("/api/health").json()
check("route 5xx flips health maps to false", r.status_code >= 500 and h["maps"] is False, (r.status_code, h["deps"]["routes"]))

print("\n" + ("all passed" if not failed else f"{failed} FAILED"))
sys.exit(1 if failed else 0)
