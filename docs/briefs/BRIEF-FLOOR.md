# BRIEF-FLOOR: ground surface analysis from the business video

**Status:** planned 2026-09-23 evening, must ship before the freeze **Thu 2026-09-24 10:00**.
**Why:** for wheelchair users the floor decides as much as the door. Cobblestones, gravel, a
steep ramp, a door threshold or a slippery floor can make a "step-free" entrance unusable. It is
both a selling point (we can say *how* the way is, not only *that* it exists) and a risk (a wrong
"smooth" verdict sends someone onto a surface they cannot roll on). So: detect it, show it plainly,
never let it upgrade safety on its own.

## What happens

1. The business owner films the way from the street to the entrance (and on to the toilet) in
   **Unternehmen → Weg filmen** (already exists as the walk recorder; add video capture there,
   or upload an existing clip).
2. The app uploads the clip to the backend proxy. **Keys stay on the server.**
3. The backend sends the video to Gemini (video understanding) and gets back a structured list of
   **surface segments** along the way.
4. The owner sees the result on a review screen and confirms or corrects each segment.
5. Confirmed segments are stored with the entrance and shown to users on the door card
   ("Boden" row) and as warnings, and spoken in the live guidance before the user reaches them.

## Surface model (proposal, needs a CONTRACT.md PR by Malek before the app relies on it)

```json
"surface": {
  "segments": [
    { "t0": 3.2, "t1": 9.8,
      "type": "smooth|paving|cobblestone|gravel|grass|carpet|tiles|metal_grate|unknown",
      "condition": "good|uneven|damaged|wet_slippery|unknown",
      "slope": "flat|gentle|steep|unknown",
      "obstacles": ["threshold", "step", "kerb", "narrow_passage", "door_mat", "ramp"],
      "note": "one short sentence, plain language",
      "confidence": 0.0 }
  ],
  "summary": "smooth|mixed|difficult|unknown",
  "source": "gemini_video",
  "confirmed": false
}
```

Derived warnings (added to the entrance `warnings` array only when **confirmed** by the owner):
`uneven-surface`, `cobblestones`, `gravel`, `steep-slope`, `threshold`, `slippery`.

## Safety rules (same spirit as the tier ladder)

- The surface analysis **never upgrades** anything: it cannot make a door step-free or tier 1.
- It **can downgrade**: a confirmed `step`, `kerb` or `steep` slope on the only route marks the
  entrance "not suitable for wheelchairs" for step-free profiles (text + no arrow), until an
  owner edit or a survey says otherwise.
- Unconfirmed results are shown as "Automatisch erkannt, noch nicht bestätigt".
- Low confidence (< 0.6) is shown as `unknown`, never as `smooth`.
- The model prompt must forbid guessing: "If the floor is not clearly visible, answer unknown."

## Build steps (in this order)

| # | Where | What | Done when |
|---|---|---|---|
| 1 | `server/app.py` (Malek) | `POST /api/surface` accepts a video (max 60 s, 50 MB, mp4/mov), sends it to Gemini (`GEMINI_MODEL_SURFACE`, default the current Flash model, env-configurable), JSON schema output as above, rejects anything that does not validate | curl with a sample clip returns segments |
| 2 | `web/src/sim/replay.ts` recorder | add video capture (MediaRecorder, rear camera) next to the GPS track, or file upload | a clip can be recorded on the iPhone |
| 3 | `web/src/ui/SurfaceReview.ts` (new) | upload with progress, then a list of segments with thumbnail at t0, type, condition, slope, obstacles; owner confirms or edits each | owner can confirm |
| 4 | `web/src/core/survey.ts` | store `surface` on the survey entrance; pure `surfaceWarnings(surface)` + tests incl. "never upgrades" | tests green |
| 5 | Door card + place card | "Boden" fact row with icon and summary, warnings in the warning block | visible on the card |
| 6 | Live view | speak the next confirmed obstacle 10 m before it ("Achtung, Kopfsteinpflaster auf den nächsten 20 Metern") | heard in `?sim=1` |
| 7 | Pitch | one slide / 15 s of the demo: owner films, app shows "Kopfsteinpflaster, holprig" | in the deck |

## Test

- A clip from CODE University (entrance path) and one with cobblestones (Berlin Mitte is full of
  them) as fixtures in `pipeline/fixtures/surface/`.
- Unit tests for the safety rules; e2e: record or upload, review, confirm, card shows "Boden".

## Open questions

1. Malek: does `/api/surface` go into `server/app.py` or a separate route file?
2. Do we keep the uploaded video? Default: **no**, delete after analysis, keep only segments and
   up to 3 keyframes (privacy: bystanders).
