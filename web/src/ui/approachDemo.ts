// TEMPORARY dev adapter. Delete once core/approach.ts lands and nothing imports it.
//
// Fakes an engine with a scripted list of views so the Approach screen can be shown
// with ?approach=demo before Malek's core exists. It reads no sensors and makes no
// calls. The words here are placeholders; the real ones come from core/instruct.ts.
//
// ?approach=demo              plays the script, one step every 2.5 s, then stays in `through`
// ?approach=demo&phase=X      holds the first step of phase X (for screenshots)

import { safetyLine } from '../core/instruct'
import { lang } from '../strings'
import type { ApproachSession, ApproachView, Phase, StartApproach } from './approachPort'

export const DEMO_SCRIPT: readonly ApproachView[] = [
  { phase: 'orienting', relBearingDeg: -64, distanceM: 7, instruction: 'Links', source: 'gemini-live', unsure: false, beaconPitch: 330 },
  { phase: 'orienting', relBearingDeg: -22, distanceM: 7, instruction: 'Leicht links', source: 'gemini-live', unsure: false, beaconPitch: 520 },
  { phase: 'walking', relBearingDeg: -4, distanceM: 6, instruction: 'Geradeaus', source: 'gemini-live', unsure: false, beaconPitch: 740 },
  { phase: 'walking', relBearingDeg: 3, distanceM: 4, instruction: 'Geradeaus', source: 'osm-fallback', unsure: false, beaconPitch: 740 },
  { phase: 'walking', relBearingDeg: 12, distanceM: 3, instruction: 'Ich bin mir gerade unsicher.', source: 'gemini-frame', unsure: true, beaconPitch: 640 },
  { phase: 'threshold', relBearingDeg: 1, distanceM: 1.2, instruction: 'Die Tür ist direkt vor dir.', source: 'gemini-frame', unsure: true },
  { phase: 'through', relBearingDeg: null, distanceM: null, instruction: 'Du bist drin.', source: 'gemini-frame', unsure: true },
]

const STEP_MS = 2500

export const startDemoApproach: StartApproach = () => {
  const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  const hold = q.get('phase') as Phase | null
  const holdAt = hold ? DEMO_SCRIPT.findIndex((v) => v.phase === hold) : -1
  // Like the real engine: the session opens with the safety line, then the script.
  let i = holdAt >= 0 ? holdAt : -1
  let view: ApproachView =
    i >= 0 ? DEMO_SCRIPT[i] : { phase: 'orienting', relBearingDeg: null, distanceM: null, instruction: safetyLine(lang), source: null, unsure: false }
  const subs = new Set<(v: ApproachView) => void>()
  const emit = (v: ApproachView) => {
    view = v
    subs.forEach((cb) => cb(v))
  }
  const timer =
    holdAt >= 0
      ? 0
      : window.setInterval(() => {
          if (i >= DEMO_SCRIPT.length - 1) return
          emit(DEMO_SCRIPT[++i])
        }, STEP_MS)

  const session: ApproachSession = {
    subscribe(cb) {
      subs.add(cb)
      cb(view)
      return () => subs.delete(cb)
    },
    stillOutside() {
      // What the real engine does: back to threshold, and the script stops advancing so
      // it does not walk straight back into `through`.
      if (timer) clearInterval(timer)
      i = DEMO_SCRIPT.findIndex((v) => v.phase === 'threshold')
      emit({ ...DEMO_SCRIPT[i], instruction: 'Weiter zur Tür.' })
    },
    stop() {
      if (timer) clearInterval(timer)
      subs.clear()
    },
  }
  return session
}
