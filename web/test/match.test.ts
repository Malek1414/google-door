import { describe, expect, it } from 'vitest'
import { destination, haversineM } from '../src/core/geo'
import { snapToGraph } from '../src/core/match'

const A = { lat: 52.5272, lon: 13.37 }
const B = destination(A, 90, 100) // 100 m east-west footway

describe('snapToGraph', () => {
  it('empty graph (contract v1 has none) passes the fix through unchanged', () => {
    const r = snapToGraph(A, [])
    expect(r).toEqual({ pos: A, snapped: false, offsetM: 0 })
  })
  it('snaps a fix 5 m off the footway onto it', () => {
    const mid = destination(A, 90, 40)
    const off = destination(mid, 0, 5)
    const r = snapToGraph(off, [{ a: A, b: B }])
    expect(r.snapped).toBe(true)
    expect(r.offsetM).toBeCloseTo(5, 1)
    expect(haversineM(r.pos, mid)).toBeLessThan(0.2)
  })
  it('clamps to the segment end', () => {
    const beyond = destination(B, 90, 3)
    const r = snapToGraph(beyond, [{ a: A, b: B }])
    expect(haversineM(r.pos, B)).toBeLessThan(0.2)
  })
  it('does not snap beyond the max distance', () => {
    const far = destination(destination(A, 90, 50), 0, 30)
    expect(snapToGraph(far, [{ a: A, b: B }]).snapped).toBe(false)
  })
  it('picks the nearer of two segments', () => {
    const C = destination(A, 0, 20)
    const D = destination(C, 90, 100)
    const p = destination(destination(A, 90, 50), 0, 14) // 14 m from AB, 6 m from CD
    const r = snapToGraph(p, [{ a: A, b: B }, { a: C, b: D }])
    expect(r.offsetM).toBeCloseTo(6, 0)
  })
  it('handles a degenerate zero-length segment', () => {
    const r = snapToGraph(destination(A, 0, 3), [{ a: A, b: A }])
    expect(r.snapped).toBe(true)
    expect(haversineM(r.pos, A)).toBeLessThan(0.1)
  })
})
