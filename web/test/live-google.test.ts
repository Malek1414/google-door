// Google Live View look: the pure rules behind the arrow, the turn prompt, the door
// label, the mini map and the ETA bar.
import { describe, expect, it } from 'vitest'
import { doorLabelX, etaParts, shortDistance, shortName, sketchPath, tiltedDown, turnAroundShown } from '../src/ui/liveGoogle'

describe('Live View, Google look', () => {
  it('"Dreh dich um" from 120 degrees off, back to the arrow only below 105', () => {
    expect(turnAroundShown(119, false)).toBe(false)
    expect(turnAroundShown(-121, false)).toBe(true)
    expect(turnAroundShown(110, true)).toBe(true)
    expect(turnAroundShown(100, true)).toBe(false)
  })
  it('the door label shows only within 30 degrees, placed by bearing', () => {
    expect(doorLabelX(0)).toBe(0.5)
    expect(doorLabelX(-15)!).toBeLessThan(0.5)
    expect(doorLabelX(15)!).toBeGreaterThan(0.5)
    expect(doorLabelX(30)).toBeNull()
    expect(doorLabelX(NaN)).toBeNull()
  })
  it('the mini map comes up below 45 degrees and goes above 55; no data means upright', () => {
    expect(tiltedDown(null, false)).toBe(false)
    expect(tiltedDown(40, false)).toBe(true)
    expect(tiltedDown(50, true)).toBe(true)
    expect(tiltedDown(60, true)).toBe(false)
  })
  it('ETA bar: minutes and "340 m · Ankunft hh:mm"', () => {
    const e = etaParts(340, new Date(2026, 8, 24, 11, 0, 0))
    expect(e.min).toMatch(/^4 /)
    expect(e.sub).toMatch(/^340 m · \S+ 11:04$/)
    expect(shortDistance(1234)).toMatch(/^1[,.]2 km$/)
    expect(etaParts(NaN, new Date()).min).toBe('')
  })
  it('short door name and a sketch that starts at the user and ends at the door', () => {
    expect(shortName('Google Berlin, Haupteingang Tucholskystraße 2')).toBe('Google Berlin')
    const k = sketchPath({ lat: 52.5253, lon: 13.3912 }, [[52.524, 13.392]], { lat: 52.5231, lon: 13.3921 }, 360, 170)
    expect(k.d.startsWith('M')).toBe(true)
    for (const p of [k.me, k.door]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(360)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(170)
    }
    expect(k.door.y).toBeGreaterThan(k.me.y) // the door is south: lower on a north-up map
  })
})
