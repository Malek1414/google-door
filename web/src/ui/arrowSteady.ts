// The arrow must not shake. A relative bearing (door vs. where the phone points) is fed
// through core/smooth.ts HeadingSmoother (vector low-pass, no 0/360 seam) with a wide
// deadband, so magnetometer and GPS noise produce NO rendered motion at all, and the
// result is unwrapped so a CSS transition always takes the short way round.

import { HeadingSmoother } from '../core/smooth'

/** Seconds to close ~63 % of a real turn. A real magnetometer needs this much. */
export const ARROW_TAU_S = 0.4
/** Degrees the smoothed bearing must move before the arrow moves at all. */
export const ARROW_DEADBAND_DEG = 5

export class SteadyAngle {
  private s = new HeadingSmoother({ tau: ARROW_TAU_S, deadbandDeg: ARROW_DEADBAND_DEG })
  private shown: number | null = null

  /** Feed a relative bearing (-180..180). Returns the angle to render: unwrapped (may
   *  leave -180..180) so consecutive values never differ by more than 180. */
  push(relDeg: number, nowMs: number = Date.now()): number {
    if (!Number.isFinite(relDeg)) return this.shown ?? 0
    const out = this.s.push(relDeg, nowMs) // 0..360
    const rel = out > 180 ? out - 360 : out
    if (this.shown === null) this.shown = rel
    else this.shown += ((((rel - this.shown) % 360) + 540) % 360) - 180
    return this.shown
  }

  /** Relative bearing (-180..180) of what is shown, for words and sounds. */
  get rel(): number {
    const v = this.shown ?? 0
    return ((((v + 180) % 360) + 360) % 360) - 180
  }

  /** Input gone (no door, stale anchor): next value snaps instead of gliding from the past. */
  reset(): void {
    this.s.reset()
    this.shown = null
  }
}
