import { describe, expect, it } from 'vitest'
import {
  arrowPulseHz,
  beaconFor,
  HAPTIC_ARRIVED,
  HAPTIC_LEFT,
  HAPTIC_RIGHT,
  hapticFor,
  shouldSpeakArrival,
} from '../src/core/beacon'

describe('beaconFor pulse (parking-sensor grammar)', () => {
  it('0.7 Hz at 60 m, 8 Hz at 2 m', () => {
    expect(beaconFor(60, 0).pulseHz).toBeCloseTo(0.7, 6)
    expect(beaconFor(2, 0).pulseHz).toBeCloseTo(8, 6)
  })
  it('clamps beyond the range', () => {
    expect(beaconFor(500, 0).pulseHz).toBeCloseTo(0.7, 6)
    expect(beaconFor(0, 0).pulseHz).toBeCloseTo(8, 6)
  })
  it('rises monotonically as distance falls', () => {
    let prev = 0
    for (let d = 60; d >= 2; d -= 1) {
      const p = beaconFor(d, 0).pulseHz
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })
  it('unknown distance is treated as far, not near', () => {
    expect(beaconFor(NaN, 0).pulseHz).toBeCloseTo(0.7, 6)
  })
})

describe('beaconFor pan', () => {
  it('-1 hard left .. +1 hard right, centred ahead', () => {
    expect(beaconFor(10, 0).panLR).toBe(0)
    expect(beaconFor(10, -90).panLR).toBe(-1)
    expect(beaconFor(10, 90).panLR).toBe(1)
    expect(beaconFor(10, -45).panLR).toBeCloseTo(-0.5, 6)
    expect(beaconFor(10, 30).panLR).toBeCloseTo(1 / 3, 6)
  })
  it('behind stays hard to the turning side instead of drifting back to centre', () => {
    expect(beaconFor(10, -170).panLR).toBe(-1)
    expect(beaconFor(10, 170).panLR).toBe(1)
  })
  it('never leaves -1..1', () => {
    for (let r = -180; r <= 180; r += 5) {
      const p = beaconFor(10, r).panLR
      expect(p).toBeGreaterThanOrEqual(-1)
      expect(p).toBeLessThanOrEqual(1)
    }
  })
})

describe('beaconFor pitch and volume', () => {
  it('660 Hz within +-15 degrees, 440 Hz otherwise', () => {
    expect(beaconFor(10, 0).pitchHz).toBe(660)
    expect(beaconFor(10, 15).pitchHz).toBe(660)
    expect(beaconFor(10, -15).pitchHz).toBe(660)
    expect(beaconFor(10, 15.1).pitchHz).toBe(440)
    expect(beaconFor(10, -90).pitchHz).toBe(440)
  })
  it('volume rises with proximity but stays secondary (never 0, never above 0.6)', () => {
    const far = beaconFor(60, 0).volume
    const near = beaconFor(2, 0).volume
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
    expect(near).toBeLessThanOrEqual(0.6)
  })
})

describe('cues', () => {
  it('arrow pulse rises continuously as the heading converges', () => {
    expect(arrowPulseHz(0)).toBeGreaterThan(arrowPulseHz(10))
    expect(arrowPulseHz(10)).toBeGreaterThan(arrowPulseHz(90))
    expect(arrowPulseHz(-45)).toBeCloseTo(arrowPulseHz(45), 9)
  })
  it('haptics: left two short, right three short, arrived one long', () => {
    expect(hapticFor(30, -60)).toBe(HAPTIC_LEFT)
    expect(hapticFor(30, 60)).toBe(HAPTIC_RIGHT)
    expect(hapticFor(2, 60)).toBe(HAPTIC_ARRIVED)
    expect(hapticFor(30, 5)).toBeNull()
    expect(HAPTIC_LEFT.filter((_, i) => i % 2 === 0)).toHaveLength(2)
    expect(HAPTIC_RIGHT.filter((_, i) => i % 2 === 0)).toHaveLength(3)
    expect(HAPTIC_ARRIVED).toHaveLength(1)
  })
  it('spoken arrival line fires 2.5 m before the 3 m arrival radius', () => {
    expect(shouldSpeakArrival(5.5)).toBe(true)
    expect(shouldSpeakArrival(5.6)).toBe(false)
    expect(shouldSpeakArrival(NaN)).toBe(false)
  })
})
