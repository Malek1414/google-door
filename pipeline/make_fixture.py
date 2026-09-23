#!/usr/bin/env python3
"""Generate the Hbf regression fixture FROM LIVE OSM.

Never hand-transcribe ground truth. An earlier fixture was typed up from an
exploratory script's printout, encoded a wheelchair value that OSM did not
actually carry, and put a false claim into the pitch deck. The fixture is now
derived, and `python3 pipeline/make_fixture.py --verify` re-derives and diffs it.
"""
import json, math, sys, urllib.parse, urllib.request

BBOX = (52.5215, 13.3640, 52.5290, 13.3760)
OUT  = "pipeline/fixtures/hbf_groundtruth.json"


def ov(q, tries=3):
    import time
    last = None
    for mirror in ("https://overpass-api.de/api/interpreter",
                   "https://overpass.kumi.systems/api/interpreter"):
        for attempt in range(tries):
            try:
                r = urllib.request.Request(mirror,
                    data=urllib.parse.urlencode({"data": q}).encode(),
                    headers={"User-Agent": "Doorway/1.0"})
                return json.load(urllib.request.urlopen(r, timeout=90))["elements"]
            except Exception as ex:
                last = ex
                time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"overpass exhausted: {last}")


def step_free(t):
    w = t.get("wheelchair")
    return True if w == "yes" else False if w in ("no", "limited") else None


def hav(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))


def build():
    s, w, n, e = BBOX
    els = ov(f'[out:json][timeout:60];node["entrance"]({s},{w},{n},{e});out body;')
    yes = [x for x in els if step_free(x.get("tags", {})) is True]
    no  = [x for x in els if step_free(x.get("tags", {})) is False]
    unk = [x for x in els if step_free(x.get("tags", {})) is None]

    d, a, b = min(((hav((p['lat'], p['lon']), (q['lat'], q['lon'])), p, q)
                   for p in yes for q in no), key=lambda t: t[0])

    def node(x):
        t = x.get("tags", {})
        return {"id": f"node/{x['id']}", "lat": x["lat"], "lon": x["lon"],
                "name": t.get("name"), "entrance": t.get("entrance"),
                "door": t.get("door"), "wheelchair": t.get("wheelchair"),
                "addr": (t.get("addr:street", "") + " " + t.get("addr:housenumber", "")).strip() or None}

    rev = next(x for x in els if x["id"] == 2745105107)
    cle = next(x for x in els if x["id"] == 2739626375)

    return {
        "_generated_by": "pipeline/make_fixture.py — DERIVED FROM LIVE OSM, never hand-edited",
        "bbox": list(BBOX),
        "counts": {"entrances": len(els), "stepFreeTrue": len(yes),
                   "stepFreeFalse": len(no), "stepFreeNull": len(unk)},
        "closest_contradiction": {
            "_why": ("The inaccessible door carries the street address, so it is the one a "
                     "geocoder resolves. The step-free door is metres away, unnamed."),
            "stepFree": node(a), "notStepFree": node(b),
            "separationM": round(d, 1), "toleranceM": 1.0},
        "revolving": {
            "_why": "Tagged step-free, functionally a barrier. A boolean cannot say this.",
            **node(rev)},
        "clear_opening": {**node(cle)},
    }


if __name__ == "__main__":
    fresh = build()
    if "--verify" in sys.argv:
        cur = json.load(open(OUT))
        cur.pop("_generated_by", None); f2 = dict(fresh); f2.pop("_generated_by", None)
        same = json.dumps(cur, sort_keys=True) == json.dumps(f2, sort_keys=True)
        print("fixture matches live OSM" if same else "FIXTURE DRIFTED from live OSM")
        sys.exit(0 if same else 1)
    with open(OUT, "w") as f:
        json.dump(fresh, f, indent=2, ensure_ascii=False)
    c = fresh["counts"]
    print(f"wrote {OUT}")
    print(f"  {c['entrances']} entrances | {c['stepFreeTrue']} step-free | "
          f"{c['stepFreeFalse']} not | {c['stepFreeNull']} unknown "
          f"({100*c['stepFreeNull']//c['entrances']}%)")
    p = fresh["closest_contradiction"]
    print(f"  closest contradiction: {p['separationM']} m")
    print(f"    step-free : {p['stepFree']['id']}  addr={p['stepFree']['addr']}")
    print(f"    NOT       : {p['notStepFree']['id']}  addr={p['notStepFree']['addr']}")
