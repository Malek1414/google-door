import { describe, expect, it } from 'vitest'
import { distanceKey } from '../src/core/speech'

describe('speech clip selection', () => {
  it('snaps a distance to the nearest clip on the ladder', () => {
    expect(distanceKey(5)).toBe('dist_5')
    expect(distanceKey(31)).toBe('dist_30')
    expect(distanceKey(48)).toBe('dist_50')
    expect(distanceKey(97)).toBe('dist_100')
  })
  it('refuses to round a distance it would misstate', () => {
    expect(distanceKey(250)).toBeNull()   // nothing near 250 on the ladder
    expect(distanceKey(NaN)).toBeNull()
  })
  it('never claims a distance more than 12 m from the truth', () => {
    for (let m = 1; m <= 200; m++) {
      const k = distanceKey(m)
      if (k) expect(Math.abs(Number(k.slice(5)) - m)).toBeLessThanOrEqual(12)
    }
  })
})
