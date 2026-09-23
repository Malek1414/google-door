# Doorway — design spec

**Date:** 2026-09-23 · **Event:** Google x Aktion Mensch, "AI Agents for Inclusion", Berlin
**Freeze:** Thu 2026-09-24 10:00 · **Pitch:** 12:00
**Team:** Malek (@Malek1414) — data layer + backend · Sami (@sami-mag07) — delegated build agents

## Problem

A partially-blind user follows Live View to a destination pin and arrives outside a
building with no idea which of its doors he can actually use. Google Places carries
`accessibilityOptions.wheelchairAccessibleEntrance` — but it is a **building-level
boolean**. It asserts that an accessible entrance exists. It does not say where.

Berlin Hauptbahnhof has **109 mapped entrances**. Nine are step-free, nine are
explicitly not, and 83% are unrecorded. Two doors both named `Hauptbahnhof`, both at
street level, sit **36.9 m apart** — one works, one doesn't. Maps shows one pin.

**Doorway supplies the missing primitive: the coordinates of the specific door, and
guidance to it.**

## Users

Designed on two independent axes rather than four disability categories.

| Axis | Values |
|---|---|
| Route constraint | step-free required / any route |
| Output channel | speech · visual · haptic (any combination) |

| Person | Step-free | Channels |
|---|---|---|
| Erden — partially blind, primary demo user | no | large visuals + speech |
| Blind | no | speech + haptic |
| Deaf | no | visual + haptic |
| Wheelchair | **yes** | visual |
| Mute | no | any; no voice *input* — all controls stay tappable |

Two axes rather than four buckets: less code, and a deafblind wheelchair user is
handled without a fifth branch.

## Architecture

```
BUILD TIME (committed to repo)
  overpass (tiled 4x4) -> entrances + buildings
  building association -> approach bearings
  places              -> tier 2 boolean + placeId
  gemini              -> one-sentence door descriptions
                       |
                 data/berlin-mitte.json      (see docs/CONTRACT.md)

RUNTIME
  static tiles (CDN)  ->  PWA  <-  backend proxy  ->  Gemini / Places
                           |
      GPS + compass -> geo core -> (bearing, distance, confidence)
                                    |-> AR overlay
                                    |-> audio beacon
                                    +-> speech
```

**Backend exists for exactly one reason that cannot be designed away:** a
QR-distributed web app cannot hold a Gemini or Places API key. Every AI and Places
call is proxied. Entrance data stays static because it does not change during a demo
and a file cannot rate-limit you.

**Hot path is deterministic.** Bearing, distance, beacon pitch and arrow rotation are
arithmetic — microseconds, offline, incapable of hallucinating. An LLM in the render
loop would add latency, cost, and the possibility of announcing a door that isn't
there. For a blind user walking toward traffic that is a safety failure, not a glitch.
**LLM in the warm path only.**

## The confidence ladder

| tier | source | door coords | arrow? |
|---|---|---|---|
| 1 surveyed | OSM entrance node + `wheelchair=yes` | exact | **yes** |
| 2 reported | Places boolean, Wheelmap | building only | no |
| 3 community | Gemini over reviews and photos | none | **never** |
| 0 unknown | nothing | none | no — say so plainly |

Tier 3 is the most on-theme component at an *AI Agents for Inclusion* event: an agent
reading back accessibility knowledge that disabled people already wrote in reviews,
which nobody indexed. Constraints enforced in code, not by prompt — every claim
carries a verbatim quote or is dropped; claims never carry coordinates; an empty
result is correct and common.

## Platform

Web PWA, HTTPS, QR-distributed, Safari-first, Android via one compass shim.
No install and no account is itself an accessibility argument.

Rejected: a Google Maps extension — **no such extension point exists**; and ARCore
Geospatial/VPS, which is what Live View actually runs but is native-SDK only with no
WebXR binding. A native Android wrapper around Geospatial remains a post-hackathon path.

**GPS accuracy** is improved by map-matching to the OSM footway graph (the largest
single win), a Kalman filter over fixes, stationary averaging, and WiFi trilateration.
Past ~10m the handoff is to bearing, then to an opt-in Gemini visual confirmation —
the same GPS-for-the-walk, vision-for-the-arrival split Live View makes.

## Interaction

- Accessibility glyph at **+40%**, heavy dark outline over bright fill. Contrast
  beats hue for low vision; colour is a profile setting.
- **Pulse rate rises continuously as heading converges** — a gradient he can steer by,
  not a binary he has to hunt for.
- Beacon on three channels: pulse rate = distance, **stereo pan = direction**,
  volume secondary. Panning lets a blind user walk a bearing wordlessly.
- Spoken line fires **2.5 m early** to hide endpoint latency.
- Haptics: left = two short, right = three short, arrived = one long.
- Below 25m GPS accuracy, render a **cone** and say "roughly this way". Never fake precision.

## Division of labour

| Owner | Scope |
|---|---|
| Malek | pipeline, contract, backend proxy, integration |
| delegated agents | `docs/briefs/BRIEF-APP.md`, `docs/briefs/BRIEF-PITCH.md` |

`docs/CONTRACT.md` is the interface. Both briefs code against it; if it holds, the
pieces fit on push.

## Testing

Pure modules (`geo`, `beacon`, `profile`, `match`) unit-test with no device.
`pipeline/fixtures/hbf_groundtruth.json` is the pipeline regression: 109 nodes,
9/9/91 split, the 36.9 m pair, the Europaplatz revolving-door warning. A replay
simulator (`?sim=1`) runs the whole overlay against a recorded track, so the AR layer
is developed indoors rather than by walking to Hauptbahnhof for every change.

## Risks

| Risk | Mitigation |
|---|---|
| iOS denies compass | one-gesture unlock; **open in Safari, never an in-app webview** — printed on the QR poster |
| 18.8 h to freeze | data layer ships as a file and cannot block the app; app and pitch run in parallel |
| CODE University has no accessibility data | survey it on camera and upload to OSM — converts the gap into the strongest pitch beat |
| Two-codebase split | resolved: single web plan, native iOS plan set aside |
| Demo-day GPS/weather | demo is pre-filmed; live app runs alongside |

## Open

1. Google Cloud project + keys in `.env`, never committed.
2. Erden's colour preference for the glyph — ask him directly.
3. Whether tonight's shoot moves to Hauptbahnhof or stays at CODE with a live survey.
