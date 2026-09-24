import { describe, expect, it } from 'vitest'
import { arrivalClock, navState, roundNavM, secondsLeft } from '../src/core/nav'
import type { Route } from '../src/core/route'

// A straight 100 m north, then 50 m east. One-degree latitude ~ 111_195 m.
const dLat = 100 / 111_195
const dLon = 50 / (111_195 * Math.cos((52.5 * Math.PI) / 180))
const path: [number, number][] = [
  [52.5, 13.4],
  [52.5 + dLat, 13.4],
  [52.5 + dLat, 13.4 + dLon],
]
const route: Route = {
  found: true,
  distanceM: 150,
  duration: '120s',
  path,
  steps: [
    { distanceM: 100, maneuver: 'DEPART', text: 'Nach Norden', endLat: null, endLon: null },
    { distanceM: 50, maneuver: 'TURN_RIGHT', text: 'Rechts abbiegen auf X-Straße\nZiel rechts', endLat: null, endLon: null },
  ],
}

describe('navState', () => {
  it('shows the coming right turn and the metres to it at the start', () => {
    const s = navState({ lat: 52.5, lon: 13.4 }, route, path)
    expect(s.glyph).toBe('turn_right')
    expect(s.text).toBe('Rechts abbiegen auf X-Straße')
    expect(s.toManeuverM).toBeGreaterThan(95)
    expect(s.toManeuverM).toBeLessThan(105)
    expect(s.walking).toBe(0)
  })
  it('counts down as the user walks', () => {
    const s = navState({ lat: 52.5 + dLat * 0.6, lon: 13.4 }, route, path)
    expect(s.toManeuverM).toBeGreaterThan(35)
    expect(s.toManeuverM).toBeLessThan(45)
    expect(s.remainingM).toBeGreaterThan(85)
  })
  it('after the turn the next thing is arriving', () => {
    const s = navState({ lat: 52.5 + dLat, lon: 13.4 + dLon * 0.5 }, route, path)
    expect(s.glyph).toBe('flag')
    expect(s.text).toBeNull()
    expect(s.walking).toBe(1)
    expect(s.toManeuverM).toBeLessThan(30)
  })
})

describe('arrival helpers', () => {
  it('scales the route duration by what is left', () => {
    expect(secondsLeft(route, 75)).toBeCloseTo(60)
    expect(secondsLeft({ ...route, duration: null }, 12)).toBeCloseTo(10)
  })
  it('formats a 24 h clock', () => {
    expect(arrivalClock(new Date(2026, 8, 24, 9, 20, 0), 240)).toBe('09:24')
  })
  it('rounds banner metres like Maps', () => {
    expect(roundNavM(4.4)).toBe(4)
    expect(roundNavM(123)).toBe(120)
    expect(roundNavM(412)).toBe(400)
  })
})

import { navSheetLines, thenGlyph } from '../src/core/nav'
describe('Dann chip and sheet lines', () => {
  const three: Route = { ...route, steps: [...route.steps, { distanceM: 20, maneuver: 'TURN_LEFT', text: 'Links', endLat: null, endLon: null }] }
  it('shows the manoeuvre after the next one', () => {
    expect(thenGlyph(three, 0)).toBe('turn_left')
    expect(thenGlyph(three, 1)).toBeNull()
    expect(thenGlyph(route, 0)).toBeNull()
  })
  it('formats the Maps nav sheet', () => {
    expect(navSheetLines(180, 213, new Date(2026, 8, 24, 9, 22, 0))).toEqual({ big: '3 Min.', small: '210 m · 09:25' })
    expect(navSheetLines(20, 1234, new Date(2026, 8, 24, 9, 22, 0)).small).toBe('1,2 km · 09:22')
  })
})

import { startEnabled } from '../src/core/nav'
describe('startEnabled', () => {
  it('any route can start, place or non-guidable door included', () => {
    expect(startEnabled(true, false)).toBe(true)
    expect(startEnabled(true, true)).toBe(true)
  })
  it('without a route only a guidable door starts', () => {
    expect(startEnabled(false, true)).toBe(true)
    expect(startEnabled(false, false)).toBe(false)
  })
})
