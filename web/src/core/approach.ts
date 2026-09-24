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
/** What proposed `through`: vision saw interior, or the user stood still at the door.
 *  They warrant different words — standing still may just mean "at the handle". */
export type ThroughBy = 'vision' | 'still'

/** Bearing error that counts as aimed. Matches the "straight ahead" band. */
export const AIMED_DEG = 8
/** Hysteresis: once walking, the user may drift this far before being re-aimed.
 *  Without it a person swaying while walking would be bounced back to orienting. */
export const LOST_AIM_DEG = 35
/** Under this, the door is within reach. */
/** Vision may only claim "inside" within this many metres of the door. (Q7) */
export const INSIDE_MAX_M = 4

export const THRESHOLD_M = 1.5
/** Standing still this long at the threshold proposes that the user has gone through.
 *
 *  The spec said "if vision never fires, the threshold phase ends when the user stops",
 *  and nothing implemented it — so `through` was unreachable with the real engine, as
 *  PR #5 found. Stillness is the honest signal: someone who has walked through a door
 *  stops walking. It PROPOSES, exactly as vision does, and "Noch draußen" takes it back. */
export const STILL_MS = 4000

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
  /** Why the phase is `through`; null in every other phase. */
  throughBy: ThroughBy | null
}

export class Approach {
  private phase: Phase = 'orienting'
  private anchor: Anchor | null = null
  private lowestSpoken: number | null = null
  private wasStale = false
  private confirmedThrough = false
  private lastSteps = -1
  private stillSinceMs: number | null = null
  private insideVetoedAtSteps: number | null = null
  private lastDistanceM: number | null = null
  private throughBy: ThroughBy | null = null

  /** Feed a fresh vision (or fallback) fix. */
  setAnchor(a: Anchor): void {
    this.anchor = a
    // Seed the distance before the first tick, so an `inside` arriving with the very
    // first fix is judged on how far the door actually is. A map-bearing anchor has no
    // distance of its own (it is an assumed placeholder), so it seeds nothing.
    if (this.lastDistanceM === null && a.source !== 'osm-fallback') this.lastDistanceM = a.distanceM
  }

  /** The user pressed "Noch draußen": the proposal was wrong, keep guiding.
   *  Also restarts the stillness clock, so simply standing there does not immediately
   *  re-propose the thing they just rejected. */
  stillOutside(): void {
    this.confirmedThrough = false
    this.stillSinceMs = null
    this.throughBy = null
    // The user has just told us the last claim was wrong. Do not make it again until
    // something has actually changed — that is, until they have walked further.
    this.insideVetoedAtSteps = this.lastSteps
    if (this.phase === 'through') this.phase = 'threshold'
  }

  /**
   * Vision reports interior. Proposes, does not decide — see stillOutside.
   *
   * Refused while the door is still metres away. (Q7) A camera pointed through a glass
   * front from across the pavement sees a lobby, and "you are inside" there ends the
   * mode before it began. Distance, not phase, is the discriminator: the user can be
   * at the door in any phase, and the last good projection is still the best estimate
   * of how far away they are even after vision has lost the door.
   */
  visionSaysInside(): void {
    if (this.lastDistanceM !== null && this.lastDistanceM > INSIDE_MAX_M) return
    if (this.insideVetoedAtSteps !== null && this.lastSteps <= this.insideVetoedAtSteps) return
    this.confirmedThrough = true
  }

  get currentPhase(): Phase {
    return this.phase
  }

  tick(s: Sensors): ApproachState {
    // Honoured before the anchor checks below, because walking through a door is
    // exactly when vision loses the door: gating the one signal that ends the mode
    // behind a fresh anchor means it can arrive too late to be worth anything. (Q6)
    if (this.confirmedThrough) {
      this.phase = 'through'
      this.throughBy = 'vision'
    }

    if (!this.anchor) {
      return { phase: this.phase, projection: null, band: 'straight', speakDistanceM: null, lostFix: false, needsFix: true, throughBy: this.throughBy }
    }

    const p = project(this.anchor, s.headingDeg, s.steps, s.nowMs)
    // A map-bearing anchor gives a direction, never a distance: its distanceM is an
    // assumed placeholder, and stepping it down would be dead reckoning (rule 2). So it
    // drives no distance rule, no stillness and no `inside` gate.
    const mapOnly = this.anchor.source === 'osm-fallback'

    // Stillness is only meaningful at the threshold; anywhere else a pause is just a
    // pause. Reset the clock on any step. Runs before the freshness check: at the door
    // is exactly where vision loses the door, and a stale anchor there must not make
    // `through` unreachable.
    if (s.steps !== this.lastSteps) {
      // Walked on since rejecting a proposal: vision may claim "inside" again.
      if (this.insideVetoedAtSteps !== null && s.steps > this.insideVetoedAtSteps) this.insideVetoedAtSteps = null
      this.lastSteps = s.steps
      this.stillSinceMs = null
    } else if (this.phase === 'threshold' && !mapOnly && this.stillSinceMs === null) {
      this.stillSinceMs = s.nowMs
    }
    const stoodStill = this.phase === 'threshold' && !mapOnly && this.stillSinceMs !== null && s.nowMs - this.stillSinceMs >= STILL_MS

    // A stale anchor is reported once and then stops producing guidance. Guidance that
    // keeps speaking confidently while drifting is the failure that actually hurts.
    if (!p.fresh) {
      const lostFix = !this.wasStale
      this.wasStale = true
      // Stood still at the door long enough: propose through even without a fresh fix.
      if (stoodStill && this.phase !== 'through') {
        this.phase = 'through'
        this.throughBy = 'still'
      }
      return { phase: this.phase, projection: p, band: 'straight', speakDistanceM: null, lostFix, needsFix: true, throughBy: this.throughBy }
    }
    this.wasStale = false
    if (!mapOnly) this.lastDistanceM = p.distanceM

    const band = bandFor(p.relBearingDeg)
    const aimed = Math.abs(p.relBearingDeg) <= AIMED_DEG

    if (this.confirmedThrough) {
      this.phase = 'through'
    } else {
      // Evaluate transitions until the phase settles, so a user who is already aimed
      // AND already at the door lands in `threshold` on the first tick rather than
      // spending one tick in `walking`. Bounded, so a rule that oscillated could not
      // spin here.
      for (let guard = 0; guard < 4; guard++) {
        const before = this.phase
        if (this.phase === 'orienting') {
          if (aimed) this.phase = 'walking'
        } else if (this.phase === 'walking') {
          if (!mapOnly && p.distanceM <= THRESHOLD_M) this.phase = 'threshold'
          // Hysteresis, not AIMED_DEG: a person sways while walking, and bouncing them
          // back to orienting every few steps would make the mode unusable.
          else if (Math.abs(p.relBearingDeg) > LOST_AIM_DEG) this.phase = 'orienting'
        } else if (this.phase === 'threshold') {
          if (!mapOnly && p.distanceM > THRESHOLD_M * 2) this.phase = 'walking'
          // Stood still at the door long enough: propose that they are through.
          else if (stoodStill) {
            this.phase = 'through'
            this.throughBy = 'still'
          }
        }
        if (this.phase === before) break
      }
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
      throughBy: this.throughBy,
    }
  }

  reset(): void {
    this.phase = 'orienting'
    this.anchor = null
    this.lowestSpoken = null
    this.wasStale = false
    this.confirmedThrough = false
    this.lastSteps = -1
    this.stillSinceMs = null
    this.throughBy = null
  }
}
