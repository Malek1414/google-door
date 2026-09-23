// The hallucination guard. Pure, no I/O.
//
// Gemini Live streams door fixes; at ten metres a hallucinated door is someone walking
// into a wall, so the model's output needs a check the code can actually make.
//
// The check: between two fixes the compass knows how far the PHONE turned. A real door
// does not move. So if the door's reported bearing swings far more than the phone did,
// the extra movement came from the model, not the world.
//
//     unstable  ⇔  |Δ bearing − Δ heading| > TOLERANCE_DEG
//
// Two unstable fixes in a row drop Live streaming to on-demand, and that drop is
// STICKY for the rest of the approach. Flapping between modes mid-walk is worse than
// either mode: the user would hear confidence come and go every few seconds.

/** How much disagreement between vision and the compass is tolerated, in degrees. */
export const TOLERANCE_DEG = 25
/** Consecutive unstable fixes before Live is abandoned. */
export const STRIKES = 2
/** Below this the fix is treated as no door at all. */
export const MIN_CONFIDENCE = 0.5

export interface Fix {
  /** Degrees relative to the camera centre, negative left. */
  bearingDeg: number
  /** Compass heading when the frame was taken. */
  headingDeg: number
  confidence: number
}

export type Mode = 'live' | 'ondemand'

/** Shortest signed difference a → b, in (-180, 180].
 *  The exact antipode is genuinely ambiguous — both ways round are equally short —
 *  so it resolves to +180 to stay inside the documented range. */
export function angleDelta(a: number, b: number): number {
  const d = ((b - a + 540) % 360) - 180
  return d === -180 ? 180 : d
}

export class StabilityGuard {
  private prev: Fix | null = null
  private strikes = 0
  private fellBack = false

  constructor(
    private readonly tolerance = TOLERANCE_DEG,
    private readonly maxStrikes = STRIKES,
  ) {}

  /** Once Live has been abandoned it is never resumed for this approach. */
  get mode(): Mode {
    return this.fellBack ? 'ondemand' : 'live'
  }

  get hasFallenBack(): boolean {
    return this.fellBack
  }

  /**
   * Feed a fix. Returns whether it should be trusted.
   * A low-confidence fix is rejected without counting as instability — the model
   * saying "I am not sure" is honest, not a hallucination.
   */
  push(fix: Fix): { trusted: boolean; unstable: boolean; mode: Mode } {
    if (!Number.isFinite(fix.bearingDeg) || !Number.isFinite(fix.headingDeg)) {
      return { trusted: false, unstable: false, mode: this.mode }
    }
    if (fix.confidence < MIN_CONFIDENCE) {
      this.prev = fix
      return { trusted: false, unstable: false, mode: this.mode }
    }

    const prev = this.prev
    this.prev = fix
    if (!prev || prev.confidence < MIN_CONFIDENCE) {
      // Nothing to compare against yet; a first fix cannot be unstable.
      return { trusted: true, unstable: false, mode: this.mode }
    }

    const dBearing = angleDelta(prev.bearingDeg, fix.bearingDeg)
    const dHeading = angleDelta(prev.headingDeg, fix.headingDeg)
    // The phone turning right moves a fixed door's relative bearing left, so a
    // consistent pair has dBearing ≈ -dHeading.
    const disagreement = Math.abs(dBearing + dHeading)
    const unstable = disagreement > this.tolerance

    if (unstable) {
      this.strikes += 1
      if (this.strikes >= this.maxStrikes) this.fellBack = true
    } else {
      this.strikes = 0
    }
    return { trusted: !unstable, unstable, mode: this.mode }
  }

  reset(): void {
    this.prev = null
    this.strikes = 0
    this.fellBack = false
  }
}
