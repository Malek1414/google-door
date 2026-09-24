// The guidance arrow must not shake (Sami: "it shakes all the time").
import { describe, expect, it } from 'vitest'
import { ARROW_DEADBAND_DEG, SteadyAngle } from '../src/ui/arrowSteady'

/** Deterministic ±3° noise. */
const noise = (i: number) => 3 * Math.sin(i * 1.7) * Math.cos(i * 0.31)

describe('SteadyAngle: the rendered arrow', () => {
  for (const base of [20, 0, 179, -179]) {
    it(`±3° noise at 60 Hz around ${base}° for 5 s: zero changes after settling`, () => {
      const s = new SteadyAngle()
      let t = 0
      const out: number[] = []
      for (let i = 0; i < 300; i++) {
        t += 1000 / 60
        out.push(s.push(base + noise(i), t))
      }
      const settled = out.slice(60) // after 1 s
      const changes = settled.filter((v, i) => i > 0 && v !== settled[i - 1]).length
      expect(changes).toBe(0)
      // And the arrow is where the door is, within the deadband.
      expect(Math.abs(((((s.rel - base) % 360) + 540) % 360) - 180)).toBeLessThanOrEqual(ARROW_DEADBAND_DEG)
    })
  }

  it('a real 30° turn reaches the arrow within about 1 s', () => {
    const s = new SteadyAngle()
    let t = 0
    for (let i = 0; i < 60; i++) s.push(0 + noise(i), (t += 1000 / 60))
    let reachedAt = -1
    for (let i = 0; i < 120; i++) {
      s.push(30 + noise(i), (t += 1000 / 60))
      if (reachedAt < 0 && Math.abs(s.rel - 30) <= ARROW_DEADBAND_DEG) reachedAt = i / 60
    }
    expect(reachedAt).toBeGreaterThanOrEqual(0)
    expect(reachedAt).toBeLessThanOrEqual(1.1)
  })

  it('crossing ±180 takes the short way: consecutive rendered angles never jump by more than 180', () => {
    const s = new SteadyAngle()
    let t = 0
    let prev = s.push(170, t)
    for (let d = 170; d <= 190; d += 1) {
      const rel = d > 180 ? d - 360 : d
      for (let k = 0; k < 10; k++) {
        const v = s.push(rel, (t += 1000 / 60))
        expect(Math.abs(v - prev)).toBeLessThan(180)
        prev = v
      }
    }
  })
})
