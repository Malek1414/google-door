// The last 10 metres. Pure, no I/O.
//
// Google Maps navigation ends at a pin on a building. This begins there and ends when
// the user is through the door.
//
//     orienting → walking → threshold → through
//
// Orienting comes first and is not skippable: someone who has just been told "you have
// arrived" has no idea which way they are facing, and walking before you are aimed is
// how people end up in the road. The beacon does the turning; this only decides when
// the turning is done.

import { bandFor, shouldSpeakDistance, type Band } from './instruct'
import { project, needsReanchor, type Anchor, type Projection } from './anchor'

export type Phase = 'orienting' | 'walking' | 'threshold' | 'through'

/** Bearing error that counts as aimed. Matches the "straight ahead" band. */
export const AIMED_DEG = 8
/** Hysteresis: once walking, the user may drift this far before being re-aimed.
 *  Without it a person swaying while walking would be bounced back to orienting. */
export const LOST_AIM_DEG = 35
/** Under this, the door is within reach. */
export const THRESHOLD_M = 1.5

export interface Sensors {
  headingDeg: number
  steps: number
  nowMs: number
}

export interface ApproachState {
  phase: Phase
  /** Null when there is no usable anchor — the UI must say so, not guess. */
  projection: Projection | null
  band: Band
  /** Step to announce this tick, or null. */
  speakDistanceM: number | null
  /** True the first tick after the anchor stopped being trustworthy. */
  lostFix: boolean
  needsFix: boolean
}

export class Approach {
  private phase: Phase = 'orienting'
  private anchor: Anchor | null = null
  private lowestSpoken: number | null = null
  private wasStale = false
  private confirmedThrough = false

  /** Feed a fresh vision (or fallback) fix. */
  setAnchor(a: Anchor): void {
    this.anchor = a
  }

  /** The user pressed "Noch draußen": vision was wrong, keep guiding. */
  stillOutside(): void {
    this.confirmedThrough = false
    if (this.phase === 'through') this.phase = 'threshold'
  }

  /** Vision reports interior. Proposes, does not decide — see stillOutside. */
  visionSaysInside(): void {
    this.confirmedThrough = true
  }

  get currentPhase(): Phase {
    return this.phase
  }

  tick(s: Sensors): ApproachState {
    if (!this.anchor) {
      return { phase: this.phase, projection: null, band: 'straight', speakDistanceM: null, lostFix: false, needsFix: true }
    }

    const p = project(this.anchor, s.headingDeg, s.steps, s.nowMs)

    // A stale anchor is reported once and then stops producing guidance. Guidance that
    // keeps speaking confidently while drifting is the failure that actually hurts.
    if (!p.fresh) {
      const lostFix = !this.wasStale
      this.wasStale = true
      return { phase: this.phase, projection: p, band: 'straight', speakDistanceM: null, lostFix, needsFix: true }
    }
    this.wasStale = false

    const band = bandFor(p.relBearingDeg)
    const aimed = Math.abs(p.relBearingDeg) <= AIMED_DEG

    if (this.confirmedThrough) {
      this.phase = 'through'
    } else if (this.phase === 'orienting') {
      if (aimed) this.phase = 'walking'
    } else if (this.phase === 'walking') {
      if (p.distanceM <= THRESHOLD_M) this.phase = 'threshold'
      // Hysteresis, not AIMED_DEG: a person sways while walking, and bouncing them
      // back to orienting every few steps would make the mode unusable.
      else if (Math.abs(p.relBearingDeg) > LOST_AIM_DEG) this.phase = 'orienting'
    } else if (this.phase === 'threshold') {
      if (p.distanceM > THRESHOLD_M * 2) this.phase = 'walking'
    }

    // Distance is only spoken while walking: during orienting the user is standing
    // still and the number never changes.
    let speakDistanceM: number | null = null
    if (this.phase === 'walking' || this.phase === 'threshold') {
      speakDistanceM = shouldSpeakDistance(this.lowestSpoken, p.distanceM)
      if (speakDistanceM !== null) this.lowestSpoken = speakDistanceM
    }

    return {
      phase: this.phase,
      projection: p,
      band,
      speakDistanceM,
      lostFix: false,
      needsFix: needsReanchor(this.anchor, s.headingDeg, s.steps, s.nowMs),
    }
  }

  reset(): void {
    this.phase = 'orienting'
    this.anchor = null
    this.lowestSpoken = null
    this.wasStale = false
    this.confirmedThrough = false
  }
}
