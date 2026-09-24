import { describe, expect, it } from 'vitest'
import { progressAlong, cumulative, currentStep, stepAhead, LOOKAHEAD_M, OFF_ROUTE_M, type Route } from '../src/core/route'

// ~1 m per step due north, 60 points
const path: [number, number][] = Array.from({ length: 60 }, (_, i) => [52.5250 + i * 0.000009, 13.3694])

describe('route following', () => {
  it('measures the path, not the straight line', () => {
    const cum = cumulative(path)
    expect(Math.round(cum.at(-1)!)).toBeGreaterThan(55)
  })

  it('aims ahead of the user, not at their feet', () => {
    const p = progressAlong({ lat: path[10][0], lon: path[10][1] }, path)!
    const aheadM = (p.aim.lat - path[10][0]) * 111320
    expect(aheadM).toBeGreaterThan(LOOKAHEAD_M * 0.7)
    // due north is 0 degrees, not 359 — compare on the circle, not on the number line
    const offNorth = Math.abs(((p.bearing + 180) % 360) - 180)
    expect(offNorth).toBeLessThan(2)
  })

  it('a sideways GPS jump does not swing the arrow', () => {
    // same place, jittered 8 m east and west
    const a = progressAlong({ lat: path[20][0], lon: path[20][1] + 0.00012 }, path)!
    const b = progressAlong({ lat: path[20][0], lon: path[20][1] - 0.00012 }, path)!
    const swing = Math.abs(((a.bearing - b.bearing + 540) % 360) - 180)
    expect(swing).toBeLessThan(60)  // straight-line aiming would swing ~180
  })

  it('counts down remaining distance along the path', () => {
    const near = progressAlong({ lat: path[5][0], lon: path[5][1] }, path)!
    const far = progressAlong({ lat: path[50][0], lon: path[50][1] }, path)!
    expect(near.remainingM).toBeGreaterThan(far.remainingM)
    expect(far.remainingM).toBeLessThan(12)
  })

  it('flags off-route past the threshold', () => {
    const on = progressAlong({ lat: path[10][0], lon: path[10][1] }, path)!
    const off = progressAlong({ lat: path[10][0], lon: path[10][1] + 0.0009 }, path)! // ~60 m east
    expect(on.offRoute).toBe(false)
    expect(off.offPathM).toBeGreaterThan(OFF_ROUTE_M)
    expect(off.offRoute).toBe(true)
  })

  it('returns null for an empty path so the caller can fall back', () => {
    expect(progressAlong({ lat: 52.5, lon: 13.3 }, [])).toBeNull()
  })

  it('handles a single-point path without dividing by zero', () => {
    const p = progressAlong({ lat: 52.5, lon: 13.3 }, [[52.5251, 13.3694]])!
    expect(Number.isFinite(p.bearing)).toBe(true)
    expect(p.remainingM).toBe(0)
  })

  it('picks the step the user is actually walking', () => {
    const route: Route = { found: true, distanceM: 88, path: [], steps: [
      { distanceM: 53, maneuver: 'DEPART', text: 'Auf Heidestraße', endLat: null, endLon: null },
      { distanceM: 36, maneuver: 'TURN_LEFT', text: 'Links abbiegen', endLat: null, endLon: null },
    ] }
    expect(currentStep(80, route)?.maneuver).toBe('DEPART')
    expect(currentStep(20, route)?.maneuver).toBe('TURN_LEFT')
  })

  it('counts down the metres left of the step being walked, not of the whole route', () => {
    const route: Route = { found: true, distanceM: 88, path: [], steps: [
      { distanceM: 53, maneuver: 'DEPART', text: 'Auf Heidestraße', endLat: null, endLon: null },
      { distanceM: 36, maneuver: 'TURN_LEFT', text: 'Links abbiegen', endLat: null, endLon: null },
    ] }
    // 80 m left overall: 36 of those belong to the final step, so the left turn is 44 m off.
    const far = stepAhead(80, route)!
    expect(far.step.maneuver).toBe('DEPART')
    expect(far.toManeuverM).toBe(44)

    // Inside the last step the countdown is simply what is left of the walk.
    expect(stepAhead(20, route)!.toManeuverM).toBe(20)
    expect(stepAhead(0, route)!.toManeuverM).toBe(0)
  })

  it('has no step to show for a route without steps', () => {
    expect(stepAhead(40, { found: true, distanceM: 40, path: [], steps: [] })).toBeNull()
  })
})
