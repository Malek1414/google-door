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

---

## Surface segments (v1) — answers BRIEF-FLOOR

For wheelchair users the floor decides as much as the door: a step-free entrance at the
end of thirty metres of cobblestone is not accessible. Surface data is a **fourth
source**, and it sits under the same asymmetry as the tier ladder.

### The asymmetry, restated as a rule

**Surface analysis may never upgrade. It may only downgrade.**

- It cannot make a door step-free, cannot raise a tier, cannot create an arrow.
- A **confirmed** `step`, `kerb`, or `steep` slope on the only route marks that entrance
  unsuitable for step-free profiles: text, no arrow, until an owner edit or a survey says
  otherwise.
- Confidence below 0.6 renders as `unknown`. Never as `smooth`.
- Unconfirmed results are labelled as unconfirmed in the UI, always.

### Where it lives

On the **route**, not the door. One entrance may be approached from several directions with
different surfaces, so `surface` hangs off a route record keyed by `entranceId`, and the door
card shows the summary of the route the user is actually on (or the worst case when unknown).

```json
{
  "entranceId": "node/10795939972",
  "approachId": "approach/1",
  "segments": [
    { "t0": 3.2, "t1": 9.8,
      "type": "smooth|paving|cobblestone|gravel|grass|carpet|tiles|metal_grate|unknown",
      "condition": "good|uneven|damaged|wet_slippery|unknown",
      "slope": "flat|gentle|steep|unknown",
      "obstacles": ["threshold","step","kerb","narrow_passage","door_mat","ramp"],
      "note": "one short sentence, plain language",
      "confidence": 0.0,
      "startM": 12.4, "endM": 31.7 }
  ],
  "summary": "smooth|mixed|difficult|unknown",
  "source": "gemini_video",
  "confirmed": false
}
```

### `startM` / `endM` — the piece BRIEF-FLOOR is missing

Segments come back keyed by **video time**. The arrow works in **geography**. Speaking a
warning ten metres before cobblestones therefore needs a time → distance join, and without
it a segment can be shown on a card but never announced at the right moment.

The recorder must write a GPS track **alongside** the video, sharing one clock. Then:

```
startM(t) = cumulative walked distance along the track at video time t
```

`pipeline/surface_align.py` (pure, testable) integrates haversine over the track samples and
resolves each `t0`/`t1` to `startM`/`endM`. Rules:

- Track and video must share a start timestamp; if they do not, `startM`/`endM` are `null`
  and the segment is **card-only** — never spoken, because a warning at the wrong moment is
  worse than no warning.
- Track gaps longer than 3 s make the segments they span `null` as well.
- Distances are measured from the **start of the walk**, so live guidance compares against
  distance-still-to-go, not absolute position.

### Derived warnings

Added to the entrance `warnings` array **only when `confirmed` is true**:
`uneven-surface` · `cobblestones` · `gravel` · `steep-slope` · `threshold` · `slippery`

### Endpoint

    POST /api/surface     multipart: video (mp4/mov, <= 60 s, <= 50 MB) + optional track JSON
    -> { segments: [...], summary, source: "gemini_video", confirmed: false }

Lives in `server/surface.py` with its own router, not in `app.py`: multipart upload, size
caps and temp-file handling are a different shape from the JSON endpoints.

**The video is deleted as soon as analysis returns.** At most three keyframes are retained.
People walk through station entrances without consenting to be filmed.

The prompt must forbid guessing: if the floor is not clearly visible, the answer is `unknown`.

---

## Last 10 metres (v1) — the approach contract

Where Maps stops. Its navigation ends at a pin on a building; this begins there and
ends when the user is through the door.

**GPS does not participate.** Accuracy is 5–30 m and the whole feature lives inside
that error bar. Nothing here may read a GPS fix for bearing, distance or arrival.

### Who it serves

| profile | behaviour |
|---|---|
| blind / low vision | the guidance loop |
| wheelchair | one vision call, one passability verdict, no loop |
| deaf | not offered — they can see the door |

### DoorFix — what vision returns

```json
{
  "found": true,
  "bearingDeg": -22.4,
  "distanceM": 6.5,
  "confidence": 0.82,
  "kind": "sliding|hinged|revolving|opening|unknown",
  "note": "Glastür links neben der Treppe",
  "inside": false,
  "ts": 1758750000000,
  "source": "gemini-live|gemini-frame|osm-fallback"
}
```

- `bearingDeg` is RELATIVE TO THE CAMERA CENTRE, negative left. Not a compass bearing:
  the model sees a picture, not a heading, and converting it here would hide where the
  number came from.
- `source` is never cosmetic. `osm-fallback` means vision failed and this is the
  surveyed door coordinate instead, and the UI must say so.
- `confidence` below 0.5 is treated as `found: false`.
- `inside` ends the guidance, so it needs an explicit true at confidence >= 0.6. A
  wrong true abandons someone on the pavement.

### Stability — the hallucination guard

Between two fixes the compass knows how far the PHONE turned. If the door's bearing
moves far more than the phone did, the door did not move and the model is guessing.

```
unstable  ⇔  |Δ bearing − Δ heading| > 25°
```

Two unstable fixes in a row drop Live streaming to on-demand **for the rest of the
approach** — sticky, because flapping between modes mid-walk is worse than either
mode. The user is told once: "Ich bin mir gerade unsicher."

### Phases

```
orienting → walking → threshold → through
```

- **orienting** — stand still and turn. The BEACON does the work: pitch rises as the
  bearing error falls, continuous and sub-100 ms. Speech only marks the state change.
  Discrete speech alone makes people overshoot, because the word arrives after the turn.
- **walking** — on bearing, distance counting down.
- **threshold** — under 1.5 m. "Die Tür ist direkt vor dir."
- **through** — PROPOSED two ways, never decided by the app:
  - `DoorFix.inside` is true (vision sees interior: ceiling, no sky, entrance behind).
    Requires an explicit true at confidence >= 0.6; absent or hedged is "still outside".
  - or the user stands still at the threshold for `STILL_MS` (4 s). Someone who has
    walked through a door stops walking, and this is the path when vision never fires.

  Either way a large "Noch draußen" button takes it back, and doing so restarts the
  stillness clock so simply standing there does not re-propose what was just rejected.

### Instruction bands — fixed, short, never reworded

```
 ≤ 8°     Geradeaus
 8–25°    Leicht links / rechts
 25–70°   Links / rechts
 70–135°  Scharf links / rechts
 > 135°   Dreh dich um
```

### Endpoints

    POST /api/door-fix    one frame + heading -> DoorFix
    POST /api/door-check  one frame -> passability verdict (wheelchair path)
    GET  /api/live-token  short-lived token for the Gemini Live session

### Rules that are not negotiable

1. **Door guidance only.** Said out loud once at the start: "Ich führe dich nur zur
   Tür. Achte weiter selbst auf deine Umgebung." No obstacle, traffic or people
   warnings. A half-trusted warning is worse than none, because it invites someone to
   stop scanning with their cane.
2. **Never dead-reckon past a lost fix.** When vision fails, say so and fall back to
   the OSM bearing, naming the source. Guidance that keeps speaking confidently while
   drifting is the failure mode that actually hurts someone.
3. **Trigger is an ordinary button**, not a custom gesture. VoiceOver's double-tap
   activates it for free; a literal double-tap handler would be swallowed by VoiceOver
   and fail for exactly the users this is built for.
