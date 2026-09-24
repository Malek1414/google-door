import { describe, expect, it } from 'vitest'
import { isAccessibleDoor } from '../src/ui/ExploreFeed'
import type { Entrance } from '../src/core/types'

const door = (over: Partial<Entrance>): Entrance => ({
  id: 'd', buildingId: null, lat: 52.5, lon: 13.4, name: null, kind: 'main', level: 0, stepFree: true, tier: 1,
  confidence: 'surveyed', door: 'sliding', automatic: true, approachBearing: null, description: null, warnings: [], source: 'osm', ...over,
})

describe('"Barrierefreie Eingänge" only lists doors a wheelchair user can use', () => {
  it('keeps a confirmed step-free sliding door', () => expect(isAccessibleDoor(door({}))).toBe(true))
  it('drops doors with steps or unknown steps', () => {
    expect(isAccessibleDoor(door({ stepFree: false }))).toBe(false)
    expect(isAccessibleDoor(door({ stepFree: null }))).toBe(false)
  })
  it('drops revolving doors, by type or by warning', () => {
    expect(isAccessibleDoor(door({ door: 'revolving' }))).toBe(false)
    expect(isAccessibleDoor(door({ warnings: ['revolving'] }))).toBe(false)
  })
})
