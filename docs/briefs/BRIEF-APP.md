# BRIEF-APP — Doorway PWA runtime

**For:** a delegated build agent. **Owner on review:** Malek.
**Read `docs/CONTRACT.md` first.** It is the interface. Do not change it.

## Mission

A web app that walks a partially-blind user to the **correct accessible entrance**
of a building, using the camera, GPS and compass. Distributed by QR code.
Opens in Safari. No install, no account, no app store.

Primary user: **Erdin**, partially blind, walking to a door he can't pick out.

## Non-goals — do not build these

- No indoor navigation. The job ends at the door.
- No native app, no Swift, no ARCore, no WebXR.
- No login, no accounts, no database.
- No LLM call anywhere in the render loop.
- No backend of your own. Two endpoints exist; you consume them.

---

## Hard constraints

1. **Serve over HTTPS.** Camera and orientation are unavailable otherwise.
2. **One Start button unlocks all three sensors in a single gesture.**
   iOS requires a user gesture for `DeviceOrientationEvent.requestPermission()`
   and for `AudioContext`. Camera too. All three in one tap handler, or the
   demo dies. This is the highest-risk line of code in the project.
3. **Must run in Safari, not an in-app WKWebView.** Do not rely on
   Add-to-Home-Screen; standalone mode silently denies orientation.
4. **No API keys in client code.** Ever. Call `/api/*`.
5. **Only `tier: 1` entrances may produce an arrow.** See CONTRACT. Safety rule.

---

## Structure

    web/
      index.html
      src/
        core/geo.ts        pure. no I/O. unit-tested.
        core/beacon.ts     pure. distance+bearing -> audio params.
        core/profile.ts    pure. profile -> output config.
        core/heading.ts    THE iOS/Android compass shim. only device code.
        core/match.ts      pure. snap position to footway graph.
        ui/Start.ts        the three-unlock gesture
        ui/Onboard.ts      3 taps
        ui/MapView.ts      Google Maps JS + entrance markers
        ui/LiveView.ts     camera + SVG overlay
        sim/replay.ts      recorded-track replay. BUILD THIS SECOND.
      test/

### `core/geo.ts` — exact signatures

```ts
export function haversineM(a: LatLon, b: LatLon): number
export function bearingDeg(from: LatLon, to: LatLon): number   // 0..360, true north
export function relativeBearing(target: number, heading: number): number  // -180..180
export function normalize360(deg: number): number
```

### `core/heading.ts` — the only platform-specific file

iOS and Android differ here and nowhere else. Get this right once.

```ts
export type HeadingSource = 'ios-webkit' | 'android-absolute' | 'gps-course' | 'none'
export interface Heading { deg: number; accuracy: number | null; source: HeadingSource }
export function startHeading(cb: (h: Heading) => void): () => void
export async function requestHeadingPermission(): Promise<boolean>  // MUST be called in a tap handler
```

- **iOS:** `DeviceOrientationEvent.requestPermission()` then read
  `event.webkitCompassHeading` — already true-north, 0..360, use directly.
- **Android Chrome:** listen to `deviceorientationabsolute`, use `360 - alpha`.
  No permission call needed. Do not use `webkitCompassHeading`; it doesn't exist.
- **Fallback:** GPS course-over-ground. Works while walking, not standing.
  Emit `source: 'gps-course'` so the UI can soften the arrow into a cone.

### `core/beacon.ts`

Three channels. Web Audio, one oscillator + one panner.

```ts
export interface BeaconState { pulseHz: number; panLR: number; volume: number; pitchHz: number }
export function beaconFor(distanceM: number, relBearingDeg: number): BeaconState
```

- `pulseHz`: 0.7 Hz at 60m rising to 8 Hz at 2m. Parking-sensor grammar.
- `panLR`: −1 (hard left) .. +1 (hard right), from relative bearing. This is how a
  blind user walks a bearing with no words. Do not skip it.
- `volume`: rises with proximity, but **secondary** — street noise confounds it.
- `pitchHz`: 440 when off-bearing, 660 when within ±15°.

### `core/profile.ts`

Two axes, not four categories.

```ts
export interface Profile { stepFreeRequired: boolean; channels: ('speech'|'visual'|'haptic')[] }
export interface OutputConfig {
  arrowScale: number; contrast: 'yellow-black'|'white-black'|'black-white'
  speak: boolean; beacon: boolean; haptics: boolean; dimScreen: boolean
}
export function outputFor(p: Profile): OutputConfig
```

Persist to `localStorage` under `doorway.profile`.

---

## Screens

**1 · Start.** One full-bleed button, minimum 44pt hit target, high contrast.
Tap handler, in order, awaited: `requestHeadingPermission()` →
`getUserMedia({video:{facingMode:'environment'}})` → `new AudioContext()` + play a
silent buffer to unlock. Show which of the three succeeded. If orientation is denied,
say **"Open this link in Safari"** — that is the actual fix, 90% of the time.

**2 · Onboard.** Three taps:
1. "Do you need step-free routes?" yes / no
2. "How should Doorway talk to you?" speech · large visuals · vibration (multi-select)
3. "Test it" → plays the beacon, pulses the arrow, buzzes once. Confirms all three work.

**3 · Map.** Google Maps JS API. Entrance markers from the contract JSON:
- tier 1 step-free → accessibility glyph, full opacity, **+40% scale**
- tier 1 not step-free → muted, distinct shape
- tier 2 → building centroid only, dashed ring, no door pin
- tier 0/3 → no marker; surface as text in the detail sheet

**4 · Live View.** Camera `<video>` full-bleed, SVG overlay above it.
- Arrow rotation = `relativeBearing(bearingToDoor, heading)`.
- Pulse rate rises as `|relBearing|` falls. Continuous, not binary — he steers by it.
- Destination glyph **+40%** over the standard pin, heavy dark outline over bright fill.
  Outline matters more than hue for low vision.
- `heading.source === 'gps-course'` or GPS accuracy > 25m → render a **cone**, not a
  line, and say "roughly this way". Never fake precision.
- One button: **"What am I looking at?"** → `POST /api/look`. Opt-in only.
- **2.5m before arrival, fire the spoken line early** to hide endpoint latency.
- Haptics: left = two short, right = three short, arrived = one long.

---

## Build the simulator second. Before any UI polish.

`sim/replay.ts` replays a recorded `{t, lat, lon, heading}` track against a static
photo instead of the live camera. Toggle with `?sim=1`.

You cannot iterate by walking outside. With the simulator you develop the entire
overlay at your desk, at 10x, at 4am. Record one real walk early, commit the JSON,
then never leave the building again. This is the highest-leverage hour in the brief.

---

## Definition of done

- [ ] `npm test` green; `geo`, `beacon`, `profile`, `match` unit-tested with no device
- [ ] Start button unlocks all three sensors in one tap on a real iPhone in Safari
- [ ] Arrow tracks a real compass; verified against a physical compass
- [ ] Beacon pans left/right correctly — verify with headphones, eyes shut
- [ ] `?sim=1` replays a track end-to-end with no hardware
- [ ] Zero API keys in the bundle: `grep -rE "AIza|sk-|AKIA" dist/` is empty
- [ ] No arrow ever renders for a tier 2/3 entrance — write a test that asserts this
- [ ] Works in Safari with VoiceOver on

## Report back

Push to a branch `app/<area>`, open a PR, and in the PR body state: what's done,
what's stubbed, every deviation from this brief and why. Do not silently redesign.
If the contract blocks you, say so in the PR rather than working around it.
