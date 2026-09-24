#!/usr/bin/env python3
"""GET /api/arcore-token: a short-lived OAuth token for the ARCore Geospatial API.

The iOS app's native Live View (ios/Doorway/Sources/ArLiveView*.swift) needs to
authenticate against the ARCore API. Keyless auth is the primary path: the server holds
a service account (JSON file path in ARCORE_SERVICE_ACCOUNT, never in the repo), mints an
access token for the ARCore scope from it, and the app hands that token to GARSession.
The token expires within the hour, so nothing long-lived ever reaches a phone.

Rules this module keeps:
  * The token is never logged, not even in part. Errors log the exception type only.
  * One token is cached until shortly before it expires; every phone shares it.
  * A simple per-client rate limit, so the endpoint cannot be used to hammer Google.
  * Without a configured service account the answer is a clean 503 naming the setup
    gap in German, which the app treats as "ARCore unavailable" and falls back to the
    web Live View.
"""
import asyncio
import calendar
import logging
import os
import time
from collections import deque
from typing import Deque, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

router = APIRouter()
log = logging.getLogger("doorway.arcore")

SCOPE = "https://www.googleapis.com/auth/arcore"
ENV = "ARCORE_SERVICE_ACCOUNT"
NOT_CONFIGURED = "ARCore nicht eingerichtet"
UNAVAILABLE = "ARCore-Token gerade nicht verfügbar"

# Refresh this long before Google's expiry, so a phone never receives a token that dies
# mid-walk. The app refreshes again itself before `expiresIn` runs out.
REFRESH_MARGIN_S = 300
# Per client address: this many requests per window. A phone asks once per Live View plus
# one refresh roughly every 50 minutes. Behind the tunnel every phone shares one address,
# so the limit is set for a room full of them, not for one.
RATE_LIMIT = 30
RATE_WINDOW_S = 60.0
# Bound on remembered clients, so the limiter itself cannot grow without end.
MAX_CLIENTS = 2048

_cache: Dict[str, object] = {"token": None, "expiry": 0.0}
_lock: Optional[asyncio.Lock] = None  # created on first use, inside the running loop
_hits: Dict[str, Deque[float]] = {}


def _load_credentials():
    """Service account credentials for the ARCore scope, or None when not set up."""
    path = os.environ.get(ENV, "").strip()
    if not path or not os.path.isfile(path):
        return None
    # Imported here so the rest of the server runs without google-auth installed.
    from google.oauth2 import service_account

    return service_account.Credentials.from_service_account_file(path, scopes=[SCOPE])


def _mint() -> Optional[Tuple[str, float]]:
    """Blocking: refresh a service-account token. Returns (token, expiry epoch) or None."""
    creds = _load_credentials()
    if creds is None:
        return None
    from google.auth.transport.requests import Request as GoogleRequest

    creds.refresh(GoogleRequest())
    # google-auth reports expiry as a naive UTC datetime.
    expiry = float(calendar.timegm(creds.expiry.utctimetuple())) if creds.expiry else time.time() + 3600
    return creds.token, expiry


def _rate_limited(client: str, now: float) -> bool:
    q = _hits.get(client)
    if q is None:
        if len(_hits) >= MAX_CLIENTS:
            _hits.clear()
        q = _hits[client] = deque()
    while q and now - q[0] > RATE_WINDOW_S:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        return True
    q.append(now)
    return False


def reset() -> None:
    """Forget the cached token and the rate limiter (tests)."""
    _cache["token"] = None
    _cache["expiry"] = 0.0
    _hits.clear()


@router.get("/api/arcore-token")
async def arcore_token(request: Request, response: Response):
    now = time.time()
    client = request.client.host if request.client else "?"
    if _rate_limited(client, now):
        raise HTTPException(429, "Zu viele Anfragen")
    response.headers["Cache-Control"] = "no-store"

    if not os.environ.get(ENV, "").strip():
        raise HTTPException(503, NOT_CONFIGURED)

    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:
        token = _cache["token"]
        expiry = float(_cache["expiry"])  # type: ignore[arg-type]
        if not token or expiry - now <= REFRESH_MARGIN_S:
            try:
                minted = await run_in_threadpool(_mint)
            except Exception as exc:  # never include the message: it may echo credentials
                log.error("arcore token refresh failed: %s", type(exc).__name__)
                raise HTTPException(502, UNAVAILABLE)
            if minted is None:
                raise HTTPException(503, NOT_CONFIGURED)
            token, expiry = minted
            _cache["token"], _cache["expiry"] = token, expiry

    return {"token": token, "expiresIn": max(0, int(expiry - now))}
