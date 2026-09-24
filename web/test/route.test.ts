import { describe, expect, it } from 'vitest'
import { progressAlong, cumulative, currentStep, stepAhead, nextManeuver, connected, durationSeconds, walkMinutes, instructionLine, maneuverGlyph, LOOKAHEAD_M, OFF_ROUTE_M, type Route } from '../src/core/route'

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

describe('next manoeuvre (what the banner shows)', () => {
  const route: Route = { found: true, distanceM: 250, duration: '206s', path: [], steps: [
    { distanceM: 99, maneuver: 'DEPART', text: 'Auf Ella-Trebe-Straße nach Norden', endLat: null, endLon: null },
    { distanceM: 19, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf Europaplatz', endLat: null, endLon: null },
    { distanceM: 23, maneuver: 'TURN_LEFT', text: 'Links Richtung Invalidenstraße abbiegen', endLat: null, endLon: null },
    { distanceM: 109, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf Invalidenstraße\nDas Ziel befindet sich rechts', endLat: null, endLon: null },
  ] }

  it('at the start, the next thing to do is the first turn, not "depart"', () => {
    const n = nextManeuver(250, route)!
    expect(n.walking).toBe(0)
    expect(n.step?.maneuver).toBe('TURN_RIGHT')
    expect(n.toManeuverM).toBe(250 - 109 - 23 - 19)
  })

  it('counts down to the manoeuvre, then moves on to the next one', () => {
    expect(nextManeuver(135, route)!.step?.maneuver).toBe('TURN_LEFT')
    expect(nextManeuver(135, route)!.toManeuverM).toBe(3)
  })

  it('on the last step the next thing is arriving', () => {
    const n = nextManeuver(40, route)!
    expect(n.step).toBeNull()
    expect(n.toManeuverM).toBe(40)
  })

  it('a trailing step with no text and no manoeuvre is arriving, not "In 50 m Ziel erreichen"', () => {
    const tail: Route = { ...route, distanceM: 300, steps: [...route.steps, { distanceM: 50, maneuver: null, text: null, endLat: null, endLon: null }] }
    // 240 m left: we are before the right turn onto Invalidenstraße, which is next.
    expect(nextManeuver(240, tail)!.step?.maneuver).toBe('TURN_RIGHT')
    // On the Invalidenstraße leg the empty step ahead means: arriving, the whole rest counts.
    const n = nextManeuver(120, tail)!
    expect(n.step).toBeNull()
    expect(n.toManeuverM).toBe(120)
  })

  it('reads the duration and the first instruction line', () => {
    expect(durationSeconds(route)).toBe(206)
    expect(walkMinutes(route)).toBe(3)
    expect(instructionLine(route.steps[3])).toBe('Rechts abbiegen auf Invalidenstraße')
    expect(maneuverGlyph('TURN_LEFT')).toBe('turn_left')
  })
})

describe('sparse paths and the connector', () => {
  // Three points for 130 m, as the Routes API returns them: 80 m north, then 50 m east.
  const sparse: [number, number][] = [[52.5240, 13.3680], [52.52472, 13.3680], [52.52472, 13.36874]]

  it('walking the middle of a long straight segment is on route', () => {
    const p = progressAlong({ lat: 52.5244, lon: 13.36803 }, sparse)!
    expect(p.offPathM).toBeLessThan(5)
    expect(p.offRoute).toBe(false)
    expect(p.remainingM).toBeGreaterThan(80)
    expect(p.remainingM).toBeLessThan(90)
  })

  it('aims ahead along the path, round the corner when it is close', () => {
    const p = progressAlong({ lat: 52.52465, lon: 13.3680 }, sparse)!
    // 8 m before the corner, 18 m lookahead: aim is past the corner, so east of north
    expect(p.bearing).toBeGreaterThan(20)
    expect(p.bearing).toBeLessThan(90)
  })

  it('joins a user standing away from the snapped start to the route', () => {
    const from = { lat: 52.5240, lon: 13.3685 } // ~34 m east of the route start
    const path = connected(from, sparse)
    expect(path.length).toBe(4)
    expect(progressAlong(from, path)!.offRoute).toBe(false)
    expect(connected({ lat: 52.5240, lon: 13.36801 }, sparse).length).toBe(3)
  })
})

describe('connector to a door off the street', () => {
  it('appends the door when the route ends on the street away from it', () => {
    const path: [number, number][] = [[52.5240, 13.3680], [52.5245, 13.3680]]
    expect(connected({ lat: 52.5240, lon: 13.3680 }, path, { lat: 52.5245, lon: 13.3686 }).length).toBe(3)
    expect(connected({ lat: 52.5240, lon: 13.3680 }, path, { lat: 52.5245, lon: 13.36801 }).length).toBe(2)
  })
})

describe('next manoeuvre with a tail connector', () => {
  it('does not shift the turn by the length of the walk from street to door', () => {
    const route: Route = { found: true, distanceM: 130, path: [], steps: [
      { distanceM: 78, maneuver: 'DEPART', text: 'Auf Ella-Trebe-Straße', endLat: null, endLon: null },
      { distanceM: 53, maneuver: 'TURN_LEFT', text: 'Links abbiegen', endLat: null, endLon: null },
    ] }
    // 20 m tail: 100 m remaining = 80 of route = 27 before the turn
    expect(nextManeuver(100, route, 20)!.toManeuverM).toBe(27)
    // in the last step, arriving is next, and the countdown is to the door
    const n = nextManeuver(40, route, 20)!
    expect(n.step).toBeNull()
    expect(n.toManeuverM).toBe(40)
  })
})
