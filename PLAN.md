# Google Doorway: plan summary
Status: Sep 23, 2026, evening. Google x Aktion Mensch Hackathon "AI Agents for Inclusion", Berlin.
**Code freeze Sep 24, 10:00. Pitch 12:00.**

## The problem
Wheelchair users and blind people don't know in advance which entrance works for them or how to get from the entrance to the toilet. Google Maps has almost no data on either.

## The idea
1. **Business side**: in the business profile the owner ticks "Accessibility", places the entrances on the map and films the way from the entrance to the toilet once, tapping marks along the way (door, step/ramp, elevator, toilet).
2. **User side**: choose a profile (wheelchair / blind), find the place, see the right entrances on the map, then get guided inside the building to the toilet with arrows on the floor (AR) or a giant high-contrast arrow, plus voice and haptics.
3. **Community**: anyone can film routes, like Local Guides. Every recording makes the landmark graph denser.
4. **Win-win**: maintained accessibility data ranks the business higher in search. We pitch this as a product proposal to Google and show a simulated visibility score in the demo.

## Core idea: landmarks, not a replayed path
People never walk the same line twice. So guidance navigates **from landmark to landmark**, not along the recorded path.
- Every mark and every turn becomes a **node** with a 3D position, a keyframe and a name. The recorded walks only provide the **edges** (which landmarks connect).
- Recognition on three levels:
  1. **ARKit world map** (geometry, instant, 60 Hz): recognizes the room from distinctive visual feature points, however the user walks in.
  2. **Apple Vision feature prints** (appearance, about 20 ms): compares the current frame with the landmark keyframes as a backup.
  3. **Gemini** (meaning, about 1 s): names landmarks ("green door with WC sign") and confirms them live.
- The arrow points to the **next landmark that leads to the target** (shortest path in the graph). If the user skips one or comes from another side, the app picks the nearest node that still works.
- We have no floor plan, so the arrow only follows edges we know are walkable, never straight through walls.

## Platform
| Part | Tech |
|---|---|
| iOS app (both sides) | Swift, SwiftUI, ARKit + RealityKit, Apple Vision, Core Haptics, AVAudioEngine |
| Map in the app | **Google Maps SDK for iOS** + Places SDK with our entrance markers on top. No Maps clone. 3D SDK if available, otherwise the tilted normal map. |
| Business web page | Next.js + Maps JavaScript API, frontend only with static data |
| Voice + hazards | **Gemini Live API** through one tiny token endpoint, so the API key never goes into the app |
| Cloud | Google Cloud project `google-doorway`: Gemini API, Maps SDK for iOS, Places API (New), Maps JavaScript API, Map Tiles API. Cloud Run for the token endpoint is an option. |

The app starts with one choice: **"I run a business"** (Record + Review) or **"I'm visiting"** (profile, place, Go).

**Principle: everything that moves the arrow runs on the phone, and everything that needs understanding runs in Gemini.** The network is never in the critical path of the arrow.

## Demo-first scope
The backend doesn't need to be real. What counts is what the demo shows.

| Real | Faked |
|---|---|
| ARKit recording: path, marks, world map | server processing, uploads, database |
| Landmark graph and waypoints built on the phone | business web page with hardcoded data |
| Instructions from templates on the phone | Gemini video labeling (stretch goal) |
| Live guidance fully offline: floor arrows, giant arrow, haptics, spatial earcon | map entrances from fixture data |
| Gemini Live voice via the token endpoint, Apple TTS as fallback | |

## How it works
**Record (business, iOS)**
- ARKit session: camera path at 10 Hz, four big mark buttons (door, step/ramp, elevator, toilet) that drop anchors, narration in the audio, world map saved at the end.
- Start at the entrance, facing the door. The first pose is the origin.
- Afterwards a review screen: confirm, rename or delete landmarks, then publish.

**Go (user, iOS)**
1. Load the route and world map, "point the camera at the entrance", ARKit relocalizes.
2. Every frame: position → nearest graph node → arrow to the next node toward the target.
3. Trigger zones: **2.5 m before** a landmark the direction goes to Gemini Live so it's spoken in time (hides the ~1 s latency), **0.8 m before** comes a haptic plus an earcon from the direction to turn, **within 1 m** it counts as reached.
4. Off route (more than 2 m off for 3 s): "Stop", the arrow points back.
5. Fallbacks if relocalization fails after 10 s: start-pose alignment (ARKit odometry from the entrance), then Vision matching, then step cards to tap through.

