import { describe, expect, it } from 'vitest'
import { bearingDeg, destination, haversineM, normalize360, relativeBearing } from '../src/core/geo'

// Fixture facts from pipeline/fixtures/hbf_groundtruth.json
const STEP_FREE = { lat: 52.5272097, lon: 13.3711667 } // node/10795939972
const NOT_STEP_FREE = { lat: 52.5272338, lon: 13.371295 } // node/1250148681

describe('haversineM', () => {
  it('reproduces the 9.1 m Hauptbahnhof contradiction pair within 1 m tolerance', () => {
    expect(Math.abs(haversineM(STEP_FREE, NOT_STEP_FREE) - 9.1)).toBeLessThan(1)
  })
  it('is zero for identical points and symmetric', () => {
    expect(haversineM(STEP_FREE, STEP_FREE)).toBe(0)
    expect(haversineM(STEP_FREE, NOT_STEP_FREE)).toBeCloseTo(haversineM(NOT_STEP_FREE, STEP_FREE), 9)
  })
  it('one degree of latitude is about 111.2 km', () => {
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111195, -2)
  })
})

describe('bearingDeg', () => {
  const o = { lat: 52.52, lon: 13.4 }
  it('cardinal directions', () => {
    expect(bearingDeg(o, { lat: 52.53, lon: 13.4 })).toBeCloseTo(0, 5)
    expect(bearingDeg(o, { lat: 52.51, lon: 13.4 })).toBeCloseTo(180, 5)
    expect(bearingDeg(o, { lat: 52.52, lon: 13.41 })).toBeCloseTo(90, 1)
    expect(bearingDeg(o, { lat: 52.52, lon: 13.39 })).toBeCloseTo(270, 1)
  })
  it('always in 0..360', () => {
    for (let b = 0; b < 360; b += 17) {
      const r = bearingDeg(o, destination(o, b, 50))
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(360)
      expect(r).toBeCloseTo(b, 1)
    }
  })
  it('the step-free door is roughly west of the addressed door', () => {
    const b = bearingDeg(NOT_STEP_FREE, STEP_FREE)
    expect(b).toBeGreaterThan(240)
    expect(b).toBeLessThan(300)
  })
})

describe('relativeBearing', () => {
  it('signs: negative = turn left, positive = turn right', () => {
    expect(relativeBearing(90, 0)).toBe(90)
    expect(relativeBearing(0, 90)).toBe(-90)
  })
  it('wraps across north', () => {
    expect(relativeBearing(10, 350)).toBe(20)
    expect(relativeBearing(350, 10)).toBe(-20)
  })
  it('stays within -180..180', () => {
    expect(relativeBearing(180, 0)).toBe(180)
    for (let t = 0; t < 720; t += 13) {
      for (let h = -360; h < 720; h += 29) {
        const r = relativeBearing(t, h)
        expect(r).toBeGreaterThan(-180)
        expect(r).toBeLessThanOrEqual(180)
      }
    }
  })
})

describe('normalize360', () => {
  it('wraps', () => {
    expect(normalize360(0)).toBe(0)
    expect(normalize360(360)).toBe(0)
    expect(normalize360(-90)).toBe(270)
    expect(normalize360(725)).toBe(5)
    expect(Object.is(normalize360(-360), 0)).toBe(true)
  })
})
