# Doorway data contract v1

**This file is the interface between the data pipeline and the app.**
Pipeline emits it. App consumes it. Neither side may change it unilaterally.
If you need a field that isn't here, open a PR against this file first.

Owner: Malek (pipeline). Consumers: BRIEF-APP, BRIEF-PITCH.

---

## File layout

    data/berlin-mitte.json        full dataset (dev)
    data/tiles/<geohash5>.json    production; app loads only nearby tiles

Tiles use 5-char geohash (~5km). App loads the current tile plus its 8 neighbours.

---

## Top-level shape

```json
{
  "meta": {
    "version": 1,
    "generated": "2026-09-23T15:30:00Z",
    "area": "Berlin Mitte",
    "bbox": [52.505, 13.360, 52.540, 13.425],
    "counts": { "buildings": 0, "entrances": 2706, "tier1": 140 }
  },
  "buildings": [ Building ],
  "entrances": [ Entrance ]
}
```

## Entrance

The only object that may move an arrow.

```json
{
  "id": "node/4398651551",
  "buildingId": "way/24950666",
  "lat": 52.526490,
  "lon": 13.369646,
  "name": "Hauptbahnhof",
  "kind": "yes",
  "level": 0,
  "stepFree": true,
  "tier": 1,
  "confidence": "surveyed",
  "door": "no",
  "automatic": false,
  "approachBearing": 214.0,
  "description": "A step-free opening on the south-west side, no door to push.",
  "warnings": ["revolving"],
  "source": "osm"
}
```

| field | type | notes |
|---|---|---|
| `id` | string | `node/<osmid>`, stable across rebuilds |
| `buildingId` | string \| null | null when no parent building resolved |
| `lat`,`lon` | number | WGS84. **Only tier 1 entries have trustworthy coords.** |
| `name` | string \| null | OSM `name`, e.g. `"Eingang Washingtonplatz"` |
| `kind` | enum | `main` \| `yes` \| `secondary` \| `service` \| `emergency` \| `exit` \| `staircase` |
| `level` | number \| null | OSM `level`; 0 = street |
| `stepFree` | bool \| null | **null means unknown. Never coerce null to false.** |
| `tier` | 0\|1\|2\|3 | see ladder below |
| `confidence` | enum | `surveyed` \| `reported` \| `community` \| `unknown` |
| `door` | enum \| null | `no` \| `hinged` \| `sliding` \| `revolving` \| `yes` |
| `automatic` | bool | from `automatic_door` |
| `approachBearing` | number \| null | compass degrees you FACE when walking into the door (outward wall normal + 180). Null if building geometry unresolved. |
| `description` | string \| null | Gemini, one sentence, plain language |
| `warnings` | string[] | derived: `revolving`, `heavy`, `steps`, `level-mismatch` |
| `source` | enum | `osm` \| `places` \| `survey` |

## Building

```json
{
  "id": "way/24950666",
  "name": "Berlin Hauptbahnhof",
  "placeId": "ChIJ...",
  "addr": "Europaplatz 1",
  "centroid": [52.5250, 13.3694],
  "accessSummary": { "tier": 1, "stepFree": true, "confidence": "surveyed" },
  "entranceIds": ["node/4398651551", "node/390962614"],
  "stats": { "total": 109, "stepFree": 9, "notStepFree": 9, "unknown": 91 }
}
```

`placeId` is the **only** Google Places value persisted to disk. Maps Platform terms
permit indefinite place-ID storage; they do not permit retaining other Places content.

---

## The confidence ladder

| tier | confidence | source | door coords? | app may draw an arrow? |
|---|---|---|---|---|
| 1 | `surveyed` | OSM node + `wheelchair=yes` | exact | **yes** |
| 2 | `reported` | Places `accessibilityOptions`, Wheelmap | building only | no — point at building centroid |
| 3 | `community` | Gemini over reviews/photos | none | **never** |
| 0 | `unknown` | nothing | none | no |

**Hard rule: only `tier: 1` may produce a directional arrow.** Tiers 2 and 3 are text.
A tier-3 claim that appears to name a location is still text. This is a safety rule,
not a style preference — a confident arrow to a door that isn't there can walk a
blind user into traffic.

---

## Tier 3 endpoint