**Views (same state for all)**
- **AR view**: RealityKit chevrons on the floor to the next landmark, a big 3D arrow at the turn, the distance.
- **Giant arrow**: full screen, contrast modes black/yellow, black/white and white/black. Color-blind safe because only shape and brightness carry meaning. Dynamic Type, VoiceOver.
- **Blind profile**: giant arrow with the screen dimmed, a spatial earcon from the real direction (best with headphones), haptic patterns: left = two short, right = three short, arrived = one long.

**Gemini Live**
- WebSocket from the app, short-lived token from the server. Mic 16 kHz and camera frames at 1 fps upstream, 24 kHz audio downstream.
- The phone decides the position, Gemini speaks. The app sends events ("2.5 m before w4, turn left at the green door"), and Gemini turns them into natural speech.
- Tools: `warn(hazard)` for things it sees (people, an open door, a wet-floor sign) and answers to free questions ("Is there a handrail?").

## Latency targets (to be measured)
| Step | Target |
|---|---|
| Position update (ARKit) | 16 ms |
| Landmark reached → haptic + earcon | < 50 ms |
| Spoken direction (Gemini Live) | 0.8 to 1.5 s, hidden by the 2.5 m early trigger |
| Hazard warning from the camera | about 1 s |

## Data (on the phone, JSON)
- `path.json`: `{hz, samples: [{t, p: [x,y,z], yaw, tracking}]}`
- `marks.json`: `[{t, type: door|step|ramp|elevator|toilet, anchor, p}]`
- `route.json`: `id`, `placeId`, `worldmap`, `nodes[]` (`id`, `p`, `type`, `name`, `image`, `instruction {de,en}`, `blind_hint {de,en}`, `hazards[]`, `wheelchair_ok`), `edges[]` (`from`, `to`, `dist_m`), `target` (node id of the toilet)
- Place fixture: `entrances[]` with `lat/lng`, `main`, `type` (step_free|ramp|steps|elevator), `door` (width, automatic, bell, heavy), `blind` (tactile, announcement, contrast), `photo`, `note`, `source`, `confirmed`

## Roles (orchestrated Claude terminals)
| Role | Owns | Delivers |
|---|---|---|
| **ORCH** (Sami) | `docs/`, contracts, merges | everything integrated, demo runs |
| **IOS-REC** | `ios/Doorway/Record/`, `ios/Doorway/Shared/` | start screen, AR recording, marks, world map, landmark graph, review |
| **IOS-GO** | `ios/Doorway/Go/` | relocalization, graph navigation, AR view, giant arrow, haptics, earcons, fallbacks |
| **LIVE** | `ios/Doorway/Live/`, token endpoint | Gemini Live client, audio in/out, events, hazard tool, TTS fallback |
| **MAP** | `ios/Doorway/Map/`, `web/` | Google Maps SDK map with entrance markers in the app, business web page |
| **PITCH** | `pitch/` | German deck, 3-minute script, video shot list |

Xcode: one project in `ios/`, Swift 6, iOS 18+, **folder-synchronized groups**, so parallel terminals don't collide in `project.pbxproj`. Only IOS-REC changes project settings.

Agents on the same Mac message each other directly. Across both Macs, `docs/board/<ROLE>.md` is each role's inbox and `docs/board/STATUS.md` holds the overall state: pull before every task, push after every milestone.

## Demo
- **Location: CODE University Berlin** (the museum is off). Film **two different walks** from the entrance to the toilet today, 20:00 to 21:00.
- In the demo someone walks a **third way**, and the app still finds the landmarks.
- Stage flow, 3 minutes: problem (20 s) → business side (60 s) → user side (80 s) → why Google should build it (20 s).
- Backup: a screen recording of a real walk. Video with two cameras: one on the screen, one on the person walking.
- Other people in the frame: only keyframes are kept, and faces get blurred.

## Timeline
| Time | Goal |
|---|---|
| 17:00 | AR recording writes path, marks and world map on the iPhone. Giant arrow runs from fixture data. Token endpoint answers. |
| 19:00 | Landmark graph + review on the phone. Relocalization + AR view. Gemini Live speaks. Map with markers. |
| 20:00–21:00 | Two walks filmed at CODE University. |
| 23:00 | Full run: record → review → guide, including the third way. Triggers, haptics, earcons. |
| 23:00–07:00 | Design pass, accessibility of the app itself, fallbacks, sleep in shifts. |
| 07:00–10:00 | Two rehearsals on site, deck done. **10:00 freeze.** |
| 10:00–12:00 | Stage rehearsals, backup video. |

## Open points
1. Set up the Google Cloud project and keys (Sami). Keys go into `.env` only, never into code, the app or the chat.
2. Does the demo iPhone have LiDAR? Default: build without it.
3. A quote from an affected person (wheelchair user or blind) for the pitch: ask the mentors.
4. What the Antigravity accounts are used for: decide later.
5. Voice language on stage: German by default.
