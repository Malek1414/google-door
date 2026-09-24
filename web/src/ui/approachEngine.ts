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

const TIMEOUT_MS = 15000

interface VisionReply {
  fix: VisionFix | null
  inside: boolean
}

async function requestFix(deps: EngineDeps, base: string, frame: string, headingDeg: number): Promise<VisionReply | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await deps.fetch(`${base}/api/door-fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame, headingDeg }),
      signal: ctl.signal,
    })
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
    let failures = 0
    let saidUnsure = false
    let lastBand: Band | null = null
    let lastPhase = approach.currentPhase
    let lastSourceSpoken: DoorFixSource | null = null
    let stopped = false
    let pendingUnsure = false
    let pendingNoDirection = false
    let saidNoDirection = false

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

    const fallbackAnchor = (): Anchor | null => {
      const b = io.door.approachBearing
      if (b === null || !Number.isFinite(b) || heading === null) return null
      // approachBearing is the compass heading you face walking in; relative to where
      // the phone points now, that is the door's direction.
      return { bearingDeg: angleDelta(heading, b), headingDeg: heading, distanceM: FALLBACK_ASSUMED_M, steps, ts: deps.now(), source: 'osm-fallback' }
    }

    /** Is the current anchor still young enough to speak from? (Read-only: no tick.) */
    const anchorFresh = () => anchor !== null && deps.now() - anchor.ts <= MAX_AGE_MS

    const maybeRequest = (st: ApproachState) => {
      if (inFlight || heading === null || approach.currentPhase === 'through') return
      const now = deps.now()
      const due = guard.mode === 'live' ? now - lastRequestAt >= LIVE_EVERY_MS : st.needsFix && now - lastRequestAt >= ONDEMAND_MIN_GAP_MS
      if (!due) return
      const frame = io.frame()
      if (!frame) return
      // The fix is the truth at the moment of the frame: anchor it to the heading,
      // steps and time of the frame, not of the answer.
      const at = { heading, steps, ts: now }
      inFlight = true
      lastRequestAt = now
      void requestFix(deps, io.apiBase, frame, at.heading).then((reply) => {
        inFlight = false
        if (stopped) return
        const fix = reply?.fix ?? null
        const wasLive = guard.mode === 'live'
        const verdict = fix ? guard.push({ bearingDeg: fix.bearingDeg, headingDeg: at.heading, confidence: fix.confidence }) : null
        if (fix && verdict?.trusted) {
          failures = 0
          anchor = { bearingDeg: fix.bearingDeg, distanceM: fix.distanceM, headingDeg: at.heading, steps: at.steps, ts: at.ts, source: fix.source }
          approach.setAnchor(anchor)
        } else {
          failures += 1
          // Never at the threshold: losing the door there is expected (the user is AT
          // it), and a map anchor would demote them to walking with a wrong direction.
          if (failures >= FALLBACK_AFTER && !anchorFresh() && approach.currentPhase !== 'threshold') {
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
        // Interior proposes "through". Only from a reply the guard did not reject: a
        // found fix must be trusted; a found:false reply (entrance behind the camera,
        // as it is indoors) carries no bearing for the guard to judge.
        if (reply?.inside && (!fix || verdict?.trusted)) approach.visionSaysInside()
        if (wasLive && guard.hasFallenBack) pendingUnsure = true
        tick()
      })
    }

    const tick = () => {
      if (stopped || heading === null) return
      // A map anchor that has aged out is simply re-minted: the surveyed bearing does
      // not go stale, and letting it lapse drops the beacon every MAX_AGE_MS.
      if (anchor?.source === 'osm-fallback' && !anchorFresh() && approach.currentPhase !== 'threshold') {
        const fb = fallbackAnchor()
        if (fb) {
          anchor = fb
          approach.setAnchor(fb)
        }
      }
      const st = approach.tick({ headingDeg: heading, steps, nowMs: deps.now() })
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
      emit({
        phase: st.phase,
        relBearingDeg: aim ? aim.relBearingDeg : null,
        distanceM: aim && aim.source !== 'osm-fallback' ? aim.distanceM : null,
        instruction: lines.length ? lines.join(' ') : view.instruction,
        source: source ?? view.source,
        unsure: guard.hasFallenBack,
        beaconPitch: aim ? pitchFor(aim.relBearingDeg) : undefined,
      })
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
        // Core takes the proposal back and restarts its stillness clock.
        approach.stillOutside()
        lastPhase = approach.currentPhase
        lastBand = null
        tick()
      },
      stop() {
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
