#!/usr/bin/env python3
"""One door to Google: every Gemini and Maps call goes through here.

The lesson of the "roughly this way" bug: the server came up without keys and answered
200 on every route while silently degraded. Two rules follow, enforced in one place:

  1. No key, no call. `require()` raises a 503 whose detail names the missing variable,
     so the client (and whoever reads the log) knows WHY, never a silent fallback.
  2. Every call is recorded. /api/health reports per dependency whether the key is
     there, the last upstream error and how long ago the last success was.

429 and 5xx are routine on this tier and are retried with backoff before giving up.
Keys are read from the environment at call time, never logged, never echoed back.
"""
import asyncio, os, time
from typing import Optional
import httpx
from fastapi import HTTPException

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

# dependency -> env variables that can satisfy it, in order of preference.
KEYS: dict[str, tuple[str, ...]] = {
    "gemini": ("GEMINI_API_KEY",),
    "maps":   ("MAPS_API_KEY",),
    # route.py prefers a Routes-enabled key and falls back to the Maps one.
    "routes": ("ROUTES_API_KEY", "MAPS_API_KEY"),
}

RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
# Statuses that say something about the dependency itself (bad key, quota, outage),
# as opposed to a bad request for one place id.
_UNHEALTHY = frozenset({401, 403}) | RETRY_STATUS
# An error older than this no longer marks the dependency as down.
STALE_ERROR_S = 300

_sleep = asyncio.sleep   # swapped out by server/check_upstream.py

_state: dict[str, dict] = {d: {"okAt": None, "errAt": None, "err": None} for d in KEYS}


def key(dep: str) -> str:
    for name in KEYS[dep]:
        v = os.environ.get(name, "")
        if v:
            return v
    return ""


def require(dep: str) -> str:
    """The key for `dep`, or a 503 naming the variable that is missing."""
    k = key(dep)
    if not k:
        names = " / ".join(KEYS[dep])
        record_error(dep, f"{names} not configured")
        raise HTTPException(503, f"{names} not configured")
    return k


def record_ok(dep: str) -> None:
    _state[dep]["okAt"] = time.time()


def record_error(dep: str, msg: str) -> None:
    _state[dep]["errAt"] = time.time()
    _state[dep]["err"] = msg[:200]


def record_status(dep: str, status: int) -> None:
    if 200 <= status < 300:
        record_ok(dep)
    elif status in _UNHEALTHY:
        record_error(dep, f"upstream {status}")


async def request(dep: str, method: str, url: str, *, headers: Optional[dict] = None,
                  json: Optional[dict] = None, timeout: float = 20, tries: int = 3,
                  backoff: float = 0.8) -> httpx.Response:
    """Call Google, retrying 429/5xx and network errors with exponential backoff.

    Returns the last response, whatever its status; the caller decides what a non-200
    means for its endpoint. Only when every try failed at the network level does this
    raise, as a 504 naming the dependency.
    """
    r: Optional[httpx.Response] = None
    net_err = ""
    for attempt in range(tries):
        try:
            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.request(method, url, headers=headers, json=json)
            net_err = ""
            if r.status_code not in RETRY_STATUS:
                break
        except httpx.HTTPError as e:
            r, net_err = None, type(e).__name__
        if attempt < tries - 1:
            await _sleep(backoff * (2 ** attempt))
    if r is None:
        record_error(dep, f"network {net_err}")
        raise HTTPException(504, f"{dep} unreachable ({net_err})")
    record_status(dep, r.status_code)
    return r


async def gemini(model: str, body: dict, **kw) -> httpx.Response:
    """POST generateContent. 503 when GEMINI_API_KEY is missing."""
    k = require("gemini")
    return await request("gemini", "POST", f"{GEMINI_URL}/{model}:generateContent",
                         headers={"x-goog-api-key": k}, json=body, **kw)


def status(now: Optional[float] = None) -> dict:
    """Per-dependency health for /api/health. `ok` is key present and not failing now."""
    now = now or time.time()
    out = {}
    for dep, s in _state.items():
        has_key = bool(key(dep))
        failing = (s["errAt"] is not None and now - s["errAt"] < STALE_ERROR_S
                   and (s["okAt"] is None or s["errAt"] > s["okAt"]))
        out[dep] = {
            "key": has_key,
            "keyName": next((n for n in KEYS[dep] if os.environ.get(n)), KEYS[dep][0]),
            "ok": has_key and not failing,
            "lastError": s["err"],
            "lastErrorAgeS": round(now - s["errAt"]) if s["errAt"] else None,
            "lastSuccessAgeS": round(now - s["okAt"]) if s["okAt"] else None,
        }
    return out


def reset() -> None:
    """Tests only."""
    for s in _state.values():
        s.update(okAt=None, errAt=None, err=None)
