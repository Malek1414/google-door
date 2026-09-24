import { describe, expect, it } from 'vitest'
import { StabilityGuard, angleDelta, TOLERANCE_DEG } from '../src/core/stability'

const fix = (bearingDeg: number, headingDeg: number, confidence = 0.9) => ({ bearingDeg, headingDeg, confidence })

describe('angleDelta', () => {
  it('takes the short way round the circle', () => {
    expect(angleDelta(350, 10)).toBe(20)
    expect(angleDelta(10, 350)).toBe(-20)
    expect(angleDelta(0, 180)).toBe(180)
  })
})

describe('StabilityGuard', () => {
  it('trusts a first fix — there is nothing to compare it against', () => {
    expect(new StabilityGuard().push(fix(-20, 100)).trusted).toBe(true)
  })

  it('trusts a fix that moves consistently with the phone', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100))
    // phone turns 15 deg right, so a fixed door moves 15 deg further left
    const r = g.push(fix(-35, 115))
    expect(r.unstable).toBe(false)
    expect(r.trusted).toBe(true)
  })

  it('flags a door that moves while the phone does not', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100))
    const r = g.push(fix(25, 102)) // 45 deg of door movement, 2 deg of phone
    expect(r.unstable).toBe(true)
    expect(r.trusted).toBe(false)
  })

  it('falls back to on-demand after two strikes in a row', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100))
    expect(g.push(fix(30, 100)).mode).toBe('live')     // strike 1
    expect(g.push(fix(-30, 100)).mode).toBe('ondemand') // strike 2
    expect(g.hasFallenBack).toBe(true)
  })

  it('a single wobble between good fixes does not fall back', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100))
    g.push(fix(40, 100))        // strike
    g.push(fix(40, 100))        // consistent again: strikes reset
    g.push(fix(30, 110))
    expect(g.hasFallenBack).toBe(false)
  })

  it('never returns to live once it has fallen back', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100)); g.push(fix(40, 100)); g.push(fix(-40, 100))
    expect(g.mode).toBe('ondemand')
    for (let i = 0; i < 10; i++) g.push(fix(-20 - i, 100 + i))
    expect(g.mode).toBe('ondemand')
  })

  it('low confidence is rejected but is not instability', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100))
    const r = g.push(fix(90, 100, 0.2))
    expect(r.trusted).toBe(false)
    expect(r.unstable).toBe(false)
    expect(g.hasFallenBack).toBe(false)
  })

  it('survives NaN without poisoning the guard', () => {
    const g = new StabilityGuard()
    g.push(fix(-20, 100))
    expect(g.push(fix(NaN, 100)).trusted).toBe(false)
    expect(g.push(fix(-35, 115)).trusted).toBe(true)
  })

  it('tolerates disagreement right up to the threshold', () => {
    const g = new StabilityGuard()
    g.push(fix(0, 0))
    expect(g.push(fix(-(TOLERANCE_DEG - 1), 0)).unstable).toBe(false)
    const g2 = new StabilityGuard()
    g2.push(fix(0, 0))
    expect(g2.push(fix(-(TOLERANCE_DEG + 5), 0)).unstable).toBe(true)
  })
})

describe('near the door (parallax)', () => {
  it('within 4 m a bearing swing the compass does not explain is tolerated more widely', () => {
    const g = new StabilityGuard()
    g.push({ ...fix(0, 0), distanceM: 2 })
    // A side-step at 2 m swings the door 35° with no compass turn: a real door, not a hallucination.
    expect(g.push({ ...fix(35, 0), distanceM: 2 }).trusted).toBe(true)
    expect(g.push({ ...fix(0, 0), distanceM: 2 }).trusted).toBe(true)
    expect(g.hasFallenBack).toBe(false)
  })

  it('far away the same swing is still struck, and a wild jump near the door still is too', () => {
    const far = new StabilityGuard()
    far.push({ ...fix(0, 0), distanceM: 8 })
    expect(far.push({ ...fix(35, 0), distanceM: 8 }).unstable).toBe(true)
    const near = new StabilityGuard()
    near.push({ ...fix(0, 0), distanceM: 2 })
    expect(near.push({ ...fix(-(2 * TOLERANCE_DEG + 5), 0), distanceM: 2 }).unstable).toBe(true)
  })
})
