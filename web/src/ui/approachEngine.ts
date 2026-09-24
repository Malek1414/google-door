// The real StartApproach: Malek's core composed the way web/test/approach-e2e.test.ts
// composes it, plus the I/O the core deliberately has none of (compass, steps, the
// /api/door-fix loop). The screen renders ApproachView and holds no guidance logic.
//
//   compass ─┐
//   steps ───┼─► Approach.tick (100 ms) ─► ApproachView ─► screen (speech, beacon, arrow)
//   vision ──┘   ▲ setAnchor only for fixes the StabilityGuard trusts
//
// Vision cadence: every LIVE_EVERY_MS while the guard is in 'live', and in 'ondemand'
// only when the core says it needs a fix. Never more than one request in flight.
// After FALLBACK_AFTER tries without a trusted fix, the anchor comes from the door's
// surveyed approachBearing instead, and the view says so (source 'osm-fallback').
// GPS does not participate: no geolocation API is touched anywhere in this file.

import { Approach, type ApproachState } from '../core/approach'
import { MAX_AGE_MS, type Anchor } from '../core/anchor'
import {
  type Band,
  bandText,
  fallbackLine,
  metresLine,
  noDirectionLine,
  pitchFor,
  safetyLine,
  thresholdLine,
  throughLine,
  unsureLine,
} from '../core/instruct'
import { StabilityGuard, angleDelta } from '../core/stability'
import { lang as appLang } from '../strings'
import type { ApproachIO, ApproachSession, ApproachView, DoorFixSource, StartApproach } from './approachPort'
import { countSteps } from './stepCounter'

/** Vision cadence while the guard trusts the stream. */
export const LIVE_EVERY_MS = 1500
/** Even on demand, not faster than this. */
export const ONDEMAND_MIN_GAP_MS = 1500
/** Tries without a trusted fix before the map bearing takes over. */
export const FALLBACK_AFTER = 3
/** Assumed distance for a map-bearing anchor. Never shown or spoken: the map gives a
 *  direction, not a distance, and GPS is not allowed to supply one. */
export const FALLBACK_ASSUMED_M = 10
export const TICK_MS = 100
/** CONTRACT "DoorFix": `inside` ends the guidance, so it needs an explicit true at
 *  this confidence or above. A wrong true abandons someone on the pavement. */
export const INSIDE_MIN_CONFIDENCE = 0.6
/** No compass reading this long after the start: say so instead of going silent. */
export const NO_COMPASS_MS = 3000
/** No camera frame this long counts as one vision miss, so the map fallback still fires. */
export const NO_FRAME_MISS_MS = 1500
/** After a 429 from /api/door-fix, wait this long before the next request. */
export const RATE_LIMIT_BACKOFF_MS = 5000
/** One /api/door-fix longer than this is a miss; the next try follows. */
export const DOOR_FIX_TIMEOUT_MS = 8000

// Two lines the engine needs that core/instruct.ts does not have yet (see questions.md).
// Same register as the core lines; move them there once Malek agrees.
export function noCompassLine(lang = 'de'): string {
  return lang.startsWith('de')
    ? 'Ich bekomme keine Kompassrichtung. Halte das Handy aufrecht vor dich.'
    : "I'm not getting a compass direction. Hold the phone upright in front of you."
}
export function searchingLine(lang = 'de'): string {
  return lang.startsWith('de') ? 'Ich suche noch den Eingang. Halte die Kamera nach vorn.' : 'Still looking for the entrance. Hold the camera forward.'
}

export interface EngineDeps {
  fetch: typeof fetch
  now: () => number
  /** Repeating timer. Returns cancel. */
  every: (ms: number, fn: () => void) => () => void
  lang: string
}

const defaultDeps = (): EngineDeps => ({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
  lang: appLang,
})

interface VisionFix {
  bearingDeg: number
  distanceM: number
  confidence: number
  source: DoorFixSource
}

/** Does this /api/door-fix body say "interior"? Only an explicit true at
 *  INSIDE_MIN_CONFIDENCE counts; absent, hedged or low-confidence is "still outside".
 *  Independent of `found`: indoors the entrance is BEHIND the camera, so found is false. */
export function saysInside(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Record<string, unknown>
  return o.inside === true && typeof o.confidence === 'number' && o.confidence >= INSIDE_MIN_CONFIDENCE
}

/** /api/door-fix body -> a usable fix, or null for "no door" in any shape. */
export function parseDoorFix(raw: unknown): VisionFix | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const { bearingDeg, distanceM, confidence } = o
  if (o.found !== true) return null
  if (typeof bearingDeg !== 'number' || !Number.isFinite(bearingDeg)) return null
  if (typeof distanceM !== 'number' || !Number.isFinite(distanceM)) return null
  if (typeof confidence !== 'number' || !(confidence >= 0.5)) return null
  // A vision endpoint cannot hand back a map bearing; never let it claim one.
  const source: DoorFixSource = o.source === 'gemini-live' ? 'gemini-live' : 'gemini-frame'
  return { bearingDeg, distanceM, confidence, source }
}

