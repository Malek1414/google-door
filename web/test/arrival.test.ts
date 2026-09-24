import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { APPROACH_PIN_M, ARRIVE_JITTER_M, isArrived, nearTriggerShown, type TimedFix } from '../src/ui/LiveView'

const door = { lat: 52.52, lon: 13.405 }
const M_PER_DEG_LAT = 111_195
/** A fix `m` metres north of the door at time `t` ms. */
const north = (m: number, t: number): TimedFix => ({ lat: door.lat + m / M_PER_DEG_LAT, lon: door.lon, t })

describe('isArrived', () => {
  it('empty history is not arrived', () => {
    expect(isArrived([], door)).toBe(false)
  })
  it('one fix inside ARRIVE_M is arrived', () => {
    expect(isArrived([north(2.5, 0)], door)).toBe(true)
  })
  it('a single fix at 3.8 m is not enough', () => {
    expect(isArrived([north(3.8, 0)], door)).toBe(false)
  })
  it('two still fixes within 4 m count as arrived (GPS jitter)', () => {
    expect(isArrived([north(3.8, 0), north(3.6, 1000)], door)).toBe(true)
  })
  it('two fixes within 4 m while still walking do not count', () => {
    expect(isArrived([north(3.9, 0), north(3.1 + 0.5, 500)], door)).toBe(false) // 0.6 m/s
  })
  it('a still fix outside the jitter radius does not count', () => {
    expect(isArrived([north(ARRIVE_JITTER_M + 0.5, 0), north(3.9, 2000)], door)).toBe(false)
  })
  it('identical timestamps: only an unmoved repeat counts', () => {
    expect(isArrived([north(3.7, 5), north(3.7, 5)], door)).toBe(true)
    expect(isArrived([north(3.9, 5), north(3.5, 5)], door)).toBe(false)
  })
  it('only the last two fixes matter', () => {
    expect(isArrived([north(40, 0), north(3.8, 9000), north(3.7, 10000)], door)).toBe(true)
  })
  it('bad coordinates are not arrived', () => {
    expect(isArrived([{ lat: NaN, lon: NaN, t: 0 }], door)).toBe(false)
  })
})

describe('nearTriggerShown: "Zum Eingang führen" in the Live View panel', () => {
  it('appears from APPROACH_PIN_M in, long before GPS says arrived', () => {
    expect(nearTriggerShown(40, false)).toBe(false)
    expect(nearTriggerShown(APPROACH_PIN_M, false)).toBe(true)
    // 10 m out: GPS near buildings may never get to 3-4 m, the button must be there.
    expect(nearTriggerShown(10, false)).toBe(true)
  })
  it('does not flash on jitter at the edge (1.3x hysteresis)', () => {
    expect(nearTriggerShown(APPROACH_PIN_M + 5, true)).toBe(true)
    expect(nearTriggerShown(APPROACH_PIN_M * 1.3 + 1, true)).toBe(false)
  })
  it('an unknown distance keeps the current state', () => {
    expect(nearTriggerShown(NaN, true)).toBe(true)
    expect(nearTriggerShown(NaN, false)).toBe(false)
  })
  it('both triggers open the approach through one handler', () => {
    const src = readFileSync(resolve(__dirname, '../src/ui/LiveView.ts'), 'utf8')
    expect(src).toMatch(/nearBtn\?\.addEventListener\('click', startApproach\)/)
    expect(src).toMatch(/approachBtn\?\.addEventListener\('click', startApproach\)/)
  })
})
