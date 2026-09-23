import { describe, expect, it } from 'vitest'
import { ARRIVE_JITTER_M, isArrived, type TimedFix } from '../src/ui/LiveView'

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
