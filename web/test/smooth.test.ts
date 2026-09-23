import { describe, expect, it } from 'vitest'
import { HeadingSmoother, angularDistance } from '../src/core/smooth'

const feed = (s: HeadingSmoother, vals: number[], hz = 60) =>
  vals.map((v, i) => s.push(v, i * (1000 / hz)))

describe('HeadingSmoother', () => {
  it('does not move for noise below the deadband', () => {
    const s = new HeadingSmoother({ deadbandDeg: 2 })
    s.push(90, 0)
    const out = feed(s, Array.from({ length: 60 }, (_, i) => 90 + Math.sin(i) * 0.8))
    expect(new Set(out.slice(5)).size).toBe(1) // one value: the arrow is still
  })

  it('kills realistic magnetometer noise', () => {
    const s = new HeadingSmoother()
    s.push(90, 0)
    // +/-6 degrees of jitter, the real-world case
    const raw = Array.from({ length: 120 }, (_, i) => 90 + (i % 2 ? 6 : -6))
    const out = feed(s, raw)
    const spread = Math.max(...out.slice(20)) - Math.min(...out.slice(20))
    expect(spread).toBeLessThan(2)
  })

  it('still follows a real turn', () => {
    const s = new HeadingSmoother()
    s.push(0, 0)
    const out = feed(s, Array.from({ length: 90 }, () => 90))
    expect(angularDistance(out.at(-1)!, 90)).toBeLessThan(2)
  })

  it('crosses the 0/360 seam without flipping — the bug angle-averaging has', () => {
    const s = new HeadingSmoother()
    s.push(359, 0)
    const out = feed(s, [359, 0, 1, 0, 359, 1, 0, 1, 2, 1])
    for (const v of out) {
      // must stay near north, never swing to ~180
      expect(angularDistance(v, 0)).toBeLessThan(15)
    }
  })

  it('is frame-rate independent: 15 Hz and 60 Hz converge alike', () => {
    const fast = new HeadingSmoother()
    const slow = new HeadingSmoother()
    fast.push(0, 0)
    slow.push(0, 0)
    let f = 0
    let sl = 0
    for (let i = 1; i <= 60; i++) f = fast.push(90, i * (1000 / 60))
    for (let i = 1; i <= 15; i++) sl = slow.push(90, i * (1000 / 15))
    expect(Math.abs(f - sl)).toBeLessThan(3)
  })

  it('ignores NaN rather than poisoning the filter', () => {
    const s = new HeadingSmoother()
    s.push(45, 0)
    const before = s.value()
    expect(s.push(NaN, 16)).toBe(before)
  })
})
