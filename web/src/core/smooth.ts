// Heading smoothing. Pure, no I/O, frame-rate independent.
//
// A phone magnetometer jitters several degrees even lying still, and
// deviceorientation fires ~60 Hz, so an arrow driven from raw samples vibrates.
//
// Two things fix it, and both are needed:
//
// 1. Smooth the unit VECTOR, never the angle. Averaging degrees breaks across the
//    0/360 seam — 359 and 1 average to 180, and the arrow flips to face backwards
//    once per revolution. Smoothing (cos, sin) and taking atan2 has no seam.
//
// 2. A deadband on the output. Below it the rendered value does not change at all,
//    so micro-noise produces no motion rather than small motion. Small constant
//    motion is what reads as "vibrating".
//
// The time constant is in seconds and converted per-sample, so behaviour is the same
// at 60 Hz and at 15 Hz.

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export interface SmootherOpts {
  /** Seconds to close ~63% of a step. Lower = snappier and jitterier. */
  tau?: number
  /** Degrees the smoothed heading must move before the output changes at all. */
  deadbandDeg?: number
}

export class HeadingSmoother {
  private x = 0
  private y = 0
  private primed = false
  private out = 0
  private lastT = 0
  private readonly tau: number
  private readonly deadband: number

  constructor(opts: SmootherOpts = {}) {
    this.tau = opts.tau ?? 0.18
    this.deadband = opts.deadbandDeg ?? 1.5
  }

  /** Feed a raw heading in degrees. `nowMs` lets tests drive time explicitly. */
  push(deg: number, nowMs: number = Date.now()): number {
    if (!Number.isFinite(deg)) return this.out
    const r = deg * RAD
    const cx = Math.cos(r)
    const cy = Math.sin(r)

    if (!this.primed) {
      this.x = cx
      this.y = cy
      this.primed = true
      this.lastT = nowMs
      this.out = norm(Math.atan2(cy, cx) * DEG)
      return this.out
    }

    const dt = Math.min(0.5, Math.max(0, (nowMs - this.lastT) / 1000))
    this.lastT = nowMs
    const a = this.tau > 0 ? 1 - Math.exp(-dt / this.tau) : 1
    this.x += a * (cx - this.x)
    this.y += a * (cy - this.y)

    const candidate = norm(Math.atan2(this.y, this.x) * DEG)
    if (angularDistance(candidate, this.out) >= this.deadband) this.out = candidate
    return this.out
  }

  /** Current smoothed heading without feeding a sample. */
  value(): number {
    return this.out
  }

  reset(): void {
    this.primed = false
    this.x = this.y = this.out = 0
  }
}

export function norm(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Shortest angle between two bearings, 0..180. */
export function angularDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}