Live only. Never written to disk.

    GET /api/lived/:placeId

```json
{
  "placeId": "ChIJ...",
  "claims": [
    {
      "quote": "The ramp is round the back, past the bike racks.",
      "author": "Google review, Mar 2026",
      "topic": "step-free-route",
      "coords": null
    }
  ]
}
```

Constraints enforced server-side, in code, not by prompt:
1. Every claim carries a verbatim `quote`. No quote → claim dropped.
2. `coords` is always `null`. The field exists so nobody adds it later.
3. `claims: []` is a valid, common, correct response.
4. Quotes render verbatim with attribution. Never paraphrased.

## Live look endpoint

    POST /api/look
    { "frame": "<base64 jpeg>", "heading": 214.0, "distanceM": 8.2,
      "target": "step-free opening, no door" }
    -> { "say": "The glass door is slightly left, about eight metres." }

Rate-limited per session. **Never called from the render loop.**

---

## Regression fixture — Berlin Hauptbahnhof

`pipeline/fixtures/hbf_groundtruth.json`, **generated** by `pipeline/make_fixture.py`.
Never hand-edit it. Re-derive and diff with `make_fixture.py --verify`.

Bbox `52.5215,13.3640,52.5290,13.3760`, verified 2026-09-23:

- 109 entrance nodes: **8 step-free, 11 not, 90 unknown**
- closest contradiction **9.1 m**: `node/10795939972` step-free (unnamed) vs
  `node/1250148681` not step-free (Invalidenstrasse 52 — the addressed door)
- `node/2745105107` Eingang Europaplatz: stepFree true, `door: "revolving"`,
  `warnings` contains `"revolving"`

If the 9.1 m pair breaks, the merge is wrong. Two-second check, run it often.

---

## Gemini models — verified 2026-09-23

**`gemini-2.0-flash` and `gemini-2.0-flash-lite` were SHUT DOWN on 2026-06-01.**
Anything calling them gets an error, not a fallback. Do not copy a model string from
memory or from an older tutorial — check `GET /api/health`, which reports the live ones.

| use | model | why |
|---|---|---|
| `/api/look` — one frame to one spoken sentence | `gemini-3.6-flash` | tuned for speed + multimodal; the user is standing on a street waiting |
| `/api/lived` — reviews to strict JSON | `gemini-3.8-flash` | strongest current Flash instruction-follower; the no-paraphrase rule must hold exactly |

Override without a code change:

    GEMINI_MODEL_LOOK=gemini-3.8-flash GEMINI_MODEL_LIVED=gemini-3.8-flash uvicorn server.app:app

### Others worth knowing about for this project

| model | relevance |
|---|---|
| `gemini-3.8-live` | real-time voice with no reasoning delay — if streaming voice is ever revisited |
| `gemini-3.1-flash-tts-preview` | TTS; likely better than browser `speechSynthesis` for the spoken guidance |
| `gemini-3.5-transcribe` | STT with diarization — the deaf profile's captioning path |
| `gemini-3.1-pro-preview` | offline batch description generation, where latency doesn't matter |

`gemini-3.8-flash` is also the default for the Antigravity SDK, which may settle the
open question about what the Antigravity accounts are for.


---

## Audio contract

Pre-synthesised guidance lives in `data/audio/<lang>/<key>.wav`, indexed by
`data/audio/manifest.<lang>.json`:

```json
{ "lang": "de", "voice": "Kore", "model": "gemini-3.1-flash-tts-preview",
  "clips": { "turn_left": { "file": "audio/de/turn_left.wav", "text": "Links." } } }
```

Stable keys the app may rely on:

`turn_left` · `turn_right` · `straight` · `arrived` · `off_route` · `confirmed` ·
`reported_only` · `unknown` · `warn_revolving` · `warn_steps` · `door_automatic` ·
`low_accuracy` · `dist_{5,10,15,20,30,40,50,75,100}` · `ent_node_<osmid>`

WAV, 24 kHz mono 16-bit. Regenerate with `pipeline/synth_speech.py --lang de`
(resumable — existing files are skipped).

**Playback order is cached WAV → `/api/speak` → `speechSynthesis`.** Runtime TTS is
for unpredictable text only; it must never sit in the walking loop.