interface VisionReply {
  fix: VisionFix | null
  inside: boolean
}

/** null: no usable answer (network, 5xx, timeout). 'rate-limited': 429, back off. */
async function requestFix(deps: EngineDeps, base: string, frame: string, headingDeg: number): Promise<VisionReply | 'rate-limited' | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), DOOR_FIX_TIMEOUT_MS)
  try {
    const r = await deps.fetch(`${base}/api/door-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame, headingDeg }),
      signal: ctl.signal,
    })
    if (r.status === 429) return 'rate-limited'
    if (!r.ok) return null
    const raw: unknown = await r.json()
    return { fix: parseDoorFix(raw), inside: saysInside(raw) }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createApproachEngine(overrides: Partial<EngineDeps> = {}): StartApproach {
  return (io: ApproachIO): ApproachSession => {
    const deps = { ...defaultDeps(), ...overrides }
    const L = deps.lang
    const approach = new Approach()
    const guard = new StabilityGuard()
    const subs = new Set<(v: ApproachView) => void>()

    let heading: number | null = null
    let steps = 0
    let anchor: Anchor | null = null
    let inFlight = false
    let lastRequestAt = -Infinity
    let notBefore = -Infinity
    let failures = 0
    let saidUnsure = false
    let lastBand: Band | null = null
    let lastPhase = approach.currentPhase
    let lastSourceSpoken: DoorFixSource | null = null
    let stopped = false
    let pendingUnsure = false
    let pendingNoDirection = false
    let saidNoDirection = false
    const startedAt = deps.now()
    let seq = 0
    let saidNoCompass = false

    // The safety line is the first thing the session ever says, and it is said once.
    let view: ApproachView = {
      phase: 'orienting',
      relBearingDeg: null,
      distanceM: null,
      instruction: safetyLine(L),
      source: null,
      unsure: false,
    }
    let viewKey = JSON.stringify(view)

    const emit = (v: ApproachView) => {
      const key = JSON.stringify(v)
      if (key === viewKey) return
      view = v
      viewKey = key
      subs.forEach((cb) => cb(v))
    }

    /** Say `text` again (or for the first time) even if it equals the current instruction. */
    const remind = (text: string, patch: Partial<ApproachView> = {}) => {
      if (text === noCompassLine(L)) saidNoCompass = true
      seq += 1
      emit({ ...view, ...patch, instruction: text, seq })
    }

    const fallbackAnchor = (): Anchor | null => {
      const b = io.door.approachBearing
      if (b === null || !Number.isFinite(b) || heading === null) return null
      // approachBearing is the compass heading you face walking in; relative to where
      // the phone points now, that is the door's direction.
      return { bearingDeg: angleDelta(heading, b), headingDeg: heading, distanceM: FALLBACK_ASSUMED_M, steps, ts: deps.now(), source: 'osm-fallback' }
    }

    /** Is the current anchor still young enough to speak from? (Read-only: no tick.) */
    const anchorFresh = () => anchor !== null && deps.now() - anchor.ts <= MAX_AGE_MS

    /** One try without a trusted fix: after FALLBACK_AFTER of them, the map bearing. */
    const miss = () => {
      failures += 1
      if (failures >= FALLBACK_AFTER && !anchorFresh()) {
        const fb = fallbackAnchor()
        if (fb) {
          anchor = fb
          approach.setAnchor(fb)
          failures = 0
        } else if (!saidNoDirection) {
          // Vision failed and the door has no surveyed bearing: nothing to point at.
          // Never dead-reckon, but say so: silence reads as a crash.
          pendingNoDirection = true
        }
      }
    }

    const maybeRequest = (st: ApproachState) => {
      if (inFlight || heading === null || approach.currentPhase === 'through') return
      const now = deps.now()
      if (now < notBefore) return
      const due = guard.mode === 'live' ? now - lastRequestAt >= LIVE_EVERY_MS : st.needsFix && now - lastRequestAt >= ONDEMAND_MIN_GAP_MS
      if (!due) return
      const frame = io.frame()
      if (!frame) {
        // No camera picture (denied, not started, backgrounded): count it as a miss at
        // the on-demand cadence, so the map fallback or the no-direction line still come.
        if (now - lastRequestAt >= NO_FRAME_MISS_MS) {
          lastRequestAt = now
          miss()
        }
        return
      }
      // The fix is the truth at the moment of the frame: anchor it to the heading,
      // steps and time of the frame, not of the answer.
      const at = { heading, steps, ts: now }
      inFlight = true
      lastRequestAt = now
      void requestFix(deps, io.apiBase, frame, at.heading).then((got) => {
        inFlight = false
        if (stopped) return
        if (got === 'rate-limited') notBefore = deps.now() + RATE_LIMIT_BACKOFF_MS
        const reply = got === 'rate-limited' ? null : got
        const fix = reply?.fix ?? null
        const wasLive = guard.mode === 'live'
        const verdict = fix ? guard.push({ bearingDeg: fix.bearingDeg, headingDeg: at.heading, confidence: fix.confidence }) : null
        if (fix && verdict?.trusted) {
          failures = 0
          anchor = { bearingDeg: fix.bearingDeg, distanceM: fix.distanceM, headingDeg: at.heading, steps: at.steps, ts: at.ts, source: fix.source }
          approach.setAnchor(anchor)
        } else {
          miss()
        }
        // Interior proposes "through". Only from a reply the guard did not reject: a
        // found fix must be trusted; a found:false reply (entrance behind the camera,
        // as it is indoors) carries no bearing for the guard to judge.
        if (reply?.inside && (!fix || verdict?.trusted)) approach.visionSaysInside()
        if (wasLive && guard.hasFallenBack) pendingUnsure = true
        tick()
      })
    }

    const tick = () => {
      if (stopped) return
      const now = deps.now()
      if (heading === null) {
        // No compass at all: nothing can be pointed at. Say why, and keep saying it now
        // and then, instead of leaving a blind user with the safety line and silence.
        // Said once: it is an event (the compass never came), not a loop.
        if (now - startedAt >= NO_COMPASS_MS && view.instruction !== noCompassLine(L) && !saidNoCompass) remind(noCompassLine(L), { relBearingDeg: null, distanceM: null, beaconPitch: undefined })
        return
      }
      const st = approach.tick({ headingDeg: heading, steps, nowMs: now })
      const lines: string[] = []

      if (pendingUnsure && !saidUnsure) {
        saidUnsure = true
        pendingUnsure = false
        lines.push(unsureLine(L))
      }
      if (pendingNoDirection && !saidNoDirection) {
        saidNoDirection = true
        pendingNoDirection = false
        lines.push(noDirectionLine(L))
      }

      const p = st.projection && st.projection.fresh ? st.projection : null
      const source = p ? p.source : null
      if (p) {
        if (p.source === 'osm-fallback' && lastSourceSpoken !== 'osm-fallback') lines.push(fallbackLine(L))
        lastSourceSpoken = p.source

        // "through" is said below, since it does not need a fresh projection.
        if (st.phase !== 'through') {
          if (st.phase === 'threshold' && lastPhase !== 'threshold' && p.source !== 'osm-fallback') {
            lines.push(thresholdLine(L))
          } else if (st.band !== lastBand) {
            lines.push(bandText(st.band, L))
            lastBand = st.band
          }
        }
        // A map bearing gives a direction, never a distance.
        if (st.speakDistanceM !== null && p.source !== 'osm-fallback') lines.push(metresLine(st.speakDistanceM, L))
      } else if (st.lostFix) {
        // Stop speaking confidently the moment the anchor is stale; the next band is
        // said again once a fix is back.
        lastBand = null
      }
      // Vision can propose "through" from a reply with no door in it, so this does not
      // wait for a fresh projection.
      if (st.phase === 'through' && lastPhase !== 'through') lines.push(throughLine(L))
      lastPhase = st.phase

      // In `through` there is nothing left to point at: no arrow, no metres, no beacon.
      const aim = st.phase === 'through' ? null : p
      const next: ApproachView = {
        phase: st.phase,
        relBearingDeg: aim ? aim.relBearingDeg : null,
        distanceM: aim && aim.source !== 'osm-fallback' ? aim.distanceM : null,
        instruction: lines.length ? lines.join(' ') : view.instruction,
        source: source ?? view.source,
        unsure: guard.hasFallenBack,
        beaconPitch: aim ? pitchFor(aim.relBearingDeg) : undefined,
        ...(view.seq !== undefined ? { seq: view.seq } : {}),
      }
      emit(next)
      // No periodic repeats (Sami: "stop playing the voice when nothing happens"):
      // the voice speaks on events only; the beacon carries the rest.
      maybeRequest(st)
    }

    const offHeading = io.onHeading((h) => {
      if (!Number.isFinite(h.deg)) return
      heading = h.deg
    })
    const offSteps = countSteps(io.onMotion, (n) => (steps = n), deps.now)
    const offTimer = deps.every(TICK_MS, tick)

    return {
      subscribe(cb) {
        subs.add(cb)
        cb(view)
        return () => subs.delete(cb)
      },
      stillOutside() {
        if (stopped) return
        // Core takes the proposal back and restarts its stillness clock.
        approach.stillOutside()
        lastPhase = approach.currentPhase
        lastBand = null
        tick()
      },
      stop() {
        if (stopped) return
        stopped = true
        offTimer()
        offHeading()
        offSteps()
        subs.clear()
      },
    }
  }
}

/** The engine the screen gets by default (see approachPort.engine). */
export const startApproach: StartApproach = createApproachEngine()
