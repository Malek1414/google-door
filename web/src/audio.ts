// Web Audio beacon: one oscillator -> pulse gain -> one StereoPanner -> output.
// Parameters come from core/beacon.ts; this file only schedules them.

import type { BeaconState } from './core/beacon'

const LOOKAHEAD_S = 0.12
const TICK_MS = 25
const RAMP_S = 0.008

export class BeaconAudio {
  private osc: OscillatorNode | null = null
  private gain: GainNode | null = null
  private pan: StereoPannerNode | null = null
  private timer: number | null = null
  private nextPulse = 0
  private state: BeaconState = { pulseHz: 1, panLR: 0, volume: 0.3, pitchHz: 440 }

  constructor(private ctx: AudioContext) {}

  start(): void {
    if (this.osc) return
    const { ctx } = this
    if (ctx.state === 'suspended') void ctx.resume()
    this.osc = ctx.createOscillator()
    this.osc.type = 'sine'
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.pan = ctx.createStereoPanner()
    this.osc.connect(this.gain).connect(this.pan).connect(ctx.destination)
    this.osc.start()
    this.nextPulse = ctx.currentTime + 0.05
    this.apply()
    this.timer = window.setInterval(() => this.schedule(), TICK_MS)
  }

  update(s: BeaconState): void {
    this.state = s
    this.apply()
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    try {
      this.gain?.gain.cancelScheduledValues(this.ctx.currentTime)
      this.gain?.gain.setValueAtTime(0, this.ctx.currentTime)
      this.osc?.stop(this.ctx.currentTime + 0.02)
    } catch {
      /* already stopped */
    }
    this.osc?.disconnect()
    this.osc = this.gain = this.pan = null
  }

  private apply(): void {
    if (!this.osc || !this.pan) return
    const t = this.ctx.currentTime
    this.osc.frequency.setTargetAtTime(this.state.pitchHz, t, 0.02)
    this.pan.pan.setTargetAtTime(this.state.panLR, t, 0.03)
  }

  private schedule(): void {
    if (!this.gain) return
    const now = this.ctx.currentTime
    if (this.nextPulse < now) this.nextPulse = now + 0.01
    while (this.nextPulse < now + LOOKAHEAD_S) {
      const period = 1 / Math.max(0.1, this.state.pulseHz)
      const beep = Math.min(0.09, period * 0.45)
      const g = this.gain.gain
      const t0 = this.nextPulse
      g.setValueAtTime(0, t0)
      g.linearRampToValueAtTime(this.state.volume, t0 + RAMP_S)
      g.setValueAtTime(this.state.volume, t0 + beep - RAMP_S)
      g.linearRampToValueAtTime(0, t0 + beep)
      this.nextPulse += period
    }
  }
}

/** Play one silent buffer: iOS unlocks the AudioContext only from inside a gesture. */
export function unlockAudio(ctx: AudioContext): void {
  const buf = ctx.createBuffer(1, 1, 22050)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start(0)
  if (ctx.state === 'suspended') void ctx.resume()
}
