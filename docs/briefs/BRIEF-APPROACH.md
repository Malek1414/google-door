# BRIEF-APPROACH — the last 10 metres

**For:** Sami's build agents. **Owner on review:** Malek.
**Read `docs/CONTRACT.md` § "Last 10 metres" first.** It is the interface. Do not change
it; open a PR against it if something is missing.

## What this is

Google Maps navigation ends at a pin on a building. For a blind person that is where
the problem starts, not where it ends. This mode begins at "you have arrived" and ends
when the user is physically through the door.

It is **blind-first**. Wheelchair users get a different answer from the same screen
(can I get through this door), and deaf users are not offered it at all — they can see
the door, and a mode that talks is no use to them.

## The one constraint that shapes everything

**GPS does not participate.** Accuracy is 5–30 m; the entire feature lives inside that
error bar. Nothing here reads a GPS fix for bearing, distance or arrival. Vision is the
anchor, the compass and step counter track between anchors.

If you find yourself reaching for `navigator.geolocation` in this feature, stop — the
design is wrong at that point.

---

## Split of work

**Malek owns (do not build these, they will land in `core/` and `server/`):**

| | |
|---|---|
| `core/approach.ts` | phase machine: orienting → walking → threshold → through |
| `core/anchor.ts` | projects a vision fix forward with compass + steps |
| `core/stability.ts` | the hallucination guard |
| `core/instruct.ts` | state → the exact words |
| `server/approach.py` | `/api/door-fix`, `/api/door-check`, `/api/live-token` |

**You own:**

| # | thing | done when |
|---|---|---|
| 1 | trigger button on the arrival card | a large button "Zum Eingang führen"; VoiceOver reaches it and double-tap activates it |
| 2 | `ui/Approach.ts` — the screen | camera full-bleed, phase-driven, calls into `core/approach` only |
| 3 | wheelchair verdict card | one call to `/api/door-check`, one card, no loop |
| 4 | ground-plane chevrons in `ar.ts` | chevrons lie on the ground and stay flat as the phone tilts |
| 5 | "Noch draußen" override | large button; keeps guidance running when vision ends it early |

---

## 1. The trigger

An **ordinary button**, not a gesture:

```
[ Zum Eingang führen ]      min-height 72px, full width, high contrast
```

With VoiceOver on, the user swipes to it and double-taps — which is exactly the
double-tap the feature was described with, and it comes for free. **Do not add a
double-tap handler.** VoiceOver swallows raw double-taps, so a custom one would fail
for precisely the users this exists for.

Shown on the arrival card only when `profile.channels` includes `speech` or the profile
needs step-free. Never shown to a deaf-only profile.

## 2. The Approach screen

Full-bleed camera, and almost no chrome. This screen is mostly listened to, not looked
at, so resist filling it.

```
┌──────────────────────────┐
│ [x]                      │   exit, top-left, 56px
│                          │
│      (camera)            │
│                          │
│        ◄ 22°             │   huge arrow + angle, for low vision
│                          │
│       4 Meter            │   tabular mono, huge
│                          │
│  Leicht links            │   current instruction
│                          │
│  [ Noch draußen ]        │   only in the `through` phase
└──────────────────────────┘
```

The screen calls `core/approach` and renders what it returns. **Put no guidance logic
here** — no angle bands, no phase decisions, no wording. Those are pure and tested in
`core/`; duplicating them in the UI is how the two drift apart.

Announce every instruction change through `announce()` as well as speech, so VoiceOver
users get it even if speech is off.

## 3. Wheelchair verdict

Same button, different screen. One `/api/door-check` call, one card:

```
Stufe        ja / nein / unklar
Breite       ca. 90 cm / unklar
Öffnet       automatisch / drücken / ziehen / Drehtür
```

Anything the model is unsure of renders **unklar**, never a guess. No loop, no beacon,
no turn-by-turn — being told "turn 20 degrees left" when you can see the door perfectly
well is the single most common complaint disabled users make about accessibility tech.

## 4. Ground-plane chevrons

Today the chevrons float at a fixed screen position. Google's lie on the pavement.

The missing input is **device pitch** — `DeviceOrientationEvent.beta` — which the app
already receives and throws away. Project the chevrons onto a ground plane at the
phone's tilt so they stay flat as the phone moves.

Keep the existing extruded geometry in `ar.ts`; this is a transform change, not a
redraw. And keep the existing `visibility`/`opacity` behaviour — poor localisation dims
the chevrons, it does not hide them, because an empty screen tells a partially-sighted
user nothing at all.

## 5. "Noch draußen"

Vision proposes that the user is inside and guidance stops. This button keeps it
running. Large, high contrast, VoiceOver-reachable — same reasoning as the trigger.

---

## Rules that are not negotiable

1. **Door guidance only.** The mode says once, at the start: *"Ich führe dich nur zur
   Tür. Achte weiter selbst auf deine Umgebung."* No obstacle, traffic or people
   warnings anywhere in the UI. A half-trusted warning is worse than none — it invites
   someone to stop scanning with their cane.
2. **Never present a fallback as a fix.** When `DoorFix.source === "osm-fallback"`,
   vision failed and the number came from the map. Say so in the UI. The user keeps
   agency over how much to trust it.
3. **The beacon does the turning, not speech.** Speech marks state changes only. If you
   find yourself repeating "links … links … links", that is the beacon's job — words
   arrive after the turn has already overshot.
4. **No guidance logic in the UI.** See above.

## Definition of done

- [ ] Trigger reachable and activatable with VoiceOver on, on a real iPhone
- [ ] Approach screen renders every phase from `core/approach` with no logic of its own
- [ ] Wheelchair verdict renders `unklar` wherever the model is unsure
- [ ] Chevrons stay flat on the ground as the phone pitches
- [ ] Every instruction reaches VoiceOver via `announce()`, not only speech
- [ ] `grep -rn "navigator.geolocation" src/ui/Approach.ts` is empty
- [ ] Safety line spoken exactly once per session, at mode start

## Report back

Push to `approach/<area>`, open a PR, and state in the body: what is done, what is
stubbed, and every deviation from this brief with the reason. If the contract blocks
you, say so in the PR rather than working around it.
