#!/usr/bin/env python3
"""Generate one plain-language sentence per entrance with Gemini. Warm path.

This is the only place an LLM touches entrance data, and it runs at build time.
Nothing here is in the walking loop: the app reads the sentence from JSON, and
pipeline/synth_speech.py turns it into a WAV. By the time Erdin is on a pavement,
every word has already been written and spoken.

Batched (many doors per call), resumable (existing descriptions are skipped), and
it refuses to invent: the prompt may only use the tags it is given.

    GEMINI_API_KEY=... python3 pipeline/enrich_descriptions.py --limit 60
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

DATA  = "data/berlin-mitte.json"
KEY   = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("GEMINI_MODEL_DESC", "gemini-3.8-flash")
URL   = "https://generativelanguage.googleapis.com/v1beta/models"
BATCH = 12

SYSTEM = """You write one short spoken sentence per building entrance, for a blind or
partially-sighted person walking to it.

Rules, in order of importance:
1. Use ONLY the facts given. Never invent a colour, a landmark, a street, a number of
   steps, or anything not in the tags. Thin tags make a thin sentence, and that is fine.
2. Lead with the fact that changes their decision: step-free, or has steps. Nothing
   goes before that.
3. A revolving door is a barrier for many wheelchair users and guide-dog handlers.
   When door=revolving, always say so. When automaticDoor is true, say it opens itself.
4. SAY NOTHING USELESS. Every entrance has a door, so never mention a door unless the
   TYPE matters (revolving, sliding, automatic). Drop door=yes entirely. Only mention
   level when it is not street level; level 0 is street level and goes unsaid.
5. Speak like a person, not a database. German: "Stufenlos, Richtung Suedosten." not
   "Stufenfreier Eingang auf Ebene 0, nach Suedosten ausgerichtet." Use the building
   or entrance name when there is one, because that is what the signage will say.
6. Never promise. "Als stufenlos erfasst" is honest; "voll barrierefrei" is not.
7. One sentence. Under 14 words where the facts allow. No preamble, no list.

Facts you may be given: entrance kind (main/secondary/service/staircase/yes), stepFree
(true/false/null), door type, automaticDoor, level, name, the direction the door faces,
building name.

Return JSON only: {"out":[{"id":"<id>","text":"<sentence>"}]}"""


def gemini(payload_text, tries=5):
    body = {"contents": [{"parts": [{"text": payload_text}]}],
            "systemInstruction": {"parts": [{"text": SYSTEM}]},
            "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"}}
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                f"{URL}/{MODEL}:generateContent", data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == tries - 1:
                raise
            wait = 5 * (2 ** attempt)
            print(f"      429 — waiting {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def facts(e, bname):
    f = {"id": e["id"], "kind": e["kind"], "stepFree": e["stepFree"]}
    for k in ("door", "level", "name"):
        if e.get(k) not in (None, ""):
            f[k] = e[k]
    if e.get("automatic"):
        f["automaticDoor"] = True
    if e.get("facing"):
        f["faces"] = e["facing"]
    if bname:
        f["building"] = bname
    return f


def main():
    if not KEY:
        sys.exit("GEMINI_API_KEY not set")
    lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "de"
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 10**9

    doc = json.load(open(DATA))
    bname = {b["id"]: b.get("name") for b in doc["buildings"]}
    todo = [e for e in doc["entrances"] if e["tier"] == 1 and not e.get("description")][:limit]
    print(f"tier-1 doors needing a description: {len(todo)} (lang={lang}, model={MODEL})")
    if not todo:
        print("nothing to do")
        return

    done = failed = 0
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        payload = json.dumps({"lang": lang,
                              "entrances": [facts(e, bname.get(e.get("buildingId"))) for e in chunk]},
                             ensure_ascii=False)
        try:
            resp = gemini(payload)
            text = resp["candidates"][0]["content"]["parts"][0]["text"]
            out = {o["id"]: o["text"].strip() for o in json.loads(text)["out"]}
        except Exception as ex:
            failed += len(chunk)
            print(f"  batch @{i} failed: {str(ex)[:140]}", file=sys.stderr, flush=True)
            continue
        for e in chunk:
            s = out.get(e["id"])
            if s:
                e["description"] = s
                done += 1
        with open(DATA, "w") as f:            # write every batch: safe to interrupt
            json.dump(doc, f, indent=1, ensure_ascii=False)
        print(f"  {min(i+BATCH, len(todo)):4d}/{len(todo)}  described={done}", flush=True)
        time.sleep(1.5)

    # meta.counts went stale after enrichment passes; recompute it here.
    doc["meta"]["counts"] = {
        "buildings": len(doc["buildings"]),
        "entrances": len(doc["entrances"]),
        "tier1": sum(1 for e in doc["entrances"] if e["tier"] == 1),
        "described": sum(1 for e in doc["entrances"] if e.get("description")),
        "withBearing": sum(1 for e in doc["entrances"] if e.get("approachBearing") is not None),
    }
    with open(DATA, "w") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print(f"\ndescribed {done}, failed {failed}")
    print(f"meta.counts -> {json.dumps(doc['meta']['counts'])}")


if __name__ == "__main__":
    main()
