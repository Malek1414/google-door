#!/usr/bin/env python3
"""Surface summary rules. Run: python3 pipeline/test_surface_summary.py"""
import sys
sys.path.insert(0, "."); sys.path.insert(0, "pipeline")
from server.surface import derive_summary, _clean

CASES = [
    ("all smooth and good", [{"type":"smooth","condition":"good","slope":"flat","obstacles":[]}], "smooth"),
    ("a gentle ramp is a feature, not a barrier", [{"type":"smooth","condition":"good","slope":"gentle","obstacles":["ramp"]}], "smooth"),
    ("a threshold must be mentioned", [{"type":"smooth","condition":"good","slope":"flat","obstacles":["threshold"]}], "mixed"),
    ("a door mat must be mentioned", [{"type":"smooth","condition":"good","slope":"flat","obstacles":["door_mat"]}], "mixed"),
    ("a narrow passage must be mentioned", [{"type":"smooth","condition":"good","slope":"flat","obstacles":["narrow_passage"]}], "mixed"),
    ("cobblestone is never smooth, however well laid", [{"type":"cobblestone","condition":"good","slope":"flat","obstacles":[]}], "difficult"),
    ("gravel", [{"type":"gravel","condition":"good","slope":"flat","obstacles":[]}], "difficult"),
    ("a kerb stops a wheelchair", [{"type":"smooth","condition":"good","slope":"flat","obstacles":["kerb"]}], "difficult"),
    ("a step stops a wheelchair", [{"type":"smooth","condition":"good","slope":"flat","obstacles":["step"]}], "difficult"),
    ("a steep slope", [{"type":"smooth","condition":"good","slope":"steep","obstacles":[]}], "difficult"),
    ("wet and slippery", [{"type":"tiles","condition":"wet_slippery","slope":"flat","obstacles":[]}], "difficult"),
    ("damaged surface", [{"type":"paving","condition":"damaged","slope":"flat","obstacles":[]}], "difficult"),
    ("floor not visible", [{"type":"unknown","condition":"unknown","slope":"unknown","obstacles":[]}], "unknown"),
    ("no segments at all", [], "unknown"),
    ("one bad stretch condemns the route", [
        {"type":"smooth","condition":"good","slope":"flat","obstacles":[]},
        {"type":"cobblestone","condition":"uneven","slope":"flat","obstacles":[]}], "difficult"),
]

fails = []
for name, segs, want in CASES:
    got = derive_summary(segs)
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {got}" + ("" if ok else f" (want {want})"))
    if not ok: fails.append(name)

print("\n  validation")
checks = [
    ("confidence below 0.6 is never smooth", _clean({"t0":1,"t1":5,"type":"smooth","confidence":0.4})["type"], "unknown"),
    ("confidence at 0.6 is kept", _clean({"t0":1,"t1":5,"type":"smooth","confidence":0.6})["type"], "smooth"),
    ("reversed timestamps are dropped", _clean({"t0":9,"t1":3}), None),
    ("negative start is dropped", _clean({"t0":-1,"t1":3}), None),
    ("invented obstacles are dropped", _clean({"t0":1,"t1":5,"obstacles":["lava"]})["obstacles"], []),
    ("invented type falls back to unknown", _clean({"t0":1,"t1":5,"type":"marble","confidence":0.9})["type"], "unknown"),
    ("confidence is clamped", _clean({"t0":1,"t1":5,"confidence":5})["confidence"], 1.0),
]
for name, got, want in checks:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {got!r}" + ("" if ok else f" (want {want!r})"))
    if not ok: fails.append(name)

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
