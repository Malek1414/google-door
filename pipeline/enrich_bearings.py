#!/usr/bin/env python3
"""Add approachBearing to entrances in data/berlin-mitte.json.

Separate from ingest_osm.py on purpose: fetching building geometry makes Overpass
throttle hard, and this is optional enrichment. The arrow only needs lat/lon plus the
user's compass heading. What a bearing buys is language — "the door faces
Washingtonplatz" instead of a pair of coordinates — and a check that the user isn't
being walked at the back of a building.

Resumable: already-resolved entrances are skipped, so a throttled run can just be
re-run until coverage is good enough. Safe to interrupt; writes after every chunk.

    python3 pipeline/enrich_bearings.py            # tier-1 doors only (default)
    python3 pipeline/enrich_bearings.py --all      # every entrance
    python3 pipeline/enrich_bearings.py --chunk 25 # smaller chunks if throttled
"""
import json, math, sys, time, urllib.parse, urllib.request

DATA    = "data/berlin-mitte.json"
MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter"]


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
                time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"overpass exhausted: {last}")


def bearing(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dl = lo2 - lo1
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1)*math.sin(la2) - math.sin(la1)*math.cos(la2)*math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass_point(deg):
    pts = ["north", "north-east", "east", "south-east",
           "south", "south-west", "west", "north-west"]
    return pts[int((deg + 22.5) % 360 // 45)]


def approach_bearing(lat, lon, ring):
    """Compass bearing you FACE walking into the door: outward wall normal + 180."""
    if not ring or len(ring) < 3:
        return None
    idx = None
    for i, p in enumerate(ring):
        if abs(p["lat"] - lat) < 1e-9 and abs(p["lon"] - lon) < 1e-9:
            idx = i
            break
    if idx is None:
        return None
    prv, nxt = ring[(idx - 1) % len(ring)], ring[(idx + 1) % len(ring)]
    wall = bearing((prv["lat"], prv["lon"]), (nxt["lat"], nxt["lon"]))
    cy = sum(p["lat"] for p in ring) / len(ring)
    cx = sum(p["lon"] for p in ring) / len(ring)
    to_centroid = bearing((lat, lon), (cy, cx))
    for cand in ((wall + 90) % 360, (wall - 90) % 360):
        if abs((cand - to_centroid + 180) % 360 - 180) > 90:      # points away from centre
            return round((cand + 180) % 360, 1)
    return None


def main():
    do_all = "--all" in sys.argv
    chunk_size = 40
    if "--chunk" in sys.argv:
        chunk_size = int(sys.argv[sys.argv.index("--chunk") + 1])

    doc = json.load(open(DATA))
    ents = doc["entrances"]
    by_id = {e["id"]: e for e in ents}

    todo = [e for e in ents
            if e["approachBearing"] is None and (do_all or e["tier"] == 1)]
    print(f"{len(ents)} entrances | {len(todo)} need a bearing "
          f"({'all' if do_all else 'tier-1 only'})")
    if not todo:
        print("nothing to do")
        return

    bldgs = {b["id"]: b for b in doc["buildings"]}
    resolved = failed = 0

    for i in range(0, len(todo), chunk_size):
        chunk = todo[i:i + chunk_size]
        ids = ",".join(e["id"].split("/")[1] for e in chunk)
        try:
            els = overpass(f'[out:json][timeout:50];node(id:{ids})->.e;'
                           f'way(bn.e)["building"];out geom;')
        except RuntimeError as ex:
            failed += len(chunk)
            print(f"  chunk @{i} failed ({ex}) — rerun to retry", file=sys.stderr, flush=True)
            continue

        rings = {}
        for wy in els:
            if wy["type"] != "way":
                continue
            geom = wy.get("geometry") or []
            wid = f"way/{wy['id']}"
            for p in geom:
                rings.setdefault((round(p["lat"], 7), round(p["lon"], 7)), (wid, geom))
            if wid not in bldgs:
                bt = wy.get("tags", {})
                bldgs[wid] = {
                    "id": wid, "name": bt.get("name"), "placeId": None,
                    "addr": (bt.get("addr:street", "") + " " +
                             bt.get("addr:housenumber", "")).strip() or None,
                    "centroid": [round(sum(p["lat"] for p in geom)/len(geom), 6),
                                 round(sum(p["lon"] for p in geom)/len(geom), 6)] if geom else None,
                    "accessSummary": {"tier": 0, "stepFree": None, "confidence": "unknown"},
                    "entranceIds": [],
                    "stats": {"total": 0, "stepFree": 0, "notStepFree": 0, "unknown": 0}}

        for ent in chunk:
            hit = rings.get((round(ent["lat"], 7), round(ent["lon"], 7)))
            if not hit:
                continue
            wid, geom = hit
            bb = approach_bearing(ent["lat"], ent["lon"], geom)
            if bb is None:
                continue
            ent["approachBearing"] = bb
            ent["facing"] = compass_point(bb)
            if not ent.get("buildingId"):
                ent["buildingId"] = wid
            resolved += 1

        doc["buildings"] = sorted(bldgs.values(), key=lambda b: b["id"])
        with open(DATA, "w") as f:          # write every chunk: safe to interrupt
            json.dump(doc, f, indent=1)
        print(f"  {min(i+chunk_size, len(todo)):4d}/{len(todo)}  resolved={resolved}",
              flush=True)

    got = sum(1 for e in ents if e["approachBearing"] is not None)
    print(f"\napproachBearing: {got}/{len(ents)} entrances "
          f"({100*got//max(len(ents),1)}%)")
    if failed:
        print(f"{failed} skipped by throttling — rerun to pick them up (resumable)")


if __name__ == "__main__":
    main()
