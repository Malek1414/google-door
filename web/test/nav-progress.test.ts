import { describe, expect, it } from 'vitest'
import { destination } from '../src/core/geo'
import { progress, splitPath, type NavFix, type NavState } from '../src/core/navProgress'
import type { Route } from '../src/core/route'

const A = { lat: 52.5292, lon: 13.4015 }
const B = destination(A, 90, 100) // 100 m east
const C = destination(B, 0, 60) // then 60 m north

function route(): Route {
  return {
    found: true,
    distanceM: 160,
    path: [
      [A.lat, A.lon],
      [B.lat, B.lon],
      [C.lat, C.lon],
    ],
    steps: [
      { distanceM: 100, maneuver: 'DEPART', text: 'Nach Osten', endLat: B.lat, endLon: B.lon },
      { distanceM: 60, maneuver: 'TURN_LEFT', text: 'Links in die Torstraße', endLat: C.lat, endLon: C.lon },
    ],
  }
}

function fixAt(p: { lat: number; lon: number }, accuracy = 5): NavFix {
  return { lat: p.lat, lng: p.lon, accuracy, headingDeg: null, speed: null, t: 0 }
}

describe('navProgress', () => {
  it('straight: tracks distance to the turn and remaining', () => {
    const r = route()
    const s = progress(r, fixAt(destination(A, 90, 40)))
    expect(s.stepIndex).toBe(0)
    expect(s.distToManeuverM).toBeCloseTo(60, 0)
    expect(s.remainingM).toBeCloseTo(120, 0)
    expect(s.etaS).toBeCloseTo(120 / 1.3, 0)
    expect(s.offRoute).toBe(false)
    expect(s.arrived).toBe(false)
    expect(s.bearingDeg).toBeCloseTo(90, 0)
  })

  it('snaps a point beside the line onto it', () => {
    const r = route()
    const beside = destination(destination(A, 90, 50), 180, 8)
    const s = progress(r, fixAt(beside))
    const onLine = destination(A, 90, 50)
    expect(s.snapped.lat).toBeCloseTo(onLine.lat, 5)
    expect(s.snapped.lng).toBeCloseTo(onLine.lon, 5)
    expect(s.offRoute).toBe(false)
  })

  it('turn: step advances once the corner is passed', () => {
    const r = route()
    let s = progress(r, fixAt(destination(A, 90, 95)))
    expect(s.stepIndex).toBe(0)
    s = progress(r, fixAt(destination(B, 0, 10)), s)
    expect(s.stepIndex).toBe(1)
    expect(s.distToManeuverM).toBeCloseTo(50, 0)
    expect(s.bearingDeg).toBeCloseTo(0, 0)
  })

  it('backwards jitter never jumps back more than 15 m', () => {
    const r = route()
    const s1 = progress(r, fixAt(destination(A, 90, 80)))
    const s2 = progress(r, fixAt(destination(A, 90, 20)), s1)
    expect(s2.alongM).toBeGreaterThanOrEqual(s1.alongM - 15 - 0.01)
    expect(s2.stepIndex).toBe(0)
    const s3 = progress(r, fixAt(destination(A, 90, 78)), s2)
    expect(s3.alongM).toBeCloseTo(78, 0)
  })

  it('step index does not fall back after the turn', () => {
    const r = route()
    const s1 = progress(r, fixAt(destination(B, 0, 5)))
    expect(s1.stepIndex).toBe(1)
    const s2 = progress(r, fixAt(destination(A, 90, 97)), s1)
    expect(s2.stepIndex).toBe(1)
  })

  it('off-route beyond 25 m, tolerance grows with poor accuracy', () => {
    const r = route()
    const far = destination(destination(A, 90, 50), 180, 35)
    expect(progress(r, fixAt(far, 5)).offRoute).toBe(true)
    expect(progress(r, fixAt(far, 30)).offRoute).toBe(false) // 1.5 x 30 = 45 m
    expect(progress(r, fixAt(destination(destination(A, 90, 50), 180, 20), 5)).offRoute).toBe(false)
  })

  it('arrival within 15 m of the destination with good accuracy, sticky', () => {
    const r = route()
    const near = destination(C, 180, 10)
    const s = progress(r, fixAt(near, 8))
    expect(s.arrived).toBe(true)
    expect(s.remainingM).toBeLessThan(15)
    const s2 = progress(r, fixAt(destination(C, 180, 25), 8), s)
    expect(s2.arrived).toBe(true)
  })

  it('poor accuracy does not count as arrival', () => {
    const r = route()
    const s = progress(r, fixAt(destination(C, 180, 5), 40))
    expect(s.arrived).toBe(false)
    expect(s.offRoute).toBe(false)
  })

  it('steps without end coordinates fall back to their distances', () => {
    const r = route()
    r.steps = r.steps.map((st) => ({ ...st, endLat: null, endLon: null }))
    const s = progress(r, fixAt(destination(A, 90, 40)))
    expect(s.stepIndex).toBe(0)
    expect(s.distToManeuverM).toBeCloseTo(60, 0)
  })

  it('splitPath cuts at the snapped point', () => {
    const r = route()
    const { walked, ahead } = splitPath(r, 50)
    expect(walked.length).toBe(2)
    expect(ahead.length).toBe(3)
    expect(walked.at(-1)).toEqual(ahead[0])
  })

  it('handles a degenerate one-point path without throwing', () => {
    const r: Route = { found: true, distanceM: 0, path: [[A.lat, A.lon]], steps: [] }
    const s: NavState = progress(r, fixAt(A))
    expect(s.remainingM).toBe(0)
    expect(s.arrived).toBe(true)
  })
})
