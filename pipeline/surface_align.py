#!/usr/bin/env python3
"""Resolve surface segments from video time to distance walked.

BRIEF-FLOOR keys segments by video timestamp. The arrow works in geography. Speaking
"cobblestones for the next twenty metres" at the right moment needs a join between the
two, and without it a segment can be shown on a card but never announced.

The recorder writes a GPS track alongside the video sharing one clock. This integrates
haversine along that track and resolves each t0/t1 to metres walked from the start.

Refusing to answer is a feature: a warning at the wrong moment is worse than none, so
anything uncertain returns null and the caller must treat the segment as card-only.
"""
import math
from typing import Optional

MAX_GAP_S = 3.0


def _hav(a, b) -> float:
    R = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def cumulative(track: list[dict]) -> list[tuple[float, float]]:
    """[(t, metresWalked)] from a track of {t, lat, lon}. t in seconds from the start."""
    out: list[tuple[float, float]] = []
    total = 0.0
    prev = None
    for s in sorted(track, key=lambda x: x["t"]):
        if prev is not None:
            total += _hav((prev["lat"], prev["lon"]), (s["lat"], s["lon"]))
        out.append((float(s["t"]), total))
        prev = s
    return out


def _gap_spans(cum: list[tuple[float, float]], t0: float, t1: float) -> bool:
    """True when a track gap longer than MAX_GAP_S falls inside [t0, t1]."""
    for (ta, _), (tb, _) in zip(cum, cum[1:]):
        if tb - ta > MAX_GAP_S and not (tb <= t0 or ta >= t1):
            return True
    return False


def distance_at(cum: list[tuple[float, float]], t: float) -> Optional[float]:
    """Metres walked at video time t, linearly interpolated. None outside the track."""
    if not cum or t < cum[0][0] or t > cum[-1][0]:
        return None
    for (ta, da), (tb, db) in zip(cum, cum[1:]):
        if ta <= t <= tb:
            if tb == ta:
                return da
            return da + (db - da) * (t - ta) / (tb - ta)
    return cum[-1][1]


def align(segments: list[dict], track: Optional[list[dict]],
          clocks_match: bool = True) -> list[dict]:
    """Add startM/endM to each segment, or null when it cannot be trusted.

    A segment with startM None is card-only: show it, never speak it.
    """
    if not track or not clocks_match:
        return [{**s, "startM": None, "endM": None} for s in segments]

    cum = cumulative(track)
    out = []
    for s in segments:
        t0, t1 = float(s.get("t0", 0)), float(s.get("t1", 0))
        if t1 < t0 or _gap_spans(cum, t0, t1):
            out.append({**s, "startM": None, "endM": None})
            continue
        a, b = distance_at(cum, t0), distance_at(cum, t1)
        out.append({**s, "startM": None if a is None else round(a, 1),
                    "endM": None if b is None else round(b, 1)})
    return out


def speakable(segment: dict) -> bool:
    """Only aligned segments may be announced in live guidance."""
    return segment.get("startM") is not None and segment.get("endM") is not None
