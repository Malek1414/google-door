#!/usr/bin/env python3
"""Tiled OSM entrance ingest for Berlin Mitte -> docs/CONTRACT.md schema.

Two passes, because the obvious single query does not survive contact with Overpass:

  pass 1  flat entrance-node query per tile. Seconds.
  pass 2  building geometry ONLY for doors that carry a wheelchair verdict.
          ~140 doors, not ~2700. Geometry is only needed to compute the approach
          bearing, and we only ever route to tier-1 doors anyway.

Joining every entrance to its parent building in one query 504s on every mirror.
"""
import json, math, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

BBOX    = (52.505, 13.360, 52.540, 13.425)   # S, W, N, E  — Berlin Mitte
GRID    = 1   # pass 1 is a flat node query; the whole bbox returns in seconds
MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter"]
OUT     = "data/berlin-mitte.json"
DOOR_WARN = {"revolving": "revolving"}


def overpass(q, tries=2):
    last = None
    for mirror in MIRRORS:
        for attempt in range(tries):
            try:
                req = urllib.request.Request(
                    mirror, data=urllib.parse.urlencode({"data": q}).encode(),
                    headers={"User-Agent": "Doorway/1.0 (hackathon; accessibility)"})
                with urllib.request.urlopen(req, timeout=75) as r:
                    return json.load(r)["elements"]
            except Exception as e:
                last = e
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"overpass exhausted: {last}")


def tiles(bbox, n):
    s, w, nn, e = bbox
    dy, dx = (nn - s) / n, (e - w) / n
    return [(s + i*dy, w + j*dx, s + (i+1)*dy, w + (j+1)*dx)
            for i in range(n) for j in range(n)]


def bearing(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dl = lo2 - lo1
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1)*math.sin(la2) - math.sin(la1)*math.cos(la2)*math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def approach_bearing(node, ring):
    """Compass bearing you FACE when walking into the door (outward normal + 180)."""
    if not ring or len(ring) < 3:
        return None
    idx = None
    for i, p in enumerate(ring):
        if abs(p["lat"] - node["lat"]) < 1e-9 and abs(p["lon"] - node["lon"]) < 1e-9:
            idx = i
            break
    if idx is None:
        return None
    prv, nxt = ring[(idx - 1) % len(ring)], ring[(idx + 1) % len(ring)]
    wall = bearing((prv["lat"], prv["lon"]), (nxt["lat"], nxt["lon"]))
    cy = sum(p["lat"] for p in ring) / len(ring)
    cx = sum(p["lon"] for p in ring) / len(ring)
    to_centroid = bearing((node["lat"], node["lon"]), (cy, cx))
    for cand in ((wall + 90) % 360, (wall - 90) % 360):
        if abs((cand - to_centroid + 180) % 360 - 180) > 90:   # away from centroid
            return round((cand + 180) % 360, 1)
    return None


def step_free(tags):
    w = tags.get("wheelchair")
    if w == "yes":
        return True
    if w in ("no", "limited"):
        return False
    return None


def main():
    entrances, buildings = {}, {}
    grid = tiles(BBOX, GRID)

    print(f"pass 1: {len(grid)} tiles")
    for k, (s, w, n, e) in enumerate(grid, 1):
        bb = f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"
        try:
            els = overpass(f'[out:json][timeout:50];node["entrance"]({bb});out body;')
        except RuntimeError as ex:
            print(f"  tile {k:2d}/{len(grid)} FAILED: {ex}", file=sys.stderr, flush=True)
            continue
        for nd in els:
            entrances.setdefault(f"node/{nd['id']}", nd)
        print(f"  tile {k:2d}/{len(grid)}  nodes={len(els):4d}  cum={len(entrances)}", flush=True)

    # Geometry (approach bearings) is OPTIONAL enrichment and Overpass throttles
    # hard on it. It lives in pipeline/enrich_bearings.py and runs separately, so a
    # throttled mirror can never block the dataset the app actually needs.

    node_to_bldg = {}
    for bid, wy in buildings.items():
        for p in wy.get("geometry") or []:
            node_to_bldg.setdefault((round(p["lat"], 7), round(p["lon"], 7)), bid)

    out_ent, out_bld = [], {}
    for nid, nd in entrances.items():
        t = nd.get("tags", {})
        bid = node_to_bldg.get((round(nd["lat"], 7), round(nd["lon"], 7)))
        ring = buildings[bid].get("geometry") if bid else None
        sf = step_free(t)
        door = t.get("door")
        lvl = str(t.get("level", ""))
        out_ent.append({
            "id": nid, "buildingId": bid, "lat": nd["lat"], "lon": nd["lon"],
            "name": t.get("name"), "kind": t.get("entrance", "yes"),
            "level": int(lvl) if lvl.lstrip("-").isdigit() else None,
            "stepFree": sf,
            "tier": 1 if sf is not None else 0,
            "confidence": "surveyed" if sf is not None else "unknown",
            "door": door,
            "automatic": t.get("automatic_door") not in (None, "no"),
            "approachBearing": approach_bearing(nd, ring),
            "description": None,
            "warnings": [DOOR_WARN[door]] if door in DOOR_WARN else [],
            "source": "osm",
        })
        if bid:
            bt = buildings[bid].get("tags", {})
            g = buildings[bid].get("geometry") or []
            b = out_bld.setdefault(bid, {
                "id": bid, "name": bt.get("name"), "placeId": None,
                "addr": (bt.get("addr:street", "") + " " + bt.get("addr:housenumber", "")).strip() or None,
                "centroid": [round(sum(p["lat"] for p in g)/len(g), 6),
                             round(sum(p["lon"] for p in g)/len(g), 6)] if g else None,
                "accessSummary": None, "entranceIds": [],
                "stats": {"total": 0, "stepFree": 0, "notStepFree": 0, "unknown": 0}})
            b["entranceIds"].append(nid)
            b["stats"]["total"] += 1
            b["stats"]["stepFree" if sf is True else
                       "notStepFree" if sf is False else "unknown"] += 1

    for b in out_bld.values():
        known = b["stats"]["stepFree"] or b["stats"]["notStepFree"]
        b["accessSummary"] = {
            "tier": 1 if known else 0,
            "stepFree": (b["stats"]["stepFree"] > 0) if known else None,
            "confidence": "surveyed" if known else "unknown"}

    doc = {"meta": {"version": 1,
                    "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "area": "Berlin Mitte", "bbox": list(BBOX),
                    "counts": {"buildings": len(out_bld), "entrances": len(out_ent),
                               "tier1": sum(1 for e in out_ent if e["tier"] == 1)}},
           "buildings": sorted(out_bld.values(), key=lambda b: b["id"]),
           "entrances": sorted(out_ent, key=lambda e: e["id"])}
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1)
    c = doc["meta"]["counts"]
    print(f"\nwrote {OUT}")
    print(f"  entrances {c['entrances']}   tier1 {c['tier1']}   buildings {c['buildings']}")
    print(f"  approachBearing resolved: {sum(1 for e in out_ent if e['approachBearing'] is not None)}")


if __name__ == "__main__":
    main()
