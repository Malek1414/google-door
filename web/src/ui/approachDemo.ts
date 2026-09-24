// Scripted dev adapter for ?approach=demo (stage and screenshots; kept on purpose).
//
// Fakes the engine with a scripted list of views. It reads no sensors and makes no
// network calls, so it cannot fail on stage.
//
// ?approach=demo              plays the script, one step every 2.5 s, then holds in `through`.
//                              "Noch draußen" goes back to threshold; like the real engine's
//                              stillness rule, `through` is proposed again after STILL_MS.
// ?approach=demo&phase=X      holds the first step of phase X (for screenshots)
//
// Words and pitch come from core/instruct.ts, as they do in the real engine.

import { bandFor, bandText, fallbackLine, metresLine, noDirectionLine, pitchFor, safetyLine, thresholdLine, throughLine, unsureLine } from '../core/instruct'
import { lang } from '../strings'
import type { ApproachSession, ApproachView, Phase, StartApproach } from './approachPort'

const L = lang
const dir = (deg: number, m: number, extra: Partial<ApproachView> = {}): ApproachView => ({
  phase: 'walking',
  relBearingDeg: deg,
  distanceM: m,
  instruction: `${bandText(bandFor(deg), L)} ${metresLine(m, L)}`,
  source: 'gemini-live',
  unsure: false,
  beaconPitch: pitchFor(deg),
  ...extra,
})

export const DEMO_SCRIPT: readonly ApproachView[] = [
  // No direction yet: vision has nothing and the door has no surveyed bearing. No arrow.
  { phase: 'orienting', relBearingDeg: null, distanceM: null, instruction: noDirectionLine(L), source: null, unsure: false },
  dir(-64, 7, { phase: 'orienting', instruction: bandText(bandFor(-64), L) }),
  dir(-22, 7, { phase: 'orienting', instruction: bandText(bandFor(-22), L) }),
  dir(-4, 6),
  dir(3, 4, { source: 'osm-fallback', instruction: `${fallbackLine(L)} ${bandText(bandFor(3), L)}` }),
  dir(12, 3, { source: 'gemini-frame', unsure: true, instruction: unsureLine(L) }),
  { phase: 'threshold', relBearingDeg: 1, distanceM: 1.2, instruction: thresholdLine(L), source: 'gemini-frame', unsure: true },
  { phase: 'through', relBearingDeg: null, distanceM: null, instruction: throughLine(L), source: 'gemini-frame', unsure: true },
]

const STEP_MS = 2500
/** Mirrors the engine's stillness rule: standing at the threshold this long proposes `through`. */
const STILL_MS = 4000

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
      : setInterval(() => {
          if (i >= DEMO_SCRIPT.length - 1) return
          emit(DEMO_SCRIPT[++i])
        }, STEP_MS)

  let still: ReturnType<typeof setTimeout> | undefined
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
      if (still) clearTimeout(still)
      i = DEMO_SCRIPT.findIndex((v) => v.phase === 'threshold')
      emit(DEMO_SCRIPT[i])
      if (holdAt < 0) still = setTimeout(() => emit(DEMO_SCRIPT[(i = DEMO_SCRIPT.length - 1)]), STILL_MS)
    },
    stop() {
      if (timer) clearInterval(timer)
      if (still) clearTimeout(still)
      subs.clear()
    },
  }
  return session
}
