# The last 10 metres — design

**Date:** 2026-09-24 · **Status:** approved in outline, sections 1–5
**Owner:** Malek (core + server) · Sami's agents (UI, per `docs/briefs/BRIEF-APPROACH.md`)

## The problem

Google Maps navigation ends at a pin on a building. It says "you have arrived" while
you are standing on a pavement with no idea which of the building's doors you can use,
where it is, or which way you are facing.

For a sighted person that gap is a glance. For a blind person it is the whole problem,
and it is the part no map solves. **Doorway's last 10 metres begins exactly where Maps
stops and ends when the user is physically through the door.**

## Who it serves

| profile | behaviour |
|---|---|
| blind / low vision | the guidance loop — the feature |
| wheelchair | one vision call, one passability verdict, no loop |
| deaf | not offered; they can see the door |

Blind-first by deliberate choice. A mode that talks is no use to a deaf user, and
turn-by-turn to someone who can see the door is patronising — the most common
complaint disabled users make about accessibility tech.

## The constraint that shapes everything

**GPS does not participate.** Accuracy is 5–30 m; the feature lives entirely inside
that error bar. No GPS fix may inform bearing, distance or arrival here.

What remains:

| sensor | gives | rate |
|---|---|---|
| Gemini vision | where the door actually is | ~1–2 s |
| compass | how far you have turned since | 60 Hz |
| step detection | roughly how far you have walked | per step |

Which forces the architecture: **vision anchors, sensors track between anchors.** A
blind person turning needs feedback inside ~200 ms; a vision round-trip is ten times
that. Driving the voice directly off vision guarantees overshoot.

Same warm-path/hot-path split as the rest of Doorway: the model decides what is true,
the sensors decide what to say right now.

## Architecture

```
  Gemini Live  ──►  DoorFix { bearing, distance, confidence, source }
      │ ~1–2 s              │
      │                     ▼
      │            ┌──────────────────┐
      └─ re-anchor │  TRACKER  60 Hz  │  compass + steps
         on drift  └────────┬─────────┘
                            ▼
                   ┌────────────────┐
                   │   INSTRUCTOR   │  pure: state → utterance
                   └───┬────────┬───┘
                       ▼        ▼
                   speech    beacon
```

Four pure modules, no I/O, testable without a phone or a model:

| module | job |
|---|---|
| `core/approach.ts` | phases: orienting → walking → threshold → through |
| `core/anchor.ts` | projects a fix forward with compass + steps |
| `core/stability.ts` | the hallucination guard |
| `core/instruct.ts` | state → the exact words |

Plus `server/approach.py` (`/api/door-fix`, `/api/door-check`, `/api/live-token`) and
`ui/Approach.ts`, which renders and holds no logic.

## Vision cadence, and the guard

Gemini Live streaming by default — lowest latency, and the mode is short. The risk is
hallucination, which at this range means walking someone into a wall, so it needs a
detector rather than a hope.

Between two fixes the compass knows how far the **phone** turned. If the door's bearing
moved far more than the phone did, the door did not move:

```
unstable  ⇔  |Δ bearing − Δ heading| > 25°
```

Two unstable fixes in a row drop Live to on-demand for the rest of the approach —
**sticky**, because flapping between modes mid-walk is worse than either. Said once:
"Ich bin mir gerade unsicher."

When vision finds nothing at all, guidance falls back to the surveyed OSM door bearing
and **names the source**. It never dead-reckons past a lost fix: guidance that keeps
speaking confidently while drifting is the failure mode that actually hurts someone.

## Interaction

**Trigger:** an ordinary large button, "Zum Eingang führen". With VoiceOver on, swipe
to it and double-tap — the gesture the feature was described with, for free. A custom
double-tap handler would be swallowed by VoiceOver and fail for exactly these users.

**Orienting is the beacon's job, not speech's.** Pitch rises as the bearing error
falls: continuous, sub-100 ms, wordless. Speech marks state changes only. "Links …
links … links" arrives after the turn has already overshot.

Bands, fixed and never reworded:

```
 ≤ 8°     Geradeaus          25–70°   Links / rechts
 8–25°    Leicht links/rechts 70–135° Scharf links / rechts
                             > 135°   Dreh dich um
```

**Completion:** vision proposes the user is inside; a large "Noch draußen" button
overrides. If vision never fires, the threshold phase ends when the user stops.

**Said once, at the start:**
> "Ich führe dich nur zur Tür. Achte weiter selbst auf deine Umgebung."

No obstacle, traffic or people warnings anywhere. A half-trusted warning is worse than
none, because it invites someone to stop scanning with their cane.

## Ground-plane chevrons

Separate and small. The chevrons float at a fixed screen position; Google's lie on the
pavement. The missing input is device pitch (`beta`), already received and discarded.
A transform change in `ar.ts`, no new data.

## Testing

Pure modules unit-test with no device: band boundaries, phase transitions, the
stability threshold against synthetic compass/vision pairs, the fallback path.

A replay harness drives a recorded approach — camera frames plus compass plus steps —
through the whole loop, the same way `?sim=1` does for Live View. The AR layer was
developed indoors that way and this needs the same.

## Risks

| risk | mitigation |
|---|---|
| model hallucinates a door | stability guard, sticky fallback, named source |
| latency makes users overshoot | beacon carries the turning, not speech |
| feature implies obstacle safety | stated once out loud, and nowhere in the UI |
| VoiceOver swallows the trigger | ordinary button, no custom gesture |
| scope creep into indoor navigation | ends at the threshold, by definition |
