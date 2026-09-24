// Step counting for the last 10 metres. GPS does not participate, so distance walked
// comes from here: a peak detector on the magnitude of the acceleration vector.
//
// Magnitude, not one axis, because the phone is held at any angle. Gravity is removed
// with a slow running mean rather than assumed to be 9.81, because the sensor's own
// offset differs per device. A step is a rise of the smoothed signal above that mean,
// counted once, re-armed only after the signal falls back below it, and never twice
// inside MIN_STEP_MS (nobody walks faster than ~3 steps a second).

/** Rise above the running mean, in m/s², that counts as a step. */
export const STEP_RISE = 1.0
/** Minimum time between two steps. */
export const MIN_STEP_MS = 300
/** Running mean (gravity + sensor offset). Slow: about a second at 50–60 Hz. */
const BASELINE_ALPHA = 0.02
/** Smoothing of the signal itself, to drop hand tremor. */
const SMOOTH_ALPHA = 0.3

export class StepDetector {
  private baseline: number | null = null
  private smooth = 0
  private armed = true
  private lastStepMs = -Infinity
  private n = 0

  get steps(): number {
    return this.n
  }

  /** Feed one acceleration sample. Returns true when this sample completes a step. */
  push(x: number, y: number, z: number, tMs: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(tMs)) return false
    const mag = Math.hypot(x, y, z)
    if (this.baseline === null) {
      this.baseline = mag
      this.smooth = mag
      return false
    }
    this.smooth += SMOOTH_ALPHA * (mag - this.smooth)
    this.baseline += BASELINE_ALPHA * (mag - this.baseline)
    const rise = this.smooth - this.baseline

    if (!this.armed) {
      if (rise < 0) this.armed = true
      return false
    }
    if (rise > STEP_RISE && tMs - this.lastStepMs >= MIN_STEP_MS) {
      this.armed = false
      this.lastStepMs = tMs
      this.n += 1
      return true
    }
    return false
  }

  reset(): void {
    this.baseline = null
    this.smooth = 0
    this.armed = true
    this.lastStepMs = -Infinity
    this.n = 0
  }
}

/**
 * The DOM wiring: DeviceMotion events in, step count out. `subscribe` is the
 * ApproachIO.onMotion shape. Prefers accelerationIncludingGravity (always present on
 * iOS/Android), falls back to acceleration. Returns unsubscribe.
 */
export function countSteps(
  subscribe: (cb: (e: DeviceMotionEvent) => void) => () => void,
  onSteps: (steps: number) => void,
  now: () => number = () => Date.now(),
): () => void {
  const det = new StepDetector()
  return subscribe((e) => {
    const a = e.accelerationIncludingGravity ?? e.acceleration
    if (!a || a.x === null || a.y === null || a.z === null) return
    if (det.push(a.x, a.y, a.z, now())) onSteps(det.steps)
  })
}
