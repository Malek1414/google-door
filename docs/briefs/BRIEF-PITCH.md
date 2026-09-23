# BRIEF-PITCH — deck, script, shot list

**For:** a delegated build agent. **Owner on review:** Malek.
**Event:** Google x Aktion Mensch, "AI Agents for Inclusion", Berlin.
**Freeze Thu 10:00. Pitch Thu 12:00. Stage language: German.**

## The one sentence

> Google Maps weiss, dass das Gebaeude barrierefrei ist.
> Es weiss nicht, welche Tuer.
>
> *Google Maps knows the building is accessible. It doesn't know which door.*

---

## Evidence — all verified against OpenStreetMap on 2026-09-23. Use exact numbers.

**Berlin Hauptbahnhof**
- **109** mapped entrance nodes
- **9** tagged step-free · **9** tagged explicitly NOT step-free · **91 (83%) say nothing**
- Two doors, both named `Hauptbahnhof`, both `level=0`, **36.9 metres apart** —
  one step-free (`node/4398651551`), one not (`node/390962614`)
- `Eingang Europaplatz` and `Eingang Washingtonplatz` are both tagged step-free,
  but Europaplatz is a **revolving door**. A boolean cannot tell you that.

**Berlin Mitte overall**
- **2,706** mapped entrance nodes · only **140** carry `wheelchair=yes`

**CODE University** (check live before the pitch)
- ~37 entrance nodes nearby, essentially **none** with a wheelchair tag.
- If the team surveys and uploads tonight, this becomes the strongest beat in the deck:
  *"There was no data for our own university. We surveyed it in twenty minutes."*

Do not round, do not embellish, do not invent a figure. If a number isn't in this
file or in `pipeline/fixtures/`, it does not go on a slide.

---

## Three-minute structure

| t | beat | content |
|---|---|---|
| 0:00–0:25 | **The problem, through one person** | Erden, partially blind. He can follow Live View to the pin. Then he's standing outside a building with no idea which of its doors he can use. Not an edge case — his week. |
| 0:25–1:00 | **The gap, with numbers** | Hauptbahnhof. 109 doors. Nine work, nine don't, 91 unknown. Maps shows one pin. Land the 37-metre pair here. |
| 1:00–2:15 | **Doorway** | Live demo or film. Open, pick the entrance, Live View, arrow, beacon rising, arrival. Show the revolving-door warning — that's the moment judges realise this isn't a boolean. |
| 2:15–2:40 | **The agent** | Tier 3: Gemini reads reviews disabled people already wrote and reads them back, quoted and attributed. The knowledge existed. Nobody indexed it. |
| 2:40–3:00 | **Why Google should build this** | Places already carries a wheelchair boolean. The door coordinates are the missing primitive. We surveyed a campus in twenty minutes — this scales through Local Guides. |

**The theme is AI *Agents* for Inclusion.** Weight the Tier-3 beat accordingly: an
agent reading the web's existing lived-experience knowledge is more on-theme than
an arrow. Do not let the AR visuals crowd it out.

---

## Shot list — tonight, 20:00–21:00. Everything else can slip; this cannot.

Two cameras: **A** on Erden and the environment, **B** on the phone screen.
Clap once at the start of each take to sync.

1. **Cold open.** Erden outside the building, phone down, looking for the entrance. No app. 15s.
2. **The wrong door.** Walks to the obvious main entrance. Steps. He stops. 10s.
3. **Open Doorway.** Screen: entrance markers, accessible one distinct. 10s.
4. **Live View.** Arrow acquires. Over-the-shoulder, screen and street both legible. 20s.
5. **Beacon.** Rising pulse as he closes. **Record clean audio** — the beacon is
   half the product and phone-speaker capture will not survive a PA system.
6. **Arrival.** Glyph pulses, one long haptic, he reaches the step-free door. 15s.
7. **The revolving-door line.** App warns him. 10s. Cut this in even if short.
8. **Erden to camera, unscripted.** "What is this like for you normally?" 30s.
   His own words will outperform anything written for him.
9. **The survey.** Team tagging a door, pushing to OSM. Screen capture of the edit. 20s.

**Consent and privacy:** Erden agrees on camera to the footage being shown publicly.
Blur bystander faces. Keep keyframes only.

**Erden is the demo.** He is not a testimonial after the product — he is the thread
through it. If a shot has to go, cut a UI shot, never one of him.

---

## Deck

Max 10 slides, one idea each, German. Minimum 28pt. Since this is an accessibility
pitch, the deck itself must pass: high contrast, no colour-only meaning, alt text
on every image, captions burned into every video clip.

A deck about inclusion that is itself inaccessible will be noticed. Assume it will.

## Definition of done

- [ ] Deck in `pitch/`, 10 slides, German, contrast-checked
- [ ] 3-minute script, timed out loud, twice
- [ ] Backup video exported 1080p with burned-in captions — plays with no network
- [ ] Every number traced to `pipeline/fixtures/` or this file
- [ ] Erden's consent recorded
- [ ] Rehearsed twice on site before 10:00
