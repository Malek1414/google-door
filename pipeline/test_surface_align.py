#!/usr/bin/env python3
"""Tests for the video-time -> distance join. Run: python3 pipeline/test_surface_align.py"""
import sys
sys.path.insert(0, "pipeline")
from surface_align import align, cumulative, distance_at, speakable

fails = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {got!r}" + ("" if ok else f" != {want!r}"))
    if not ok: fails.append(name)

# ~1 m/s due north, one sample per second
track = [{"t": float(i), "lat": 52.5250 + i * 0.000009, "lon": 13.3694} for i in range(31)]
cum = cumulative(track)
print("straight-line walk, 1 sample/s")
check("track length ~30 m", round(cum[-1][1]) in (30, 31), True)
check("distance at t=0", round(distance_at(cum, 0)), 0)
check("interpolates mid-sample", 9.0 < distance_at(cum, 9.5) < 11.0, True)
check("None before the track", distance_at(cum, -1), None)
check("None after the track", distance_at(cum, 99), None)

print("\nalignment")
segs = [{"t0": 3.0, "t1": 9.0, "type": "cobblestone"}, {"t0": 20.0, "t1": 28.0, "type": "smooth"}]
al = align(segs, track)
check("first segment aligned", al[0]["startM"] is not None, True)
check("segments ordered by distance", al[0]["startM"] < al[1]["startM"], True)
check("both speakable", all(speakable(s) for s in al), True)

print("\nrefuses to guess")
check("no track -> null", align(segs, None)[0]["startM"], None)
check("clock mismatch -> null", align(segs, track, clocks_match=False)[0]["startM"], None)
check("not speakable without alignment", speakable(align(segs, None)[0]), False)
gappy = [s for s in track if not (5 <= s["t"] <= 12)]   # 7 s hole
check("gap > 3s spanning the segment -> null",
      align([{"t0": 4.0, "t1": 13.0}], gappy)[0]["startM"], None)
check("segment outside the gap still aligns",
      align([{"t0": 20.0, "t1": 25.0}], gappy)[0]["startM"] is not None, True)
check("reversed times -> null", align([{"t0": 9.0, "t1": 3.0}], track)[0]["startM"], None)

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
