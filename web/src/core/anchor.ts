// Projecting a vision fix forward. Pure, no I/O.
//
// A door fix is the truth at the moment the frame was taken and stale immediately
// after: the user keeps turning and walking while the model thinks. At 1–2 s per fix
// and a person turning at 60°/s, a fix is ninety degrees out of date by the time it
// lands.
//
// So the fix is an ANCHOR, and the compass and step counter carry it forward:
//
//     bearing now = bearing at fix − (heading now − heading at fix)
//
// The phone turning right moves a fixed door's relative bearing left, hence the minus.
//
// Distance uses step count rather than GPS, because GPS accuracy is 5–30 m and the
// whole feature happens inside that error bar.

import { angleDelta } from './stability'

/** Metres per step. Conservative: under-reporting progress is safer than over. */
export const STEP_M = 0.68
/** A projection older than this is not trustworthy enough to speak. */
export const MAX_AGE_MS = 8000

export interface Anchor {
  /** Door bearing relative to the camera at the moment of the fix, negative left. */
  bearingDeg: number
  /** Compass heading at the moment of the fix. */
  headingDeg: number
  /** Metres to the door at the moment of the fix. */
  distanceM: number
  /** Step count at the moment of the fix. */
  steps: number
  ts: number
  source: 'gemini-live' | 'gemini-frame' | 'osm-fallback'
}

export interface Projection {
  /** Door bearing relative to where the camera points NOW. */
  relBearingDeg: number
  /** Estimated metres remaining. Never negative. */
  distanceM: number
  /** How old the anchor is, in ms. */
  ageMs: number
  /** False once the anchor is too old to speak from. */
  fresh: boolean
  source: Anchor['source']
}

/**
 * Where the door is now, given an anchor and the sensors since.
 *
 * Only the component of walking that goes TOWARD the door counts against the distance:
 * walking sideways past a door does not bring you closer, and treating every step as
 * progress would have the app announce arrival while the user is still walking past.
 */
export function project(
  anchor: Anchor,
  headingNowDeg: number,
  stepsNow: number,
  nowMs: number,
): Projection {
  const ageMs = Math.max(0, nowMs - anchor.ts)
  const turned = angleDelta(anchor.headingDeg, headingNowDeg)
  const relBearingDeg = angleDelta(0, anchor.bearingDeg - turned)

  const walked = Math.max(0, stepsNow - anchor.steps) * STEP_M
  // Project the walk onto the direction of the door as it was at the anchor.
  const towards = walked * Math.cos((anchor.bearingDeg * Math.PI) / 180)
  const distanceM = Math.max(0, anchor.distanceM - towards)

  return {
    relBearingDeg,
    distanceM,
    ageMs,
    fresh: ageMs <= MAX_AGE_MS,
    source: anchor.source,
  }
}

/** Has the user moved or turned enough that the anchor should be refreshed? */
export function needsReanchor(
  anchor: Anchor,
  headingNowDeg: number,
  stepsNow: number,
  nowMs: number,
  turnDeg = 25,
  walkM = 3,
): boolean {
  if (nowMs - anchor.ts > MAX_AGE_MS) return true
  if (Math.abs(angleDelta(anchor.headingDeg, headingNowDeg)) >= turnDeg) return true
  return (stepsNow - anchor.steps) * STEP_M >= walkM
}
